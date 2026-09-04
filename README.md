# Checkout and Rewards Service

Backend for an ecommerce store. Customers create carts, add products and check out. Every **nth** successfully placed order makes one **x% off** coupon available for an administrator to generate.

The API surface is small. The work is in making it behave predictably when requests are retried, when several customers check out at once, when stock runs low, and when two checkouts want the same coupon.

Design reasoning, ambiguities and trade-offs are in **[DECISIONS.md](DECISIONS.md)**.

---

## Requirements

- **Node.js ≥ 22** (uses the built-in `node:test` runner)
- **MongoDB** running on `127.0.0.1:27017` — a standalone `mongod` is fine, no replica set needed

```bash
brew services start mongodb-community   # macOS
```

No other services, accounts or credentials.

---

## Setup

```bash
cd backend
npm install
cp .env.example .env
npm run seed
npm run dev
```

The service listens on `http://localhost:3001`. Check it:

```bash
curl localhost:3001/api/health
```

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE` | `uniblox` | Mongo database name |
| `PORT` | `3001` | HTTP port |
| `COUPON_ORDER_INTERVAL` | `5` | **n** — orders per reward milestone |
| `COUPON_DISCOUNT_PERCENT` | `10` | **x** — discount percentage |
| `TEST_DATABASE` | `uniblox_test` | database used by `npm test` |

### Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | start with nodemon |
| `npm start` | start |
| `npm run seed` | **reset** products, carts, orders and coupons, then load seed data |
| `npm test` | run the test suite |

`npm run seed` wipes the whole domain, not just products — a reviewer wants a known starting state, and leftover orders would skew the coupon milestone count.

### Seed data

Six products, two deliberately scarce so concurrent checkouts have something to compete for.

| SKU | Product | Price | Stock |
| --- | --- | --- | --- |
| `MOUSE-WL-01` | Wireless Mouse | ₹1,299.00 | 50 |
| `KEYB-MECH-01` | Mechanical Keyboard | ₹4,499.50 | 25 |
| `STAND-LAP-01` | Aluminium Laptop Stand | ₹899.00 | 40 |
| `HUB-USBC-01` | 7-in-1 USB-C Hub | ₹2,199.00 | 12 |
| `MON-4K-27` | 27" 4K Monitor | ₹28,999.00 | **3** |
| `HEAD-ANC-01` | Noise Cancelling Headphones | ₹15,750.00 | **2** |

---

## Tests

```bash
npm test
```

36 tests across three files. They run against `TEST_DATABASE`, reseed before every test, and drop the database afterwards, so they never touch development data and do not depend on execution order.

```
tests/cart.test.js       10   validation, price and availability drift, concurrent adds
tests/checkout.test.js   15   idempotency, overselling, coupon races, rollback
tests/admin.test.js      11   milestone gating, concurrent generation, reconciliation
```

Set `SHOW_LOGS=1` to see service logs during a run — they are suppressed by default because most of these tests deliberately trigger failures.

The tests that matter are the overlapping ones:

| Scenario | Expected outcome |
| --- | --- |
| 5 simultaneous checkouts with **one** idempotency key | 1 order, stock charged once, none rejected |
| 5 buyers, 2 units in stock | 2 succeed, 3 refused, stock lands on 0 |
| multi-line checkout failing on the second product | first product's stock returned, no order |
| 4 simultaneous checkouts using one coupon | 1 discounted, 3 refused, coupon redeemed once |
| checkout failing *after* claiming a coupon | coupon returns to `available` |
| 6 administrators generating a coupon at once | exactly 1 coupon created |
| 10 simultaneous adds of the same product to one cart | quantity is exactly 10, in one line |

---

## Money

All amounts are integers in **minor units** (paise). `₹1,299.00` is stored and returned as `129900`. No floating point value is ever used in pricing arithmetic, so `1299.50 × 3` cannot drift.

Every money field appears twice: `subtotalMinor` (integer, authoritative) and `subtotal` (string, for display).

Discounts are `floor(subtotal × percent / 100)`, rounded **down**, and clamped so a total can never fall below zero.

---

## Error model

Failures share one envelope. Clients should branch on `code`, never on `message`.

```json
{
  "success": false,
  "code": "INVALID_QUANTITY",
  "message": "quantity must be a whole number of at least 1",
  "details": { "value": 0 }
}
```

Successes are always `{ "success": true, "data": { … } }`.

| Status | Meaning |
| --- | --- |
| 400 | malformed input |
| 404 | cart, product, order or coupon not found |
| 409 | conflict — already checked out, coupon taken, no eligible milestone |
| 422 | business rule failed — insufficient stock, empty cart |
| 500 | unexpected |

### Codes

| Code | Status | When |
| --- | --- | --- |
| `INVALID_ID` | 400 | id is not a valid ObjectId |
| `INVALID_QUANTITY` | 400 | quantity is missing, fractional, or below 1 |
| `INVALID_JSON` | 400 | request body is not valid JSON |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | checkout sent without the header |
| `CART_NOT_FOUND` | 404 | no such cart |
| `CART_ITEM_NOT_FOUND` | 404 | cart does not contain that product |
| `PRODUCT_NOT_FOUND` | 404 | no such product, or it is delisted |
| `ORDER_NOT_FOUND` | 404 | no such order |
| `COUPON_NOT_FOUND` | 404 | no such coupon code |
| `CART_ALREADY_CHECKED_OUT` | 409 | a **different** request already checked this cart out |
| `COUPON_NOT_AVAILABLE` | 409 | coupon is reserved by another checkout, or already redeemed |
| `NO_ELIGIBLE_MILESTONE` | 409 | no unrewarded milestone has been reached |
| `CART_EMPTY` | 422 | checkout of a cart with no items |
| `INSUFFICIENT_INVENTORY` | 422 | not enough stock |
| `PRODUCT_NO_LONGER_SOLD` | 422 | a product in the cart was delisted before checkout |
| `ROUTE_NOT_FOUND` | 404 | unknown route |
| `INTERNAL_ERROR` | 500 | unexpected |

---

## API

Base URL `http://localhost:3001/api`. All examples below are real responses from a seeded instance.

### `GET /health`

```json
{ "success": true,
  "data": { "status": "ok", "couponOrderInterval": 5, "couponDiscountPercent": 10 } }
```

### `GET /products`

Active products only. `200`.

```json
{
  "success": true,
  "data": { "products": [
    { "productId": "6a9a8d4d988e90ff3de1f465",
      "sku": "HUB-USBC-01",
      "name": "7-in-1 USB-C Hub",
      "unitPriceMinor": 219900,
      "unitPrice": "2199.00",
      "currency": "INR",
      "inventory": 12 }
  ] }
}
```

---

### `POST /carts`

Creates an empty cart. `201`.

```json
{ "success": true,
  "data": { "cartId": "6a9a8d5041197562e6202acf", "status": "active", "currency": "INR",
            "items": [], "itemCount": 0, "subtotalMinor": 0, "subtotal": "0.00",
            "hasIssues": false, "orderId": null } }
```

### `GET /carts/:cartId`

`200`. Prices are read from the products **at the moment of the request** — the cart never stores a price.

### `POST /carts/:cartId/items`

Adds a product, or **increases** the quantity if the line already exists. `200`.

```json
{ "productId": "6a9a8d4d988e90ff3de1f462", "quantity": 2 }
```

```json
{
  "success": true,
  "data": {
    "cartId": "6a9a8d5041197562e6202acf",
    "status": "active",
    "currency": "INR",
    "items": [
      { "productId": "6a9a8d4d988e90ff3de1f462",
        "sku": "MOUSE-WL-01",
        "name": "Wireless Mouse",
        "quantity": 2,
        "unitPriceMinor": 129900,
        "unitPrice": "1299.00",
        "lineTotalMinor": 259800,
        "lineTotal": "2598.00",
        "availableInventory": 50,
        "inStock": true }
    ],
    "itemCount": 2,
    "subtotalMinor": 259800,
    "subtotal": "2598.00",
    "hasIssues": false,
    "orderId": null
  }
}
```

Errors: `400 INVALID_QUANTITY`, `400 INVALID_ID`, `404 CART_NOT_FOUND`, `404 PRODUCT_NOT_FOUND`, `409 CART_ALREADY_CHECKED_OUT`, `422 INSUFFICIENT_INVENTORY`.

The stock check here is **advisory** — it stops obviously impossible quantities entering a cart, but stock is genuinely reserved only at checkout.

### `PATCH /carts/:cartId/items/:productId`

Sets an **absolute** quantity (unlike `POST`, which adds). `200`. `404 CART_ITEM_NOT_FOUND` if the product is not in the cart.

```json
{ "quantity": 3 }
```

### `DELETE /carts/:cartId/items/:productId`

Removes the line. `200`, or `404 CART_ITEM_NOT_FOUND`.

### When a product changes while it sits in a cart

| Change | What `GET /carts/:cartId` shows |
| --- | --- |
| price changed | the **new** price and a recalculated subtotal |
| stock now below cart quantity | `inStock: false`, `hasIssues: true` |
| product delisted | `unavailable: true`, `reason: "PRODUCT_NO_LONGER_SOLD"`, excluded from subtotal |

Nothing fails silently: the customer sees the change before checkout.

---

### `POST /carts/:cartId/checkout`

**Requires an `Idempotency-Key` header.** The client generates it and reuses it on retries.

```
Idempotency-Key: 1f9c1a3e-checkout-01
Content-Type: application/json

{ "couponCode": "SAVE10-37512F" }     ← optional
```

`201` when this request created the order, `200` when it replayed an existing one.

```json
{
  "success": true,
  "data": {
    "orderId": "6a9a8d5041197562e6202adb",
    "cartId": "6a9a8d5041197562e6202ada",
    "status": "placed",
    "currency": "INR",
    "items": [
      { "productId": "6a9a8d4d988e90ff3de1f462",
        "sku": "MOUSE-WL-01",
        "name": "Wireless Mouse",
        "quantity": 2,
        "unitPriceMinor": 129900,
        "unitPrice": "1299.00",
        "lineTotalMinor": 259800,
        "lineTotal": "2598.00" }
    ],
    "subtotalMinor": 259800, "subtotal": "2598.00",
    "discountMinor": 25980,  "discount": "259.80",
    "totalMinor": 233820,    "total": "2338.20",
    "coupon": { "code": "SAVE10-37512F", "discountPercent": 10 },
    "placedAt": "2026-09-04T09:20:16.438Z",
    "replayed": false
  }
}
```

The order lines are a **snapshot**. Renaming or repricing a product afterwards never changes a past order.

Errors: `400 IDEMPOTENCY_KEY_REQUIRED`, `404 CART_NOT_FOUND`, `404 COUPON_NOT_FOUND`, `409 CART_ALREADY_CHECKED_OUT`, `409 COUPON_NOT_AVAILABLE`, `422 CART_EMPTY`, `422 INSUFFICIENT_INVENTORY`, `422 PRODUCT_NO_LONGER_SOLD`.

**Retry semantics**

| Situation | Result |
| --- | --- |
| same key, sent again | `200`, the original order, `replayed: true` |
| same key, arriving simultaneously | one `201`, the rest `200` — one order, stock charged once |
| **different** key, same cart | `409 CART_ALREADY_CHECKED_OUT` |

A checkout that fails at any point releases everything it had taken: stock is returned and the coupon goes back to `available`.

### `GET /orders/:orderId`

`200`, or `404 ORDER_NOT_FOUND`.

---

## Administrative operations

Everything under `/api/admin` is administrative. Authentication is out of scope for this exercise, so these routes are namespaced rather than protected.

### `POST /admin/coupons`

Generates a coupon for the next unrewarded milestone. `201`.

```json
{ "success": true,
  "data": { "couponId": "6a9a8d5041197562e6202ad9",
            "code": "SAVE10-37512F",
            "discountPercent": 10,
            "status": "available",
            "milestoneIndex": 1,
            "milestoneOrderCount": 5,
            "orderId": null,
            "createdAt": "2026-09-04T09:20:16.429Z",
            "redeemedAt": null } }
```

`409 NO_ELIGIBLE_MILESTONE` when nothing is owed — the response says how far away the next one is:

```json
{ "success": false,
  "code": "NO_ELIGIBLE_MILESTONE",
  "message": "No unrewarded milestone has been reached yet",
  "details": { "totalOrders": 1, "couponOrderInterval": 5,
               "milestonesEarned": 0, "milestonesGenerated": 0,
               "ordersUntilNextMilestone": 4 } }
```

Coupons are **not** created automatically — reaching a milestone only makes one *eligible*. A backlog drains one coupon per request.

### `GET /admin/coupons`

Every coupon with its status, for reconciling against the report.

### `GET /admin/report`

`200`. A pure read — calling it repeatedly changes nothing.

```json
{
  "success": true,
  "data": {
    "orders": { "totalPlaced": 6 },
    "revenue": {
      "grossRevenueMinor": 1039200, "grossRevenue": "10392.00",
      "totalDiscountMinor": 25980,  "totalDiscount": "259.80",
      "netRevenueMinor": 1013220,   "netRevenue": "10132.20"
    },
    "itemsSold": [
      { "productId": "6a9a8d4d988e90ff3de1f462",
        "sku": "MOUSE-WL-01",
        "name": "Wireless Mouse",
        "quantitySold": 8,
        "grossRevenueMinor": 1039200,
        "grossRevenue": "10392.00" }
    ],
    "coupons": { "generated": 1, "available": 0, "reserved": 0, "redeemed": 1 },
    "rewards": {
      "couponOrderInterval": 5, "couponDiscountPercent": 10,
      "milestonesEarned": 1, "milestonesGenerated": 1,
      "isCouponAvailableToGenerate": false, "ordersUntilNextMilestone": 4
    },
    "reconciliation": {
      "netEqualsGrossMinusDiscounts": true,
      "lineItemsEqualGross": true,
      "couponsAccountedFor": true
    },
    "currency": "INR",
    "generatedAt": "2026-09-04T09:20:16.444Z"
  }
}
```

The `reconciliation` block self-checks the figures, so a broken number is visible in the response rather than only in a reviewer's spreadsheet. `couponsAccountedFor` verifies `generated == available + reserved + redeemed`.

---

## Try it end to end

```bash
npm run seed

API=http://localhost:3001/api
PRODUCT=$(curl -s $API/products | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['products'][0]['productId'])")
CART=$(curl -s -X POST $API/carts | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['cartId'])")

curl -s -X POST $API/carts/$CART/items \
  -H 'content-type: application/json' \
  -d "{\"productId\":\"$PRODUCT\",\"quantity\":2}"

# check out, then send the identical request again — one order, not two
curl -s -X POST $API/carts/$CART/checkout -H 'Idempotency-Key: demo-1'
curl -s -X POST $API/carts/$CART/checkout -H 'Idempotency-Key: demo-1'

curl -s $API/admin/report
```

Overselling, in one line — five buyers, two units in stock:

```bash
for i in 1 2 3 4 5; do
  C=$(curl -s -X POST $API/carts | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['cartId'])")
  H=$(curl -s $API/products | python3 -c "import sys,json;p=json.load(sys.stdin)['data']['products'];print([x['productId'] for x in p if x['sku']=='HEAD-ANC-01'][0])")
  curl -s -X POST $API/carts/$C/items -H 'content-type: application/json' -d "{\"productId\":\"$H\",\"quantity\":1}" > /dev/null
  curl -s -X POST $API/carts/$C/checkout -H "Idempotency-Key: race-$i" &
done; wait
```

Two succeed, three return `422 INSUFFICIENT_INVENTORY`, and stock lands on exactly `0`.

---

## Project structure

```
backend/
├── index.js              starts the server
├── app.js                express app (imported by tests too)
├── src/
│   ├── config/           mongo connection, constants, n and x
│   ├── models/           mongoose schemas and indexes
│   ├── routes/           express routers
│   ├── controllers/      input validation, HTTP status and shape
│   ├── service/          business logic and all database access
│   └── helper/           generic utilities (money, responses, validation)
└── tests/
```

Request flow is one directional: `routes → controllers → service → models`, with `helper/` available to any layer. `helper/` holds no domain rules and imports no models.

## How the invariants are enforced

| Invariant | Where |
| --- | --- |
| Inventory is never oversold | conditional `findOneAndUpdate` with `inventory: { $gte: qty }` in [`service/checkout.js`](backend/src/service/checkout.js) |
| A cart is checked out once | cart status check, plus a **unique index on `order.cartId`** |
| A retry never creates a second order | **unique index on `order.idempotencyKey`**, plus three lookup layers |
| A coupon is redeemed once | conditional status update `available → reserved → redeemed` |
| A failed checkout keeps the coupon | compensating release in the `catch` |
| One coupon per milestone | **unique index on `coupon.milestoneIndex`** |
| Orders are immutable | name and price copied onto the order line at checkout |
| Totals are never negative | discount clamped to the subtotal in [`helper/money.js`](backend/src/helper/money.js) |

Uniqueness constraints do the real work. Application checks give good error messages; the indexes make the rules impossible to break under concurrency.

## Known limitations

Recorded honestly rather than hidden — see [DECISIONS.md](DECISIONS.md) for the full reasoning.

- **No multi-document transactions.** Standalone MongoDB cannot provide them, so checkout reserves and compensates manually. If the process is killed between reserving stock and inserting the order, no rollback runs and that stock stays held. The fix is a sweeper for stale reservations, deferred.
- **Coupons stuck in `reserved`** have the same cause and the same fix. The report's `couponsAccountedFor` flag makes them visible.
- **No authentication.** Administrative routes are namespaced, not protected.
- **Single instance assumed.** All coordination is in the database, so a second instance would be correct — but see DECISIONS.md for what changes at scale.
