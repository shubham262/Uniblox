import mongoose from "mongoose";
import { appConfig, ORDER_STATUS } from "../config/constants.js";

const isInteger = {
	validator: Number.isInteger,
	message: "{PATH} must be a whole number",
};

const orderItemSchema = new mongoose.Schema(
	{
		productId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "Product",
			required: true,
		},
		sku: { type: String, required: true },
		name: { type: String, required: true },
		unitPriceMinor: {
			type: Number,
			required: true,
			min: 0,
			validate: isInteger,
		},
		quantity: { type: Number, required: true, min: 1, validate: isInteger },
		lineTotalMinor: {
			type: Number,
			required: true,
			min: 0,
			validate: isInteger,
		},
	},
	{ _id: false }
);

const orderSchema = new mongoose.Schema(
	{
		cartId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "Cart",
			required: true,
			unique: true,
		},

		idempotencyKey: { type: String, required: true, unique: true, trim: true },

		items: {
			type: [orderItemSchema],
			required: true,
			validate: {
				validator: (items) => items.length > 0,
				message: "An order must contain at least one item",
			},
		},

		subtotalMinor: {
			type: Number,
			required: true,
			min: 0,
			validate: isInteger,
		},
		discountMinor: {
			type: Number,
			required: true,
			min: 0,
			default: 0,
			validate: isInteger,
		},

		totalMinor: { type: Number, required: true, min: 0, validate: isInteger },
		currency: { type: String, default: appConfig.currency },

		coupon: {
			type: new mongoose.Schema(
				{
					code: { type: String, required: true },
					discountPercent: { type: Number, required: true },
				},
				{ _id: false }
			),
			default: null,
		},
		couponId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "Coupon",
			default: null,
		},

		status: {
			type: String,
			enum: Object.values(ORDER_STATUS),
			default: ORDER_STATUS.PLACED,
			index: true,
		},
		placedAt: { type: Date, default: Date.now },
	},
	{ timestamps: true }
);

const Order = mongoose.model("Order", orderSchema);

export default Order;
