import mongoose from "mongoose";
import { appConfig } from "../config/constants.js";

const isInteger = {
	validator: Number.isInteger,
	message: "{PATH} must be a whole number",
};

const productSchema = new mongoose.Schema(
	{
		sku: {
			type: String,
			required: true,
			unique: true,
			trim: true,
			uppercase: true,
		},
		name: { type: String, required: true, trim: true },

		unitPriceMinor: {
			type: Number,
			required: true,
			min: 0,
			validate: isInteger,
		},
		currency: { type: String, default: appConfig.currency },

		inventory: { type: Number, required: true, min: 0, validate: isInteger },

		isActive: { type: Boolean, default: true },
	},
	{ timestamps: true }
);

const Product = mongoose.model("Product", productSchema);

export default Product;
