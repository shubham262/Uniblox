import mongoose from "mongoose";
import { CART_STATUS } from "../config/constants.js";

const cartItemSchema = new mongoose.Schema(
	{
		productId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "Product",
			required: true,
		},
		quantity: {
			type: Number,
			required: true,
			min: 1,
			validate: {
				validator: Number.isInteger,
				message: "{PATH} must be a whole number",
			},
		},
	},
	{ _id: false }
);

const cartSchema = new mongoose.Schema(
	{
		status: {
			type: String,
			enum: Object.values(CART_STATUS),
			default: CART_STATUS.ACTIVE,
			index: true,
		},
		items: { type: [cartItemSchema], default: [] },
		orderId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "Order",
			default: null,
		},
		checkedOutAt: { type: Date, default: null },
	},
	{ timestamps: true }
);

const Cart = mongoose.model("Cart", cartSchema);

export default Cart;
