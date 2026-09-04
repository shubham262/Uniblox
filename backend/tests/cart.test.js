import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import Product from "../src/models/product.js";
import { startTestServer, stopTestServer, resetDatabase, api, getProduct, createCartWith } from "./setup.js";

before(startTestServer);
after(stopTestServer);
beforeEach(resetDatabase);

describe("cart validation", () => {
	test("rejects quantities that are not whole numbers of at least one", async () => {
		const { cartId, product } = await createCartWith("MOUSE-WL-01", 1);

		for (const quantity of [0, -1, 1.5, "two", null]) {
			const { status, body } = await api("POST", `/carts/${cartId}/items`, {
				body: { productId: product.productId, quantity },
			});

			assert.equal(status, 400, `quantity ${quantity} should be rejected`);
			assert.equal(body.code, "INVALID_QUANTITY");
		}
	});

	test("rejects unknown and malformed product ids", async () => {
		const { body } = await api("POST", "/carts");

		const malformed = await api("POST", `/carts/${body.data.cartId}/items`, {
			body: { productId: "not-an-id", quantity: 1 },
		});
		assert.equal(malformed.status, 400);
		assert.equal(malformed.body.code, "INVALID_ID");

		const unknown = await api("POST", `/carts/${body.data.cartId}/items`, {
			body: { productId: "64b7f0000000000000000000", quantity: 1 },
		});
		assert.equal(unknown.status, 404);
		assert.equal(unknown.body.code, "PRODUCT_NOT_FOUND");
	});

	test("will not accept more units than are in stock", async () => {
		const product = await getProduct("HEAD-ANC-01");
		const { body } = await api("POST", "/carts");

		const { status, body: error } = await api("POST", `/carts/${body.data.cartId}/items`, {
			body: { productId: product.productId, quantity: product.inventory + 1 },
		});

		assert.equal(status, 422);
		assert.equal(error.code, "INSUFFICIENT_INVENTORY");
		assert.equal(error.details.available, product.inventory);
	});

	test("reports a missing cart item distinctly from a missing cart", async () => {
		const { cartId } = await createCartWith("MOUSE-WL-01", 1);
		const other = await getProduct("HUB-USBC-01");

		const missingItem = await api("DELETE", `/carts/${cartId}/items/${other.productId}`);
		assert.equal(missingItem.status, 404);
		assert.equal(missingItem.body.code, "CART_ITEM_NOT_FOUND");

		const missingCart = await api("GET", "/carts/64b7f0000000000000000000");
		assert.equal(missingCart.status, 404);
		assert.equal(missingCart.body.code, "CART_NOT_FOUND");
	});
});

describe("cart totals", () => {
	test("adding the same product twice increments one line rather than duplicating it", async () => {
		const { cartId, product } = await createCartWith("MOUSE-WL-01", 2);
		await api("POST", `/carts/${cartId}/items`, { body: { productId: product.productId, quantity: 3 } });

		const { body } = await api("GET", `/carts/${cartId}`);
		assert.equal(body.data.items.length, 1);
		assert.equal(body.data.items[0].quantity, 5);
		assert.equal(body.data.subtotal, "6495.00"); // 5 x 1299.00
	});

	test("patch sets an absolute quantity and delete empties the cart", async () => {
		const { cartId, product } = await createCartWith("MOUSE-WL-01", 5);

		await api("PATCH", `/carts/${cartId}/items/${product.productId}`, { body: { quantity: 2 } });
		const patched = await api("GET", `/carts/${cartId}`);
		assert.equal(patched.body.data.subtotal, "2598.00");

		await api("DELETE", `/carts/${cartId}/items/${product.productId}`);
		const emptied = await api("GET", `/carts/${cartId}`);
		assert.deepEqual(emptied.body.data.items, []);
		assert.equal(emptied.body.data.subtotal, "0.00");
	});
});

describe("cart reacts to product changes made after an item was added", () => {
	test("a repriced product is charged at the new price, not the price when added", async () => {
		const { cartId, product } = await createCartWith("MOUSE-WL-01", 2);

		const before = await api("GET", `/carts/${cartId}`);
		assert.equal(before.body.data.subtotal, "2598.00");

		await Product.updateOne({ _id: product.productId }, { $set: { unitPriceMinor: 149900 } });

		const after = await api("GET", `/carts/${cartId}`);
		assert.equal(after.body.data.items[0].unitPrice, "1499.00");
		assert.equal(after.body.data.subtotal, "2998.00");
	});

	test("stock dropping below the cart quantity is flagged, not hidden", async () => {
		const { cartId, product } = await createCartWith("MOUSE-WL-01", 5);
		await Product.updateOne({ _id: product.productId }, { $set: { inventory: 1 } });

		const { body } = await api("GET", `/carts/${cartId}`);
		assert.equal(body.data.items[0].inStock, false);
		assert.equal(body.data.hasIssues, true);
	});

	test("a delisted product is marked unavailable and excluded from the subtotal", async () => {
		const { cartId, product } = await createCartWith("MOUSE-WL-01", 2);
		await Product.updateOne({ _id: product.productId }, { $set: { isActive: false } });

		const { body } = await api("GET", `/carts/${cartId}`);
		assert.equal(body.data.items[0].unavailable, true);
		assert.equal(body.data.items[0].reason, "PRODUCT_NO_LONGER_SOLD");
		assert.equal(body.data.subtotal, "0.00");
		assert.equal(body.data.hasIssues, true);
	});
});

describe("concurrent cart writes", () => {
	// A read-modify-write would lose updates here; the push/increment pair is
	// applied by mongo as a single atomic operation, so none are lost.
	test("ten simultaneous adds of one unit produce a quantity of exactly ten", async () => {
		const product = await getProduct("MOUSE-WL-01");
		const { body } = await api("POST", "/carts");
		const cartId = body.data.cartId;

		await Promise.all(
			Array.from({ length: 10 }, () =>
				api("POST", `/carts/${cartId}/items`, { body: { productId: product.productId, quantity: 1 } })
			)
		);

		const { body: cart } = await api("GET", `/carts/${cartId}`);
		assert.equal(cart.data.items.length, 1);
		assert.equal(cart.data.items[0].quantity, 10);
	});
});
