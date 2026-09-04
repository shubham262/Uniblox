import { randomBytes } from "crypto";
import Coupon from "../models/coupon.js";
import Order from "../models/order.js";
import { appConfig, COUPON_STATUS } from "../config/constants.js";
import { appError } from "../helper/response.js";

export const normaliseCode = (code) => String(code || "").trim().toUpperCase();

export const buildCouponView = (coupon) => ({
	couponId: coupon._id,
	code: coupon.code,
	discountPercent: coupon.discountPercent,
	status: coupon.status,
	milestoneIndex: coupon.milestoneIndex,
	milestoneOrderCount: coupon.milestoneOrderCount,
	orderId: coupon.orderId,
	createdAt: coupon.createdAt,
	redeemedAt: coupon.redeemedAt,
});

const buildCouponCode = (discountPercent) => `SAVE${discountPercent}-${randomBytes(3).toString("hex").toUpperCase()}`;

// How many rewards the store has earned, and which one is next in line. The
// milestone itself is never stored: it is derived from the order count, so it
// cannot drift out of step with the orders it is based on.
export const getMilestoneStatus = async () => {
	try {
		const [totalOrders, lastCoupon] = await Promise.all([
			Order.countDocuments(),
			Coupon.findOne().sort({ milestoneIndex: -1 }),
		]);

		const milestonesEarned = Math.floor(totalOrders / appConfig.couponOrderInterval);
		const milestonesGenerated = lastCoupon ? lastCoupon.milestoneIndex : 0;

		return {
			totalOrders,
			milestonesEarned,
			milestonesGenerated,
			nextMilestoneIndex: milestonesGenerated + 1,
			isEligible: milestonesGenerated < milestonesEarned,
			ordersUntilNextMilestone: (milestonesGenerated + 1) * appConfig.couponOrderInterval - totalOrders,
		};
	} catch (error) {
		console.log("error==>getMilestoneStatus", error);
		throw error;
	}
};

// Administrative. Two admins clicking at once both compute the same next
// milestone; the unique index lets one through and the loser recomputes rather
// than issuing a duplicate reward.
export const generateCoupon = async () => {
	try {
		for (let attempt = 0; attempt < 5; attempt++) {
			const milestone = await getMilestoneStatus();

			if (!milestone.isEligible) {
				throw appError(409, "NO_ELIGIBLE_MILESTONE", "No unrewarded milestone has been reached yet", {
					totalOrders: milestone.totalOrders,
					couponOrderInterval: appConfig.couponOrderInterval,
					milestonesEarned: milestone.milestonesEarned,
					milestonesGenerated: milestone.milestonesGenerated,
					ordersUntilNextMilestone: milestone.ordersUntilNextMilestone,
				});
			}

			try {
				const coupon = await Coupon.create({
					code: buildCouponCode(appConfig.couponDiscountPercent),
					discountPercent: appConfig.couponDiscountPercent,
					milestoneIndex: milestone.nextMilestoneIndex,
					milestoneOrderCount: milestone.nextMilestoneIndex * appConfig.couponOrderInterval,
				});

				return coupon;
			} catch (error) {
				// Lost the race on milestoneIndex, or drew a colliding code. Either
				// way, recompute and try the next one.
				if (error.code === 11000) {
					continue;
				}

				throw error;
			}
		}

		throw appError(409, "COUPON_GENERATION_CONFLICT", "Could not generate a coupon, please retry");
	} catch (error) {
		console.log("error==>generateCoupon", error);
		throw error;
	}
};

export const listCoupons = async () => {
	try {
		const coupons = await Coupon.find().sort({ milestoneIndex: 1 });
		return coupons.map(buildCouponView);
	} catch (error) {
		console.log("error==>listCoupons", error);
		throw error;
	}
};

export const countCouponsByStatus = async () => {
	try {
		const rows = await Coupon.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]);
		const byStatus = Object.fromEntries(rows.map((row) => [row._id, row.count]));

		return {
			generated: Object.values(byStatus).reduce((total, count) => total + count, 0),
			available: byStatus[COUPON_STATUS.AVAILABLE] || 0,
			reserved: byStatus[COUPON_STATUS.RESERVED] || 0,
			redeemed: byStatus[COUPON_STATUS.REDEEMED] || 0,
		};
	} catch (error) {
		console.log("error==>countCouponsByStatus", error);
		throw error;
	}
};

// available -> reserved. The status sits in the filter, so if two checkouts race
// only one gets a document back; the other gets null and is told to go away.
export const reserveCoupon = async (code, cartId) => {
	try {
		const couponCode = normaliseCode(code);

		const claimed = await Coupon.findOneAndUpdate(
			{ code: couponCode, status: COUPON_STATUS.AVAILABLE },
			{ $set: { status: COUPON_STATUS.RESERVED, reservedForCartId: cartId, reservedAt: new Date() } },
			{ returnDocument: "after" }
		);

		if (claimed) {
			return claimed;
		}

		// Nothing claimed: either the code is wrong, or someone else holds it.
		const existing = await Coupon.findOne({ code: couponCode });

		if (!existing) {
			throw appError(404, "COUPON_NOT_FOUND", "Coupon does not exist", { code: couponCode });
		}

		throw appError(409, "COUPON_NOT_AVAILABLE", `Coupon is already ${existing.status}`, {
			code: couponCode,
			status: existing.status,
		});
	} catch (error) {
		console.log("error==>reserveCoupon", error);
		throw error;
	}
};

// reserved -> redeemed, once the order actually exists.
export const redeemCoupon = async (couponId, orderId) => {
	try {
		const redeemed = await Coupon.findOneAndUpdate(
			{ _id: couponId, status: COUPON_STATUS.RESERVED },
			{ $set: { status: COUPON_STATUS.REDEEMED, orderId, redeemedAt: new Date() } },
			{ returnDocument: "after" }
		);

		return redeemed;
	} catch (error) {
		console.log("error==>redeemCoupon", error);
		throw error;
	}
};

// reserved -> available, when the checkout holding it failed. Only ever undoes
// our own reservation: a coupon already redeemed is left alone.
export const releaseCoupon = async (couponId) => {
	try {
		await Coupon.updateOne(
			{ _id: couponId, status: COUPON_STATUS.RESERVED },
			{ $set: { status: COUPON_STATUS.AVAILABLE, reservedForCartId: null, reservedAt: null } }
		);
	} catch (error) {
		console.log("error==>releaseCoupon", error);
	}
};
