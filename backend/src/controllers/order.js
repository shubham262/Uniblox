import { sendSuccess, handleControllerError, appError } from "../helper/response.js";
import { validateId } from "../helper/validate.js";
import { checkoutCart } from "../helper/checkout.js";
import { findOrder, buildOrderView } from "../helper/order.js";

export const handleCheckout = async (req, res) => {
	try {
		const cartId = validateId(req.params.cartId, "cartId");
		const idempotencyKey = String(req.get("Idempotency-Key") || "").trim();

		if (!idempotencyKey) {
			throw appError(400, "IDEMPOTENCY_KEY_REQUIRED", "An Idempotency-Key header is required to check out");
		}

		const { order, replayed } = await checkoutCart(cartId, idempotencyKey, req.body.couponCode);

		// 200 for a replayed retry, 201 when this request actually created it.
		return sendSuccess(res, replayed ? 200 : 201, { ...buildOrderView(order), replayed });
	} catch (error) {
		return handleControllerError(res, "handleCheckout", error);
	}
};

export const handleGetOrder = async (req, res) => {
	try {
		const orderId = validateId(req.params.orderId, "orderId");
		const order = await findOrder(orderId);
		return sendSuccess(res, 200, buildOrderView(order));
	} catch (error) {
		return handleControllerError(res, "handleGetOrder", error);
	}
};
