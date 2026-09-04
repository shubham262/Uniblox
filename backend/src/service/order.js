import Order from "../models/order.js";
import { appError } from "../helper/response.js";
import { toMajor } from "../helper/money.js";

export const buildOrderView = (order) => ({
	orderId: order._id,
	cartId: order.cartId,
	status: order.status,
	currency: order.currency,
	items: order.items.map((item) => ({
		productId: item.productId,
		sku: item.sku,
		name: item.name,
		quantity: item.quantity,
		unitPriceMinor: item.unitPriceMinor,
		unitPrice: toMajor(item.unitPriceMinor),
		lineTotalMinor: item.lineTotalMinor,
		lineTotal: toMajor(item.lineTotalMinor),
	})),
	subtotalMinor: order.subtotalMinor,
	subtotal: toMajor(order.subtotalMinor),
	discountMinor: order.discountMinor,
	discount: toMajor(order.discountMinor),
	totalMinor: order.totalMinor,
	total: toMajor(order.totalMinor),
	coupon: order.coupon ? { code: order.coupon.code, discountPercent: order.coupon.discountPercent } : null,
	placedAt: order.placedAt,
});

export const findOrder = async (orderId) => {
	try {
		const order = await Order.findById(orderId);

		if (!order) {
			throw appError(404, "ORDER_NOT_FOUND", "Order does not exist", { orderId });
		}

		return order;
	} catch (error) {
		console.log("error==>findOrder", error);
		throw error;
	}
};
