import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import Product from "../src/models/product.js";
import Order from "../src/models/order.js";
import Coupon from "../src/models/coupon.js";
import { startTestServer, stopTestServer, resetDatabase, api, apiWithoutBody, getProduct, createCartWith, uniqueKey } from "./setup.js";

before(startTestServer);
after(stopTestServer);
beforeEach(resetDatabase);

const stockOf = async (sku) => (await Product.findOne({ sku })).inventory;

const makeCoupon = async (code, discountPercent = 10, milestoneIndex = 1) =>
	await Coupon.create({ code, discountPercent, milestoneIndex, milestoneOrderCount: milestoneIndex * 5 });

describe("checkout basics", () => {
	test("places an order, snapshots the line, and charges inventory once", async () => {
		const { cartId } = await createCartWith("MOUSE-WL-01", 2);

		const { status, body } = await api("POST", `/carts/${cartId}/checkout`, { idempotencyKey: uniqueKey("ok") });

		assert.equal(status, 201);
		assert.equal(body.data.subtotal, "2598.00");
		assert.equal(body.data.discount, "0.00");
		assert.equal(body.data.total, "2598.00");
		assert.equal(body.data.items[0].name, "Wireless Mouse");
		assert.equal(body.data.items[0].unitPrice, "1299.00");
		assert.equal(await stockOf("MOUSE-WL-01"), 48);
	});

	test("requires an idempotency key", async () => {
		const { cartId } = await createCartWith("MOUSE-WL-01", 1);
		const { status, body } = await api("POST", `/carts/${cartId}/checkout`);

		assert.equal(status, 400);
		assert.equal(body.code, "IDEMPOTENCY_KEY_REQUIRED");
	});

	// A plain `curl -X POST` sends no content-type, so express.json() never runs
	// and req.body is undefined. This must not become a 500.
	test("checks out with no request body at all", async () => {
		const { cartId } = await createCartWith("MOUSE-WL-01", 1);

		const { status, body } = await apiWithoutBody("POST", `/carts/${cartId}/checkout`, {
			idempotencyKey: uniqueKey("nobody"),
		});

		assert.equal(status, 201);
		assert.equal(body.data.total, "1299.00");
	});

	test("reports a missing body as a validation error, never a crash", async () => {
		const { body: created } = await api("POST", "/carts");

		const { status, body } = await apiWithoutBody("POST", `/carts/${created.data.cartId}/items`);

		assert.equal(status, 400);
		assert.equal(body.code, "INVALID_ID");
	});

	test("refuses an empty cart", async () => {
		const { body: created } = await api("POST", "/carts");
		const { status, body } = await api("POST", `/carts/${created.data.cartId}/checkout`, {
			idempotencyKey: uniqueKey("empty"),
		});

		assert.equal(status, 422);
		assert.equal(body.code, "CART_EMPTY");
	});

	test("an order keeps its own prices when the product is later changed", async () => {
		const { cartId, product } = await createCartWith("MOUSE-WL-01", 1);
		const { body } = await api("POST", `/carts/${cartId}/checkout`, { idempotencyKey: uniqueKey("snap") });

		await Product.updateOne(
			{ _id: product.productId },
			{ $set: { unitPriceMinor: 999999, name: "Renamed Mouse", isActive: false } }
		);

		const { body: fetched } = await api("GET", `/orders/${body.data.orderId}`);
		assert.equal(fetched.data.items[0].name, "Wireless Mouse");
		assert.equal(fetched.data.items[0].unitPrice, "1299.00");
		assert.equal(fetched.data.total, "1299.00");
	});
});

describe("retries must not create a second order", () => {
	test("a repeated request with the same key replays the original order", async () => {
		const { cartId } = await createCartWith("MOUSE-WL-01", 1);
		const key = uniqueKey("retry");

		const first = await api("POST", `/carts/${cartId}/checkout`, { idempotencyKey: key });
		const second = await api("POST", `/carts/${cartId}/checkout`, { idempotencyKey: key });

		assert.equal(first.status, 201);
		assert.equal(first.body.data.replayed, false);
		assert.equal(second.status, 200);
		assert.equal(second.body.data.replayed, true);
		assert.equal(second.body.data.orderId, first.body.data.orderId);
		assert.equal(await stockOf("MOUSE-WL-01"), 49, "inventory must be charged once");
	});

	test("a different key on an already checked out cart is a conflict, not a replay", async () => {
		const { cartId } = await createCartWith("MOUSE-WL-01", 1);
		await api("POST", `/carts/${cartId}/checkout`, { idempotencyKey: uniqueKey("first") });

		const { status, body } = await api("POST", `/carts/${cartId}/checkout`, { idempotencyKey: uniqueKey("second") });

		assert.equal(status, 409);
		assert.equal(body.code, "CART_ALREADY_CHECKED_OUT");
		assert.equal(await stockOf("MOUSE-WL-01"), 49);
	});

	// This is the case that a naive implementation gets wrong: the requests
	// overlap, so none of them can see an existing order when they start.
	test("five simultaneous requests with one key create exactly one order", async () => {
		const { cartId } = await createCartWith("MOUSE-WL-01", 1);
		const key = uniqueKey("race");

		const results = await Promise.all(
			Array.from({ length: 5 }, () => api("POST", `/carts/${cartId}/checkout`, { idempotencyKey: key }))
		);

		const orderIds = new Set(results.map((result) => result.body.data?.orderId));
		assert.equal(orderIds.size, 1, "all responses must describe the same order");
		assert.equal(await Order.countDocuments({ idempotencyKey: key }), 1);
		assert.equal(await stockOf("MOUSE-WL-01"), 49, "inventory must be charged once");
		assert.ok(
			results.every((result) => result.status === 200 || result.status === 201),
			"a retry must never be rejected"
		);
	});
});

describe("concurrent checkouts must not oversell", () => {
	test("five buyers competing for two units: two succeed, three are refused", async () => {
		const carts = [];

		for (let i = 0; i < 5; i++) {
			carts.push((await createCartWith("HEAD-ANC-01", 1)).cartId);
		}

		const results = await Promise.all(
			carts.map((cartId) => api("POST", `/carts/${cartId}/checkout`, { idempotencyKey: uniqueKey("stock") }))
		);

		const placed = results.filter((result) => result.status === 201);
		const refused = results.filter((result) => result.body.code === "INSUFFICIENT_INVENTORY");

		assert.equal(placed.length, 2);
		assert.equal(refused.length, 3);
		assert.equal(await stockOf("HEAD-ANC-01"), 0, "inventory must land on zero, never below");
		assert.equal(await Order.countDocuments(), 2);
	});

	test("a multi-line checkout that fails on the second product returns the first product's stock", async () => {
		const monitor = await getProduct("MON-4K-27"); // 3 in stock
		const mouse = await getProduct("MOUSE-WL-01"); // 50 in stock
		const { body: created } = await api("POST", "/carts");
		const cartId = created.data.cartId;

		await api("POST", `/carts/${cartId}/items`, { body: { productId: mouse.productId, quantity: 2 } });
		await api("POST", `/carts/${cartId}/items`, { body: { productId: monitor.productId, quantity: 3 } });

		// Somebody else buys the monitors first.
		await Product.updateOne({ _id: monitor.productId }, { $set: { inventory: 0 } });

		const { status, body } = await api("POST", `/carts/${cartId}/checkout`, { idempotencyKey: uniqueKey("partial") });

		assert.equal(status, 422);
		assert.equal(body.code, "INSUFFICIENT_INVENTORY");
		assert.equal(await stockOf("MOUSE-WL-01"), 50, "the mice reserved before the failure must be returned");
		assert.equal(await Order.countDocuments(), 0);
	});
});

describe("coupons at checkout", () => {
	test("applies a percentage discount and never lets the total go negative", async () => {
		await makeCoupon("SAVE10");
		const { cartId } = await createCartWith("KEYB-MECH-01", 1); // 4499.50

		const { body } = await api("POST", `/carts/${cartId}/checkout`, {
			idempotencyKey: uniqueKey("coupon"),
			body: { couponCode: "SAVE10" },
		});

		assert.equal(body.data.subtotal, "4499.50");
		assert.equal(body.data.discount, "449.95");
		assert.equal(body.data.total, "4049.55");
		assert.ok(body.data.totalMinor >= 0);
	});

	test("a hundred percent coupon brings the total to zero, not below", async () => {
		await makeCoupon("FREE100", 100);
		const { cartId } = await createCartWith("MOUSE-WL-01", 1);

		const { body } = await api("POST", `/carts/${cartId}/checkout`, {
			idempotencyKey: uniqueKey("free"),
			body: { couponCode: "FREE100" },
		});

		assert.equal(body.data.total, "0.00");
		assert.equal(body.data.totalMinor, 0);
	});

	test("a coupon cannot be redeemed twice", async () => {
		await makeCoupon("ONCE10");
		const first = await createCartWith("MOUSE-WL-01", 1);
		await api("POST", `/carts/${first.cartId}/checkout`, {
			idempotencyKey: uniqueKey("once-a"),
			body: { couponCode: "ONCE10" },
		});

		const second = await createCartWith("MOUSE-WL-01", 1);
		const { status, body } = await api("POST", `/carts/${second.cartId}/checkout`, {
			idempotencyKey: uniqueKey("once-b"),
			body: { couponCode: "ONCE10" },
		});

		assert.equal(status, 409);
		assert.equal(body.code, "COUPON_NOT_AVAILABLE");
	});

	test("four simultaneous checkouts using one coupon: exactly one gets the discount", async () => {
		await makeCoupon("RACE10");
		const carts = [];

		for (let i = 0; i < 4; i++) {
			carts.push((await createCartWith("MOUSE-WL-01", 1)).cartId);
		}

		const results = await Promise.all(
			carts.map((cartId) =>
				api("POST", `/carts/${cartId}/checkout`, {
					idempotencyKey: uniqueKey("crace"),
					body: { couponCode: "RACE10" },
				})
			)
		);

		const discounted = results.filter((result) => result.status === 201 && result.body.data.discount !== "0.00");
		const blocked = results.filter((result) => result.body.code === "COUPON_NOT_AVAILABLE");

		assert.equal(discounted.length, 1);
		assert.equal(blocked.length, 3);

		const coupon = await Coupon.findOne({ code: "RACE10" });
		assert.equal(coupon.status, "redeemed");
		assert.equal(String(coupon.orderId), discounted[0].body.data.orderId);
	});

	test("a checkout that fails after claiming a coupon gives the coupon back", async () => {
		await makeCoupon("KEEP10");
		const { cartId, product } = await createCartWith("MON-4K-27", 3);

		await Product.updateOne({ _id: product.productId }, { $set: { inventory: 0 } });

		const { status, body } = await api("POST", `/carts/${cartId}/checkout`, {
			idempotencyKey: uniqueKey("keep"),
			body: { couponCode: "KEEP10" },
		});

		assert.equal(status, 422);
		assert.equal(body.code, "INSUFFICIENT_INVENTORY");

		const coupon = await Coupon.findOne({ code: "KEEP10" });
		assert.equal(coupon.status, "available", "a failed checkout must not consume the coupon");
		assert.equal(coupon.orderId, null);
		assert.equal(await Order.countDocuments(), 0);
	});

	test("an unknown coupon is rejected and leaves the cart usable", async () => {
		const { cartId } = await createCartWith("MOUSE-WL-01", 1);

		const rejected = await api("POST", `/carts/${cartId}/checkout`, {
			idempotencyKey: uniqueKey("bad"),
			body: { couponCode: "NOPE" },
		});
		assert.equal(rejected.status, 404);
		assert.equal(rejected.body.code, "COUPON_NOT_FOUND");
		assert.equal(await stockOf("MOUSE-WL-01"), 50, "stock reserved before the coupon check must be returned");

		const retried = await api("POST", `/carts/${cartId}/checkout`, { idempotencyKey: uniqueKey("bad-retry") });
		assert.equal(retried.status, 201);
	});
});
