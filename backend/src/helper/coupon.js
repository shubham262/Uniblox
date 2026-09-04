import Coupon from "../models/coupon.js";
import { COUPON_STATUS } from "../config/constants.js";
import { appError } from "./response.js";

export const normaliseCode = (code) => String(code || "").trim().toUpperCase();

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
