import Product from "../models/product.js";
import { appError } from "./response.js";
import { toMajor } from "./money.js";

export const buildProductView = (product) => ({
	productId: product._id,
	sku: product.sku,
	name: product.name,
	unitPriceMinor: product.unitPriceMinor,
	unitPrice: toMajor(product.unitPriceMinor),
	currency: product.currency,
	inventory: product.inventory,
});

export const listActiveProducts = async () => {
	try {
		const products = await Product.find({ isActive: true }).sort({ name: 1 });
		return products.map(buildProductView);
	} catch (error) {
		console.log("error==>listActiveProducts", error);
		throw error;
	}
};

export const findActiveProduct = async (productId) => {
	try {
		const product = await Product.findOne({ _id: productId, isActive: true });

		if (!product) {
			throw appError(404, "PRODUCT_NOT_FOUND", "Product does not exist or is no longer sold", { productId });
		}

		return product;
	} catch (error) {
		console.log("error==>findActiveProduct", error);
		throw error;
	}
};
