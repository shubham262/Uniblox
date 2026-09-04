import mongoose from "mongoose";
import { COUPON_STATUS } from "../config/constants.js";

const couponSchema = new mongoose.Schema(
	{
		code: {
			type: String,
			required: true,
			unique: true,
			trim: true,
			uppercase: true,
		},

		discountPercent: {
			type: Number,
			required: true,
			min: 1,
			max: 100,
			validate: {
				validator: Number.isInteger,
				message: "{PATH} must be a whole number",
			},
		},

		milestoneIndex: { type: Number, required: true, unique: true, min: 1 },
		milestoneOrderCount: { type: Number, required: true, min: 1 },

		status: {
			type: String,
			enum: Object.values(COUPON_STATUS),
			default: COUPON_STATUS.AVAILABLE,
			index: true,
		},

		reservedForCartId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "Cart",
			default: null,
		},
		reservedAt: { type: Date, default: null },

		orderId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "Order",
			default: null,
		},
		redeemedAt: { type: Date, default: null },
	},
	{ timestamps: true }
);

const Coupon = mongoose.model("Coupon", couponSchema);

export default Coupon;
