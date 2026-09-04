import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import Coupon from "../src/models/coupon.js";
import { appConfig } from "../src/config/constants.js";
import { startTestServer, stopTestServer, resetDatabase, api, createCartWith, uniqueKey } from "./setup.js";

before(startTestServer);
after(stopTestServer);
beforeEach(resetDatabase);

const placeOrders = async (count, sku = "MOUSE-WL-01") => {
	for (let i = 0; i < count; i++) {
		const { cartId } = await createCartWith(sku, 1);
		await api("POST", `/carts/${cartId}/checkout`, { idempotencyKey: uniqueKey("seed-order") });
	}
};

describe("coupon generation is gated on the order milestone", () => {
	test("refuses before the milestone and says how far away it is", async () => {
		const { status, body } = await api("POST", "/admin/coupons");

		assert.equal(status, 409);
		assert.equal(body.code, "NO_ELIGIBLE_MILESTONE");
		assert.equal(body.details.ordersUntilNextMilestone, appConfig.couponOrderInterval);
	});

	test("still refuses one order short of the milestone", async () => {
		await placeOrders(appConfig.couponOrderInterval - 1);
		const { status } = await api("POST", "/admin/coupons");

		assert.equal(status, 409);
	});

	test("issues one coupon once the milestone is reached, and only one", async () => {
		await placeOrders(appConfig.couponOrderInterval);

		const first = await api("POST", "/admin/coupons");
		assert.equal(first.status, 201);
		assert.equal(first.body.data.milestoneIndex, 1);
		assert.equal(first.body.data.milestoneOrderCount, appConfig.couponOrderInterval);
		assert.equal(first.body.data.discountPercent, appConfig.couponDiscountPercent);
		assert.equal(first.body.data.status, "available");

		const second = await api("POST", "/admin/coupons");
		assert.equal(second.status, 409, "the same milestone must not be rewarded twice");
		assert.equal(await Coupon.countDocuments(), 1);
	});

	test("a backlog of milestones is drained one coupon per request", async () => {
		await placeOrders(appConfig.couponOrderInterval * 3);

		const results = [];
		for (let i = 0; i < 4; i++) {
			results.push(await api("POST", "/admin/coupons"));
		}

		assert.deepEqual(
			results.map((result) => result.status),
			[201, 201, 201, 409]
		);

		const { body } = await api("GET", "/admin/coupons");
		assert.deepEqual(
			body.data.coupons.map((coupon) => coupon.milestoneIndex),
			[1, 2, 3]
		);
	});

	// Two administrators pressing the button at the same moment.
	test("six simultaneous requests for one earned milestone create one coupon", async () => {
		await placeOrders(appConfig.couponOrderInterval);

		const results = await Promise.all(Array.from({ length: 6 }, () => api("POST", "/admin/coupons")));
		const created = results.filter((result) => result.status === 201);

		assert.equal(created.length, 1);
		assert.equal(await Coupon.countDocuments(), 1);
	});

	test("concurrent requests for two earned milestones create two, without gaps or repeats", async () => {
		await placeOrders(appConfig.couponOrderInterval * 2);

		const results = await Promise.all(Array.from({ length: 6 }, () => api("POST", "/admin/coupons")));
		const created = results.filter((result) => result.status === 201);

		assert.equal(created.length, 2);

		const coupons = await Coupon.find().sort({ milestoneIndex: 1 });
		assert.deepEqual(
			coupons.map((coupon) => coupon.milestoneIndex),
			[1, 2]
		);
	});
});

describe("the administrative report", () => {
	test("is a pure read: calling it repeatedly changes nothing", async () => {
		await placeOrders(3);

		const first = await api("GET", "/admin/report");
		const second = await api("GET", "/admin/report");
		const third = await api("GET", "/admin/report");

		assert.deepEqual(first.body.data.orders, second.body.data.orders);
		assert.deepEqual(first.body.data.revenue, third.body.data.revenue);
		assert.deepEqual(first.body.data.itemsSold, third.body.data.itemsSold);
	});

	test("reconciles gross, discounts and net after a coupon is redeemed", async () => {
		await placeOrders(5); // 5 x 1299.00 = 6495.00

		const { body: generated } = await api("POST", "/admin/coupons");
		const { cartId } = await createCartWith("MOUSE-WL-01", 2); // 2598.00, less 10% = 2338.20
		await api("POST", `/carts/${cartId}/checkout`, {
			idempotencyKey: uniqueKey("report"),
			body: { couponCode: generated.data.code },
		});

		const { body } = await api("GET", "/admin/report");
		const report = body.data;

		assert.equal(report.orders.totalPlaced, 6);
		assert.equal(report.revenue.grossRevenue, "9093.00"); // 6495.00 + 2598.00
		assert.equal(report.revenue.totalDiscount, "259.80");
		assert.equal(report.revenue.netRevenue, "8833.20");
		assert.equal(
			report.revenue.netRevenueMinor,
			report.revenue.grossRevenueMinor - report.revenue.totalDiscountMinor
		);

		assert.equal(report.reconciliation.netEqualsGrossMinusDiscounts, true);
		assert.equal(report.reconciliation.lineItemsEqualGross, true);
		assert.equal(report.reconciliation.couponsAccountedFor, true);
	});

	test("counts purchased quantity per product", async () => {
		await placeOrders(2, "MOUSE-WL-01");
		await placeOrders(1, "HUB-USBC-01");

		const { body } = await api("GET", "/admin/report");
		const bySku = Object.fromEntries(body.data.itemsSold.map((row) => [row.sku, row.quantitySold]));

		assert.equal(bySku["MOUSE-WL-01"], 2);
		assert.equal(bySku["HUB-USBC-01"], 1);
	});

	test("coupon counts agree with the coupon list", async () => {
		await placeOrders(10);
		await api("POST", "/admin/coupons");
		const { body: second } = await api("POST", "/admin/coupons");

		const { cartId } = await createCartWith("MOUSE-WL-01", 1);
		await api("POST", `/carts/${cartId}/checkout`, {
			idempotencyKey: uniqueKey("redeem"),
			body: { couponCode: second.data.code },
		});

		const { body: reportBody } = await api("GET", "/admin/report");
		const { body: couponBody } = await api("GET", "/admin/coupons");

		assert.equal(reportBody.data.coupons.generated, couponBody.data.coupons.length);
		assert.equal(reportBody.data.coupons.generated, 2);
		assert.equal(reportBody.data.coupons.available, 1);
		assert.equal(reportBody.data.coupons.redeemed, 1);
		assert.equal(
			reportBody.data.coupons.generated,
			reportBody.data.coupons.available + reportBody.data.coupons.reserved + reportBody.data.coupons.redeemed
		);
	});

	test("a failed checkout leaves no trace in the report", async () => {
		await placeOrders(2);
		const before = await api("GET", "/admin/report");

		const { cartId } = await createCartWith("HEAD-ANC-01", 5); // only 2 in stock
		const failed = await api("POST", `/carts/${cartId}/checkout`, { idempotencyKey: uniqueKey("nope") });
		assert.notEqual(failed.status, 201);

		const after = await api("GET", "/admin/report");
		assert.deepEqual(after.body.data.orders, before.body.data.orders);
		assert.deepEqual(after.body.data.revenue, before.body.data.revenue);
	});
});
