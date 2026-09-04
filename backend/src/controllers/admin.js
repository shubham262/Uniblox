import { sendSuccess, handleControllerError } from "../helper/response.js";
import { generateCoupon, listCoupons, buildCouponView } from "../service/coupon.js";
import { buildReport } from "../service/report.js";

export const handleGenerateCoupon = async (req, res) => {
	try {
		const coupon = await generateCoupon();
		return sendSuccess(res, 201, buildCouponView(coupon));
	} catch (error) {
		return handleControllerError(res, "handleGenerateCoupon", error);
	}
};

export const handleListCoupons = async (req, res) => {
	try {
		const coupons = await listCoupons();
		return sendSuccess(res, 200, { coupons });
	} catch (error) {
		return handleControllerError(res, "handleListCoupons", error);
	}
};

export const handleGetReport = async (req, res) => {
	try {
		const report = await buildReport();
		return sendSuccess(res, 200, report);
	} catch (error) {
		return handleControllerError(res, "handleGetReport", error);
	}
};
