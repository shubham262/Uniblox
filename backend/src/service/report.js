import Order from "../models/order.js";
import { appConfig } from "../config/constants.js";
import { toMajor } from "../helper/money.js";
import { countCouponsByStatus, getMilestoneStatus } from "./coupon.js";

// Every figure is derived from the orders and coupons themselves, so the report
// is a pure read. Calling it twice changes nothing.
export const buildReport = async () => {
	try {
		const [totals] = await Order.aggregate([
			{
				$group: {
					_id: null,
					orderCount: { $sum: 1 },
					grossRevenueMinor: { $sum: "$subtotalMinor" },
					totalDiscountMinor: { $sum: "$discountMinor" },
					netRevenueMinor: { $sum: "$totalMinor" },
				},
			},
		]);

		const itemsByProduct = await Order.aggregate([
			{ $unwind: "$items" },
			{
				$group: {
					_id: "$items.productId",
					sku: { $first: "$items.sku" },
					name: { $first: "$items.name" },
					quantitySold: { $sum: "$items.quantity" },
					grossRevenueMinor: { $sum: "$items.lineTotalMinor" },
				},
			},
			{ $sort: { name: 1 } },
		]);

		const gross = totals ? totals.grossRevenueMinor : 0;
		const discounts = totals ? totals.totalDiscountMinor : 0;
		const net = totals ? totals.netRevenueMinor : 0;

		const coupons = await countCouponsByStatus();
		const milestone = await getMilestoneStatus();

		return {
			orders: {
				totalPlaced: totals ? totals.orderCount : 0,
			},
			revenue: {
				grossRevenueMinor: gross,
				grossRevenue: toMajor(gross),
				totalDiscountMinor: discounts,
				totalDiscount: toMajor(discounts),
				netRevenueMinor: net,
				netRevenue: toMajor(net),
			},
			itemsSold: itemsByProduct.map((row) => ({
				productId: row._id,
				sku: row.sku,
				name: row.name,
				quantitySold: row.quantitySold,
				grossRevenueMinor: row.grossRevenueMinor,
				grossRevenue: toMajor(row.grossRevenueMinor),
			})),
			coupons,
			rewards: {
				couponOrderInterval: appConfig.couponOrderInterval,
				couponDiscountPercent: appConfig.couponDiscountPercent,
				milestonesEarned: milestone.milestonesEarned,
				milestonesGenerated: milestone.milestonesGenerated,
				isCouponAvailableToGenerate: milestone.isEligible,
				ordersUntilNextMilestone: Math.max(milestone.ordersUntilNextMilestone, 0),
			},
			// Self-check so a broken figure is visible in the response itself rather
			// than only in a reviewer's spreadsheet.
			reconciliation: {
				netEqualsGrossMinusDiscounts: net === gross - discounts,
				lineItemsEqualGross: itemsByProduct.reduce((sum, row) => sum + row.grossRevenueMinor, 0) === gross,
				couponsAccountedFor: coupons.generated === coupons.available + coupons.reserved + coupons.redeemed,
			},
			currency: appConfig.currency,
			generatedAt: new Date(),
		};
	} catch (error) {
		console.log("error==>buildReport", error);
		throw error;
	}
};
