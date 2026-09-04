import Cart from "../models/cart.js";
import Product from "../models/product.js";
import { appConfig, CART_STATUS } from "../config/constants.js";
import { appError } from "../helper/response.js";
import { toMajor, lineTotalMinor, sumMinor } from "../helper/money.js";
import { findActiveProduct } from "./product.js";

export const createCart = async () => {
	try {
		const cart = await Cart.create({});
		return cart;
	} catch (error) {
		console.log("error==>createCart", error);
		throw error;
	}
};

export const findCart = async (cartId) => {
	try {
		const cart = await Cart.findById(cartId);

		if (!cart) {
			throw appError(404, "CART_NOT_FOUND", "Cart does not exist", { cartId });
		}

		return cart;
	} catch (error) {
		console.log("error==>findCart", error);
		throw error;
	}
};

// Items can only change while the cart is active. Checkout makes it terminal.
export const findActiveCart = async (cartId) => {
	try {
		const cart = await findCart(cartId);

		if (cart.status !== CART_STATUS.ACTIVE) {
			throw appError(409, "CART_ALREADY_CHECKED_OUT", "Cart has already been checked out and cannot be changed", {
				cartId,
				orderId: cart.orderId,
			});
		}

		return cart;
	} catch (error) {
		console.log("error==>findActiveCart", error);
		throw error;
	}
};

// Prices are read from the product every time. The cart never stores a price,
// so a repriced product is reflected the moment the cart is viewed.
export const buildCartView = async (cart) => {
	try {
		const productIds = cart.items.map((item) => item.productId);
		const products = await Product.find({ _id: { $in: productIds }, isActive: true });
		const productById = new Map(products.map((product) => [String(product._id), product]));

		const items = cart.items.map((item) => {
			const product = productById.get(String(item.productId));

			if (!product) {
				return {
					productId: item.productId,
					quantity: item.quantity,
					unavailable: true,
					reason: "PRODUCT_NO_LONGER_SOLD",
				};
			}

			const lineTotal = lineTotalMinor(product.unitPriceMinor, item.quantity);

			return {
				productId: product._id,
				sku: product.sku,
				name: product.name,
				quantity: item.quantity,
				unitPriceMinor: product.unitPriceMinor,
				unitPrice: toMajor(product.unitPriceMinor),
				lineTotalMinor: lineTotal,
				lineTotal: toMajor(lineTotal),
				availableInventory: product.inventory,
				// Advisory only. Stock is genuinely reserved at checkout, not here.
				inStock: product.inventory >= item.quantity,
			};
		});

		const purchasable = items.filter((item) => !item.unavailable);
		const subtotal = sumMinor(purchasable.map((item) => item.lineTotalMinor));

		return {
			cartId: cart._id,
			status: cart.status,
			currency: appConfig.currency,
			items,
			itemCount: sumMinor(cart.items.map((item) => item.quantity)),
			subtotalMinor: subtotal,
			subtotal: toMajor(subtotal),
			hasIssues: items.some((item) => item.unavailable || !item.inStock),
			orderId: cart.orderId,
		};
	} catch (error) {
		console.log("error==>buildCartView", error);
		throw error;
	}
};

// Advisory stock check so obviously impossible quantities do not sit in a cart.
const assertStock = (product, quantity) => {
	if (product.inventory < quantity) {
		throw appError(422, "INSUFFICIENT_INVENTORY", `Only ${product.inventory} unit(s) of ${product.name} available`, {
			productId: product._id,
			requested: quantity,
			available: product.inventory,
		});
	}
};

export const addCartItem = async (cartId, productId, quantity) => {
	try {
		const cart = await findActiveCart(cartId);
		const product = await findActiveProduct(productId);

		const existing = cart.items.find((item) => String(item.productId) === String(productId));
		assertStock(product, (existing?.quantity || 0) + quantity);

		// Push when the line is new, increment when it already exists. Both are
		// single atomic updates, so two adds to the same cart cannot lose one.
		const pushed = await Cart.updateOne(
			{ _id: cartId, status: CART_STATUS.ACTIVE, "items.productId": { $ne: productId } },
			{ $push: { items: { productId, quantity } } }
		);

		if (pushed.matchedCount === 0) {
			await Cart.updateOne(
				{ _id: cartId, status: CART_STATUS.ACTIVE, "items.productId": productId },
				{ $inc: { "items.$.quantity": quantity } }
			);
		}

		return await findCart(cartId);
	} catch (error) {
		console.log("error==>addCartItem", error);
		throw error;
	}
};

export const updateCartItem = async (cartId, productId, quantity) => {
	try {
		await findActiveCart(cartId);
		const product = await findActiveProduct(productId);
		assertStock(product, quantity);

		const updated = await Cart.updateOne(
			{ _id: cartId, status: CART_STATUS.ACTIVE, "items.productId": productId },
			{ $set: { "items.$.quantity": quantity } }
		);

		if (updated.matchedCount === 0) {
			throw appError(404, "CART_ITEM_NOT_FOUND", "Cart does not contain this product", { cartId, productId });
		}

		return await findCart(cartId);
	} catch (error) {
		console.log("error==>updateCartItem", error);
		throw error;
	}
};

export const removeCartItem = async (cartId, productId) => {
	try {
		await findActiveCart(cartId);

		// The filter requires the line to exist, so matchedCount tells us whether it
		// did. modifiedCount cannot be used here: `timestamps: true` bumps updatedAt
		// on every update, so it reports 1 even when nothing was pulled.
		const updated = await Cart.updateOne(
			{ _id: cartId, status: CART_STATUS.ACTIVE, "items.productId": productId },
			{ $pull: { items: { productId } } }
		);

		if (updated.matchedCount === 0) {
			throw appError(404, "CART_ITEM_NOT_FOUND", "Cart does not contain this product", { cartId, productId });
		}

		return await findCart(cartId);
	} catch (error) {
		console.log("error==>removeCartItem", error);
		throw error;
	}
};
