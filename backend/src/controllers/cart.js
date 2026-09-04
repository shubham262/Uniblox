import { sendSuccess, handleControllerError } from "../helper/response.js";
import { validateId, validateQuantity } from "../helper/validate.js";
import { createCart, findCart, buildCartView, addCartItem, updateCartItem, removeCartItem } from "../helper/cart.js";

export const handleCreateCart = async (req, res) => {
	try {
		const cart = await createCart();
		const view = await buildCartView(cart);
		return sendSuccess(res, 201, view);
	} catch (error) {
		return handleControllerError(res, "handleCreateCart", error);
	}
};

export const handleGetCart = async (req, res) => {
	try {
		const cartId = validateId(req.params.cartId, "cartId");
		const cart = await findCart(cartId);
		const view = await buildCartView(cart);
		return sendSuccess(res, 200, view);
	} catch (error) {
		return handleControllerError(res, "handleGetCart", error);
	}
};

export const handleAddCartItem = async (req, res) => {
	try {
		const cartId = validateId(req.params.cartId, "cartId");
		const productId = validateId(req.body.productId, "productId");
		const quantity = validateQuantity(req.body.quantity);

		const cart = await addCartItem(cartId, productId, quantity);
		const view = await buildCartView(cart);
		return sendSuccess(res, 200, view);
	} catch (error) {
		return handleControllerError(res, "handleAddCartItem", error);
	}
};

export const handleUpdateCartItem = async (req, res) => {
	try {
		const cartId = validateId(req.params.cartId, "cartId");
		const productId = validateId(req.params.productId, "productId");
		const quantity = validateQuantity(req.body.quantity);

		const cart = await updateCartItem(cartId, productId, quantity);
		const view = await buildCartView(cart);
		return sendSuccess(res, 200, view);
	} catch (error) {
		return handleControllerError(res, "handleUpdateCartItem", error);
	}
};

export const handleRemoveCartItem = async (req, res) => {
	try {
		const cartId = validateId(req.params.cartId, "cartId");
		const productId = validateId(req.params.productId, "productId");

		const cart = await removeCartItem(cartId, productId);
		const view = await buildCartView(cart);
		return sendSuccess(res, 200, view);
	} catch (error) {
		return handleControllerError(res, "handleRemoveCartItem", error);
	}
};
