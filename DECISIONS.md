# Decisions

Reasoning behind the checkout and rewards service: the invariants I set out to protect, the ambiguities I had to resolve, what I chose and why, and what I knowingly left undone.

**Approximate time spent: ~6 hours.**

---

## 1. System invariants

These are the properties that must hold no matter how requests interleave. Everything else in this document exists to serve them.

| # | Invariant | Enforced by |
| --- | --- | --- |
| 1 | Inventory is never oversold; stock never goes negative | conditional update `{ inventory: { $gte: qty } }` + `$inc` in [`service/checkout.js`](backend/src/service/checkout.js) |
| 2 | A cart is checked out at most once | cart status check **and** a unique index on `order.cartId` |
| 3 | A retried checkout creates at most one order | unique index on `order.idempotencyKey` + three lookup layers |
| 4 | A coupon is redeemed at most once, by exactly one order | conditional status transition, never a read-then-write |
| 5 | A failed checkout consumes neither stock nor coupon | compensating release in the `catch` block |
| 6 | One coupon per milestone, ever | unique index on `coupon.milestoneIndex` |
| 7 | An order explains itself forever | product name and price copied onto the order line |
| 8 | Money is exact | integer minor units everywhere; no float in pricing arithmetic |
| 9 | An order total is never negative | discount floored and clamped to the subtotal |
| 10 | Reports reconcile and never mutate | pure aggregation reads, plus a self-check block in the response |

The pattern throughout: **application checks produce good error messages; database constraints make the rule unbreakable.** Where the two disagree, the constraint wins, and the code is written to expect that.

---

## 2. Ambiguities found, and the semantics I chose

The brief deliberately leaves gaps. These are the ones I hit and how I resolved them.

| Ambiguity | Choice | Reasoning |
| --- | --- | --- |
| Who does a coupon belong to? | **Nobody — it is a store-wide pool.** | The reward triggers on "every nth order" with no customer identity anywhere, and auth is explicitly out of scope. There is no principal to attach a reward to. |
| Does the customer who hits the milestone get the coupon? | No. Whoever applies it first gets it. | Follows from the above. Called out because it is unusual and a reviewer will notice. |
| Can a coupon be used more than once? | No, single use. | Stated three times in the brief, and the "two concurrent checkouts" requirement only exists because of it. |
| One coupon per order, or several? | **One.** | Stacking needs an ordering rule (sequential vs. additive percentages) that the brief does not specify, and multiplies the failure modes without exercising a new invariant. |
| What does the discount apply to? | The **order subtotal**, not per line, not shipping. | Simplest defensible reading; keeps the arithmetic auditable on the order document. |
| Rounding direction? | **Floor** the discount. | Never gives away more than the stated percentage, and makes the total trivially non-negative. |
| Price changes between add-to-cart and checkout? | The **current** price always wins. | See Decision 2. |
| A product is delisted while in a cart? | The line is flagged `unavailable` and excluded from the subtotal; checkout refuses with `PRODUCT_NO_LONGER_SOLD`. | Never fail silently, never charge for something we cannot sell. |
| What if `n` changes on a live store? | Existing coupons keep their recorded `milestoneOrderCount`; future milestones use the new `n`. | `n` is configuration, not a runtime knob. Recording the count at generation time means past rewards stay explicable. |
| Do coupons expire? | **No.** | Deferred deliberately — see §8. |
| Does `POST /items` add or replace? | **Adds** to the existing quantity. `PATCH` sets an absolute quantity. | Matches how "add to cart" behaves in every real store, and gives clients both operations. |
| Is the cart-time stock check binding? | **Advisory only.** | Stock can change in the seconds before checkout, so a binding check would be a lie. Real reservation happens once, at checkout. |
| Which operations are administrative? | Everything under `/api/admin`. | Namespaced, not protected — auth is out of scope. |

---

## Decision: Money as integer minor units

**Context.** Prices, line totals, discounts and order totals all need arithmetic that is exact and auditable. A single mis-rounded paisa multiplied across orders makes the report irreconcilable.

**Options considered.**
1. JavaScript floats (`1299.50`).
2. A decimal library such as `decimal.js` or Mongo's `Decimal128`.
3. Integer minor units (paise) everywhere.

**Choice.** Option 3. `₹1,299.00` is stored and transmitted as `129900`.

**Why.** Floats fail immediately: `1299.50 * 3` is `3898.4999999999995`, which rounds to a total that is a paisa short. A decimal library solves that but adds a dependency, serialisation questions, and a type that has to be unwrapped at every boundary. Integers need no library, compare and sum natively, index cleanly, and are exactly what payment providers use on the wire.

**Consequences.** Every money field is duplicated in responses — `subtotalMinor` (integer, authoritative) and `subtotal` (string, display) — so clients never do their own division. Schema validators reject non-integers, so a float cannot enter the system through a bad seed or migration. Rounding happens in exactly one place, [`helper/money.js`](backend/src/helper/money.js). The cost is that every developer must remember the unit; the `Minor` suffix on every field name is the mitigation.

---

## Decision: The cart stores no prices

**Context.** The brief explicitly asks what happens when a product's price or availability changes after an item is added but before checkout.

**Options considered.**
1. Snapshot the price when the item is added and honour it at checkout.
2. Snapshot with an expiry, re-pricing after some TTL.
3. Store only `productId` and `quantity`; resolve price at read and at checkout.

**Choice.** Option 3. A cart line is `{ productId, quantity }` and nothing else.

**Why.** Option 1 means the store can be forced to sell at a stale price indefinitely — leave a cart open for a month and the old price is still binding. It also requires an invalidation story for every price change. Option 2 needs a TTL policy the brief does not specify and produces the confusing behaviour of a cart silently repricing itself mid-session. Option 3 makes the cart what it actually is: a shopping list, not a quote. It also removes a whole class of bug, because there is no cached value that can go stale.

**Consequences.** `GET /carts/:id` always reflects today's prices, so a customer can see a total change between visits. This is made visible rather than hidden: each line carries `inStock` and `availableInventory`, delisted products are marked `unavailable` with a reason and excluded from the subtotal, and the cart carries a `hasIssues` flag. A real store would want a "price changed since you added this" banner, which this data supports but the API does not explicitly model. Covered by three tests in `cart.test.js`.

---

## Decision: Orders are immutable snapshots, not references

**Context.** An order must explain what was bought and how the total was reached, even after the catalogue changes.

**Options considered.**
1. Store `productId` and join to the product at read time.
2. Store `productId` plus a version pointer to a historical price record.
3. Copy `sku`, `name`, `unitPriceMinor`, `quantity` and `lineTotalMinor` onto the order line.

**Choice.** Option 3, and the same for the coupon: the order stores `{ code, discountPercent }`, not just a reference.

**Why.** Option 1 rewrites history — rename a product and every past receipt changes; reprice it and old orders display totals that do not match what was charged. Option 2 is correct but introduces price-history tables and effective-dating for no benefit at this scale. Option 3 makes the order self-contained: `subtotal − discount = total` is verifiable from the document alone, with no joins and no trust in another collection.

**Consequences.** Order data is denormalised and product data is duplicated. That is the point — it is a financial record, not a view. `productId` is retained for analytics such as units-sold-per-product, never for display. A test deliberately renames, reprices and delists a product after checkout and asserts the order is unchanged.

---

## Decision: Compensating actions instead of transactions

**Context.** A checkout mutates four things that must all succeed or all be undone: product inventory, the coupon, the order, and the cart. The target deployment is a standalone `mongod`, which cannot run multi-document transactions.

**Options considered.**
1. Require a MongoDB replica set and use `session.withTransaction()`.
2. Standalone MongoDB with atomic conditional updates plus explicit compensation.
3. Embedded SQLite (`node:sqlite`) with `BEGIN IMMEDIATE` — real ACID transactions.

**Choice.** Option 2.

**Why.** Option 1 makes correctness nearly free but forces the reviewer to configure a single-node replica set before anything runs, which works against "repeatable setup instructions". Option 3 is genuinely attractive and I evaluated it seriously — it would delete the compensation code and close both crash windows described in §8, and `CHECK (inventory >= 0)` is a stronger statement of an invariant than any application code. I rejected it on two grounds: `node:sqlite` is still experimental, and migrating mid-build would have consumed the remaining budget re-implementing already-verified behaviour at the cost of the tests and this document. **If I were starting again, I would start on SQL.** That is a real conclusion, not a hedge.

**Consequences.** Checkout reserves stock item by item, tracks what it took, and returns all of it on any failure. The `catch` block is the safety net, and it always does the same two things: release inventory, release the coupon. The cost is a genuine crash window — see §8. Ordering matters and is deliberate: stock is reserved before the coupon is claimed, so the common failure (out of stock) never touches a coupon at all.

---

## Decision: Client-supplied idempotency key, enforced in three layers

**Context.** Clients retry when they time out. A retry must not create a second order or charge inventory twice — including when the retry arrives while the original is still in flight.

**Options considered.**
1. Deduplicate on cart id alone.
2. Server-generated token issued by a "begin checkout" call.
3. Client-supplied `Idempotency-Key` header, unique-indexed on the order.

**Choice.** Option 3, mandatory. A checkout without the header is rejected with `400 IDEMPOTENCY_KEY_REQUIRED`.

**Why.** Option 1 cannot distinguish a retry from a genuine second attempt, and both deserve different answers. Option 2 adds a round trip and its own state to expire. Option 3 is the industry convention (Stripe et al.), needs no extra state, and lets the database do the deduplication.

**How it actually works.** Three independent layers, each covering a different timing window:

1. **Fast path** — an order already exists for the key, so return it.
2. **Cart closed mid-flight** — the request passed layer 1, then a racing winner created the order and closed the cart. `findActiveCart` reports `CART_ALREADY_CHECKED_OUT`; before treating that as a conflict, we look up the key again and replay if it is ours.
3. **Duplicate key on insert** — two requests reached `Order.create` together. The loser catches `11000`, releases what it reserved, and returns the winner's order.

`409 CART_ALREADY_CHECKED_OUT` is reserved for a **different** key against an already-ordered cart, which is a real conflict rather than a retry.

**Consequences.** Clients must generate keys. Verified by mutation testing: removing any single layer keeps the suite green, removing two makes sequential retries fail, removing the third makes the concurrent race fail. The layers are not redundant — each owns a window.

---

## Decision: A coupon has three states, not a boolean

**Context.** "A coupon must not be lost or consumed by a checkout that ultimately fails."

**Options considered.**
1. `isRedeemed: true/false`, flipped at the end of a successful checkout.
2. `isRedeemed`, flipped at the start and reverted on failure.
3. `available → reserved → redeemed`, with `reserved → available` on failure.

**Choice.** Option 3.

**Why.** Option 1 leaves a window where two concurrent checkouts both see `false` and both proceed, and only one can win — but by then both have reserved stock. Option 2 fixes the race but cannot express "someone is currently holding this", so a failure that happens between two other attempts is ambiguous. Option 3 makes the intermediate state explicit and lets the claim be a single atomic conditional update:

```js
Coupon.findOneAndUpdate(
  { code, status: "available" },     // the guard is in the filter
  { $set: { status: "reserved", reservedForCartId, reservedAt } }
)
```

A `null` result means somebody else holds it. No locks, no read-then-write.

**Consequences.** The release path is a conditional update too, so it can only undo *our own* reservation and never touches a coupon that has since been redeemed. `reserved` also becomes a visible failure signal: the report's `couponsAccountedFor` check surfaces any coupon stranded in that state. The cost is the stuck-reservation risk in §8.

---

## Decision: A unique index on `order.cartId` as a second lock

**Context.** "A cart must not be checked out more than once." The obvious implementation checks `cart.status === "active"` and proceeds.

**Options considered.**
1. Status check only.
2. Status check plus a conditional status flip that acts as a lock.
3. Status check plus a unique index on `order.cartId`.

**Choice.** Option 3.

**Why.** The status check and the order insert are two separate operations, so two requests can both read `active` before either writes. Option 2 works but makes the cart's status field do double duty as a mutex, and the failure mode (cart flipped, order not created) needs its own recovery. Option 3 puts the constraint on the thing that must be unique — the order — and cannot be raced past.

**Consequences.** Two independent guards on one rule. The status check is the fast, friendly path with a helpful message; the index is the backstop. Because a duplicate can violate `cartId` and `idempotencyKey` simultaneously, the recovery code deliberately does **not** inspect which index fired — see §9.

---

## Decision: Coupon generation is admin-triggered and derived, not stored

**Context.** Milestones must be rewarded once each, and only once reached.

**Options considered.**
1. Generate automatically inside checkout when the order count hits a multiple of `n`.
2. Maintain a counter document tracking milestones and coupons issued.
3. Derive the milestone from `countDocuments()` on demand; create only on an admin request; make `milestoneIndex` unique.

**Choice.** Option 3.

**Why.** Option 1 contradicts "an administrator can request coupon generation", and worse, it adds a write to the checkout hot path that could fail *after* the order commits or run twice under a retry. The reward has nothing to do with that customer's purchase and does not belong in their transaction. Option 2 introduces a counter that can drift out of step with the orders it describes. Option 3 keeps a single source of truth: the orders themselves. The milestone is a derived number, so it cannot disagree with reality.

**Consequences.** A backlog drains one coupon per request, which is predictable and easy to explain. Concurrent generation is safe: both requests compute the same next milestone, one wins the unique index, and the loser recomputes and either takes the next milestone or gets a clean `409`. The next index comes from `max(milestoneIndex) + 1` rather than a count, so a deleted coupon cannot cause a collision or a skipped reward. `countDocuments()` on every request is fine at this scale and would need revisiting at millions of orders.

---

## Decision: A fake payment step, not a skipped one

**Context.** No real payment integration is required.

**Options considered.**
1. Treat a successful checkout as payment success and write no payment code.
2. A small `chargePayment` abstraction that always succeeds but is a real step with a real failure path.
3. A full gateway abstraction with providers, webhooks and reconciliation.

**Choice.** Option 2.

**Why.** Option 1 hides the most interesting question: what happens when the charge fails *after* stock has been reserved? Without a step there, the compensation logic has no reason to exist and the design silently assumes payment cannot fail. Option 3 is disproportionate. Option 2 costs about fifteen lines and forces the ordering decision — reserve, claim, charge, then create the order — to be made explicitly.

**Consequences.** There is one obvious place to drop a real gateway, and the unwind path around it already works. Asynchronous settlement (a provider that returns "pending") is not modelled and would need a payment state on the order.

---

## 3. Transactions, concurrency and idempotency strategy

**No multi-document transactions.** Every invariant is enforced by an atomic single-document operation or a unique index.

**Never read-then-write on contended data.** The condition goes inside the query so the check and the write are one operation:

```js
Product.findOneAndUpdate(
  { _id, isActive: true, inventory: { $gte: qty } },
  { $inc: { inventory: -qty } },
  { returnDocument: "after" }
)
```

`null` means we lost the race. The same shape claims coupons and flips their status.

**Unique indexes are the concurrency mechanism.** `order.idempotencyKey`, `order.cartId`, `coupon.milestoneIndex`, `coupon.code`, `product.sku`. A duplicate-key error (`11000`) is an expected outcome with a defined handler, not a crash.

**Checkout order of operations,** chosen so the cheapest and most likely failure happens first:

```
1  look up the idempotency key            → replay if found
2  validate cart is active and not empty  → recover if a race closed it
3  price the lines from live products     (no writes yet)
4  reserve inventory, item by item        ← tracks what it took
5  claim the coupon                       available → reserved
6  charge payment
7  create the order                       ← unique indexes are the final gate
8  close the cart, redeem the coupon      reserved → redeemed
```

Steps 4–8 sit in one `try`. The `catch` always releases the reserved inventory and the claimed coupon, then decides whether the failure was a retry (replay) or a conflict (`409`).

**Cart mutations are atomic too.** Adding an item is a push-if-absent followed by an `$inc`-if-present, never a read-modify-write, so ten simultaneous adds produce a quantity of exactly ten in one line.

---

## 4. Money and rounding rules

- All amounts are integers in minor units. No float ever participates in pricing arithmetic.
- Rounding happens in exactly one function: `discountMinor(subtotal, percent) = min(floor(subtotal × percent / 100), subtotal)`.
- **Floor**, so the discount never exceeds the advertised percentage.
- **Clamped** to the subtotal, so invariant 9 holds even at 100% — tested explicitly, the total lands on `0`, never below.
- Line total is `unitPriceMinor × quantity`; the subtotal is their sum. Both are integers, so both are exact.
- Responses carry both representations: `discountMinor: 25980` and `discount: "259.80"`.
- Currency is a single configured value (`INR`). Multi-currency would need per-product currency and an exchange-rate policy; out of scope.

---

## 5. Error model

Every failure shares one envelope, and clients branch on `code`, never on `message`:

```json
{ "success": false, "code": "INSUFFICIENT_INVENTORY",
  "message": "Not enough stock for 27\" 4K Monitor",
  "details": { "productId": "…", "requested": 3, "available": 1 } }
```

**Choices made.**

- **Stable string codes rather than numeric ones.** Readable in logs and greppable; no registry to maintain.
- **400 vs 422 is a real distinction.** `400` means the request is malformed (a fractional quantity). `422` means the request is well-formed but the world says no (not enough stock). A client can retry a `422` later; retrying a `400` unchanged is pointless.
- **409 is reserved for genuine conflicts** — a cart already checked out by a different request, a coupon someone else holds, a milestone already rewarded. Notably, a *retry* is never a `409`.
- **`details` carries actionable data.** `INSUFFICIENT_INVENTORY` says how many remain; `NO_ELIGIBLE_MILESTONE` says how many more orders are needed. A refusal that explains itself is worth more than one that does not.
- **Business failures are thrown, not returned.** Services throw an error carrying `status`, `code` and `details`; one controller helper turns it into a response. This keeps the happy path free of branching, and anything unrecognised becomes a `500` rather than leaking a stack trace.
- **`replayed: true`** on a checkout response tells a client its retry was absorbed rather than reprocessed. `201` means created, `200` means replayed.

---

## 6. What is implemented

- Products with inventory; six seeded, two deliberately scarce.
- Full cart lifecycle with validation, live pricing, and drift detection.
- Checkout with mandatory idempotency, atomic reservation, compensation, optional coupon, and a fake payment step.
- Coupon lifecycle: milestone-gated generation, single-use redemption, release on failure.
- Admin coupon generation, coupon listing, and a reconciling report with a self-check block.
- 38 automated tests including seven genuinely concurrent scenarios.
- Consistent error envelope with 17 distinct codes.

---

## 7. Testing approach

38 tests over three files, using the built-in `node:test` runner — no test dependency. They run against a separate database, reseed before each test, and drop it afterwards.

The tests that carry the weight are the overlapping ones: five simultaneous checkouts sharing one idempotency key, five buyers competing for two units, four checkouts competing for one coupon, six administrators generating a coupon at once, ten simultaneous adds to one cart.

**I verified the suite can actually fail.** A green suite proves nothing unless it goes red when the code is wrong, so I deliberately broke five invariants:

| Sabotage | Tests failed |
| --- | --- |
| Remove `inventory: { $gte: qty }` from the reservation | 3 |
| Let a coupon be claimed regardless of status | 2 |
| Remove the idempotency fast path | 0 |
| Remove the fast path **and** the checked-out recovery | 2 |
| Remove only the duplicate-key resolver | 1 |

The zero was informative rather than a gap: it proved the three idempotency layers are genuinely independent, and rows 4 and 5 show which window each one owns.

---

## 8. Intentionally deferred

Named honestly, with the fix, rather than hidden.

**Stranded reservations after a hard crash.** If the process dies between reserving inventory (step 4) and creating the order (step 7), nothing runs the compensation and that stock stays held for an order that never existed. Coupons stuck in `reserved` are the same bug. This is the direct cost of not having transactions. **Fix:** a periodic sweep releasing reservations older than a short timeout, plus a `reservedAt` check when claiming:

```js
Coupon.updateMany(
  { status: "reserved", orderId: null, reservedAt: { $lt: twoMinutesAgo } },
  { $set: { status: "available", reservedForCartId: null, reservedAt: null } }
)
```

Inventory needs a reservation record to make the same sweep possible, which is the larger part of the work. The report's `couponsAccountedFor` flag at least makes the coupon half visible.

**No coupon expiry.** Coupons are valid indefinitely. Adding `expiresAt` and checking it in the claim filter is straightforward; it was a deliberate scope decision, not an oversight.

**No authentication or authorisation.** Explicitly out of scope. Admin routes are namespaced, not protected.

**No pagination or rate limiting.** `GET /admin/coupons` and the report return everything.

**No structured logging.** `console.log` with a consistent `error==>functionName` prefix. Adequate for a take-home, inadequate for production.

**No frontend.** Optional per the brief, and it would not have compensated for missing any of the above.

**Report aggregations are unbounded.** They scan all orders on every call. Correct, and fine at this scale — see §10.

---

## 9. How I used AI, and where I corrected it

I used Claude throughout, as a fast implementer and a sounding board, and I treated everything it produced as a proposal to be verified rather than an answer. The workflow that mattered was: agree the invariant first, let AI write the implementation, then **attack it with concurrent and repeated requests** and see whether it survived. Most of the bugs below were found that way, not by reading the code.

**The correction that mattered most.** The first implementation of duplicate-key handling inspected which index MongoDB reported and branched on it:

```js
const conflictingFields = Object.keys(error.keyPattern || {});
if (conflictingFields.includes("idempotencyKey")) {
  return await Order.findOne({ idempotencyKey });   // a retry → replay
}
throw appError(409, "CART_ALREADY_CHECKED_OUT");    // a second checkout → conflict
```

This reads plausibly and passed a first concurrency test. It is wrong. When a request violates **both** unique indexes at once — same cart *and* same idempotency key, which is exactly what a concurrent retry does — MongoDB reports only one of them, and it reports `cartId`. So legitimate retries were rejected with `409`.

It hid well. A single five-way race passed by luck; only running the race six times in a row exposed it as four of five requests failing every time. The fix was to delete the cleverness and ask the database the question I actually cared about:

```js
const order = await Order.findOne({ idempotencyKey });
if (order) return order;                          // it is ours → replay
throw appError(409, "CART_ALREADY_CHECKED_OUT");  // someone else's → conflict
```

Shorter, and correct regardless of which index fired. The lesson I took from it: **do not infer intent from an error's shape when you can ask the authoritative question directly.**

**Two others worth recording.**

- A `$pull` that removed nothing still reported `modifiedCount: 1`, so deleting a cart item that was not there returned `200` instead of `404`. Cause: `timestamps: true` bumps `updatedAt` on every update, so `modifiedCount` is meaningless on any timestamped model. Fixed by moving the condition into the filter and checking `matchedCount`.
- Writing the README's curl examples produced a `500`. Express 5 no longer defaults `req.body` to `{}`, so a request without a JSON content-type left it `undefined` and `req.body.couponCode` threw. **All 36 tests passed straight through this** because my test client always set the header. Fixed once as middleware, and two regression tests added. This is the clearest evidence in the project that a self-consistent test suite can share a blind spot with the code it tests.

I also rejected AI-suggested directions: an early plan to hand-roll a discount-stacking rule the brief never asked for, and a mid-build proposal to migrate to SQLite, which I evaluated properly (§4) and declined on timing grounds while recording it as the better starting point.

---

## 10. Scaling: multiple instances and production

**Multiple instances of this service work today, unchanged.** Nothing is held in process memory — no locks, no caches, no in-flight state. Every invariant is enforced by MongoDB, so a second instance competes on exactly the same conditional updates and unique indexes as a second concurrent request within one instance. That was the point of pushing coordination into the database rather than into application code.

What would need to change as load grows:

**Stale-reservation sweeping becomes mandatory,** not optional. With more instances, process death is routine rather than exceptional. This needs a leader or a lock so that only one instance sweeps.

**Report aggregations need to stop scanning everything.** They are `O(orders)` on every call. The fix is incrementally maintained daily rollups, with the live aggregation kept as the reconciliation check against them.

**`countDocuments()` for milestones becomes expensive.** At millions of orders, replace it with a monotonic counter incremented atomically at order creation. The unique `milestoneIndex` remains the correctness guarantee either way; the counter is only an optimisation.

**Hot-document contention on scarce products.** Every buyer of the last few units updates one document, and MongoDB serialises those writes. For a flash sale this becomes the bottleneck; the usual answer is to shard inventory into buckets per product and reserve from any bucket with stock.

**With a production relational database** — the direction I would take, per §4 — the design gets simpler rather than more complex. Checkout collapses into one transaction, compensation disappears, and the invariants become declarative:

```sql
inventory   INTEGER NOT NULL CHECK (inventory >= 0)
total_minor INTEGER NOT NULL CHECK (total_minor >= 0)
CHECK (total_minor = subtotal_minor - discount_minor)
UNIQUE (cart_id), UNIQUE (idempotency_key), UNIQUE (milestone_index)
PRIMARY KEY (cart_id, product_id)   -- duplicate cart lines become impossible
```

The unique constraints map across unchanged. Row-level locking (`SELECT … FOR UPDATE`) replaces conditional updates, and the crash window in §8 closes by construction.

**Also needed for production:** authentication and an admin role, idempotency-key expiry so the collection does not grow without bound, structured logging with request ids, metrics on oversell attempts and coupon contention, and a real payment integration with asynchronous settlement.

---

## 11. What I would examine first with another two hours

1. **The stranded-reservation window** (§8). It is the only known way this system can reach an inconsistent state, and it is the thing I would least like a reviewer to find before I mentioned it. An inventory reservation record plus a sweeper, in that order.
2. **A test that kills the process mid-checkout** and asserts what is left behind. I have reasoned about this window but not proven its behaviour, and everything else in this project was verified rather than assumed. Reasoning I have not tested is the weakest claim in the submission.
3. **Fault injection around the compensation path.** Every rollback is currently exercised by a *natural* failure. I would force `releaseInventory` itself to fail and see what survives — the `catch` swallows errors there, which is deliberate but untested.
4. **Concurrency at higher volume.** The races run with four to six competitors. I would push to hundreds against a single scarce product and confirm the sum of orders always equals the stock consumed.
5. **The `GET /carts/:id` N+1 shape.** It issues one extra query per cart read. Fine now, worth measuring before it matters.

Beyond that, the SQLite migration from §4 — not because the current design is wrong, but because I now believe the constraint-based version would be the better artefact.
