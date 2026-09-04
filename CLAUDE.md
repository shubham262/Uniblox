# CLAUDE.md

## 1. Project overview

Backend for an ecommerce store: customers create carts, add products, and check out. Every **nth** successfully placed order makes one **x% off** coupon available, which an administrator generates and a customer may apply at checkout.

The interesting part is not the CRUD — it is behaving predictably when requests are **retried**, when **concurrent** checkouts compete for the last unit of stock or for the same coupon, and when product data changes between "add to cart" and "checkout".

Deliverables: a working service, meaningful tests (including concurrent/repeated requests), API documentation, and `DECISIONS.md`.

**We build this in stages.** Finish one stage, stop, let the user review and understand it, then move on. Do not run ahead.

---

## 2. Repository layout

```
/
├── CLAUDE.md               <- this file
├── DECISIONS.md            <- written incrementally as decisions are made
├── backend/
│   ├── index.js            <- express app bootstrap
│   ├── env.js              <- dotenv loader (used via --import)
│   ├── .env                <- DATABASE, PORT
│   └── src/
│       ├── config/         <- mongo connection, app constants
│       ├── models/         <- mongoose schemas only
│       ├── controllers/    <- request validation + HTTP response shape
│       ├── service/        <- business logic and db operations
│       ├── helper/         <- generic utilities (money, responses, validation)
│       └── routes/         <- express routers
└── frontend/
    └── src/
        ├── app/            <- next.js app router (thin route files)
        ├── views/          <- page-level composition
        ├── components/     <- reusable UI pieces
        ├── layouts/        <- shared layout shells
        └── service/        <- axios instance + API call functions
```

**Do not invent new top-level folders.** Everything goes into the folders above.

---

## 3. Tech stack

**Backend** — Node.js, Express 5, Mongoose 9, MongoDB. ESM only (`"type": "module"`), so use `import`/`export`, never `require`. Run with `npm run dev` (nodemon + `--import ./env.js`).

**Frontend** — Next.js 16 (App Router), React 19, JavaScript. **No TypeScript.**

Prefer these libraries over hand-rolling:

| Need | Use |
| --- | --- |
| UI components (table, form, modal, tag, message) | **antd** |
| Icons | **react-icons** |
| Dates and formatting | **moment** |
| HTTP calls | **axios** |
| Styling | **Tailwind CSS** |

---

## 4. Code style (hard rules)

**Arrow functions everywhere** — backend handlers, helpers, and React components alike.

```js
// backend
export const handleGetCart = async (req, res) => { ... };

// frontend component
const CartView = () => { ... };
export default CartView;
```

Never `function foo() {}`, never `class` components.

**Every async function has try/catch.** The catch logs with the function name, then returns a structured error. This matches the existing style in `backend/src/config/index.js`:

```js
export const handleCheckout = async (req, res) => {
	try {
		// ...
	} catch (error) {
		console.log("error==>handleCheckout", error);
		return res.status(500).json({ success: false, code: "INTERNAL_ERROR", message: "Something went wrong" });
	}
};
```

Keep the `console.log("error==>functionName", error)` format exactly — it makes logs greppable.

**Other rules**

- `async/await` only. No `.then()` chains, no callbacks.
- Named exports for controllers, helpers and models' methods. Default export for React components and Express routers.
- Tailwind for all styling. **Flexbox only — never CSS grid.** No `grid`, `grid-cols-*`, `col-span-*` classes.
- All frontend HTTP goes through the shared axios instance in `frontend/src/service/`. Components never import axios directly.
- `app/` route files stay thin — they render a view from `views/`.
- No comments explaining obvious code; comment only non-obvious invariants and concurrency reasoning.

---

## 5. Backend architecture

Request flow is strictly one direction:

```
routes  →  controllers  →  service  →  models
                  ↘  helper  ↙
```

- **routes/** — path + method + controller binding. No logic.
- **controllers/** — parse and validate input, call a service, map the result to an HTTP status + body. No direct Mongoose queries.
- **service/** — all business logic and database operations. This is where invariants are enforced.
- **helper/** — generic, reusable utilities only: money maths, response envelopes, id validation. **No domain rules and no model imports.** If it touches a model, it belongs in `service/`.
- **models/** — Mongoose schemas, indexes, and nothing else.

---

## 6. Domain invariants

These must hold at all times. Every change should be checked against this list.

1. **Inventory is never oversold.** Total units sold across all orders never exceeds seeded inventory.
2. **A cart is checked out at most once.** Checkout moves the cart to a terminal status; a second attempt is rejected.
3. **A retried checkout creates at most one order.** Same idempotency key ⇒ the original order is returned, inventory is not charged twice.
4. **A coupon is redeemed at most once**, and by exactly one order.
5. **A failed checkout never consumes a coupon.** If the order is not created, the coupon returns to `available`.
6. **One coupon per milestone.** Milestone *k* (order count `n*k`) can produce exactly one coupon, ever.
7. **Orders are immutable snapshots.** An order stores product name, unit price, quantity, line total, discount, and final total as they were at checkout — later product edits never change a past order.
8. **Money is integer minor units** (paise/cents). No floats anywhere in pricing math.
9. **Order total is never negative.** Discount is clamped to the order subtotal.
10. **Reports are read-only** and must reconcile exactly with the orders and coupons the API returns. Calling the report twice changes nothing.

---

## 7. Concurrency and idempotency

We target a **standalone MongoDB** (no replica set), so multi-document transactions are unavailable. Invariants are enforced with **atomic conditional updates and unique indexes** instead.

**Never read-then-write a contended document.** This is wrong:

```js
const product = await Product.findById(id);
if (product.inventory >= qty) {          // two requests can both pass here
	product.inventory -= qty;
	await product.save();
}
```

Do this instead — the condition and the write are one atomic operation:

```js
const updated = await Product.findOneAndUpdate(
	{ _id: id, inventory: { $gte: qty } },
	{ $inc: { inventory: -qty } },
	{ returnDocument: "after" } // mongoose 9 deprecated `new: true`
);
if (!updated) {
	// lost the race, or never had stock
	return { ok: false, code: "INSUFFICIENT_INVENTORY" };
}
```

**Unique indexes are the concurrency guard.** A duplicate-key error (code `11000`) is an expected outcome to handle, not a crash:

- unique index on the checkout **idempotency key** → a retry cannot create a second order
- unique index on **coupon code**
- unique index on **milestone index** → one coupon per milestone
- coupon redemption uses a conditional update on status, not a read-then-write

**Compensate on partial failure.** If three of four inventory decrements succeed and the fourth fails, `$inc` the successful ones back before returning the error. Same for a coupon reserved by a checkout that then fails.

---

## 8. Error model

Every response has a consistent envelope.

```js
// success
{ "success": true, "data": { ... } }

// failure
{ "success": false, "code": "INSUFFICIENT_INVENTORY", "message": "Only 2 units of Wireless Mouse remain", "details": { "productId": "...", "available": 2 } }
```

`code` is a stable machine-readable string — clients branch on it, never on `message`.

| Status | When |
| --- | --- |
| 400 | malformed or invalid input (bad quantity, unknown field) |
| 404 | cart, product, order or coupon not found |
| 409 | conflict — cart already checked out, coupon already redeemed, no eligible milestone |
| 422 | business rule failed — insufficient inventory, coupon expired/invalid |
| 500 | unexpected error |

---

## 9. Naming conventions

- Controllers: `handleX` — `handleCreateCart`, `handleCheckout` (matches the existing `handleMongoDBConnection`).
- Helpers: verb-first — `reserveInventory`, `releaseInventory`, `calculateCartTotals`.
- Variables and functions: `camelCase`. Models and React components: `PascalCase`.
- Route paths: lowercase kebab-case, plural nouns — `/api/carts/:cartId/items`.
- Error codes: `SCREAMING_SNAKE_CASE`.

---

## 10. Working agreement

- Build **one stage at a time** and stop for review. Do not create files the current stage does not need.
- Record every non-obvious semantic choice in `DECISIONS.md` as it is made (context → options → choice → why → consequences), not at the end.
- Admin operations (coupon generation, reporting) are clearly marked as administrative; auth is not implemented.
- The repo root is not yet a git repository — `git init` before the first commit. Commit in meaningful increments, one stage per commit or finer.
