import Cart from "../models/cart.js";
import Order from "../models/order.js";
import Product from "../models/product.js";
import { CART_STATUS } from "../config/constants.js";
import { appError } from "./response.js";
import { lineTotalMinor, sumMinor, discountMinor } from "./money.js";
import { findActiveCart } from "./cart.js";
import { reserveCoupon, redeemCoupon, releaseCoupon } from "./coupon.js";
import { chargePayment } from "./payment.js";

// Snapshot lines built from today's prices. Nothing is written yet.
const buildOrderLines = async (cart) => {
	try {
		const productIds = cart.items.map((item) => item.productId);
		const products = await Product.find({ _id: { $in: productIds }, isActive: true });
		const productById = new Map(products.map((product) => [String(product._id), product]));

		return cart.items.map((item) => {
			const product = productById.get(String(item.productId));

			if (!product) {
				throw appError(422, "PRODUCT_NO_LONGER_SOLD", "A product in this cart is no longer sold", {
					productId: item.productId,
				});
			}

			return {
				productId: product._id,
				sku: product.sku,
				name: product.name,
				unitPriceMinor: product.unitPriceMinor,
				quantity: item.quantity,
				lineTotalMinor: lineTotalMinor(product.unitPriceMinor, item.quantity),
			};
		});
	} catch (error) {
		console.log("error==>buildOrderLines", error);
		throw error;
	}
};

// The condition lives inside the query, so the check and the decrement are one
// atomic step. A null result means somebody else took the stock first.
const reserveInventory = async (lines) => {
	const reserved = [];

	for (const line of lines) {
		const updated = await Product.findOneAndUpdate(
			{ _id: line.productId, isActive: true, inventory: { $gte: line.quantity } },
			{ $inc: { inventory: -line.quantity } },
			{ returnDocument: "after" }
		);

		if (!updated) {
			// Hand back whatever we already took before reporting the failure.
			await releaseInventory(reserved);
			const product = await Product.findById(line.productId);

			throw appError(422, "INSUFFICIENT_INVENTORY", `Not enough stock for ${line.name}`, {
				productId: line.productId,
				requested: line.quantity,
				available: product ? product.inventory : 0,
			});
		}

		reserved.push(line);
	}

	return reserved;
};

const releaseInventory = async (lines) => {
	try {
		for (const line of lines) {
			await Product.updateOne({ _id: line.productId }, { $inc: { inventory: line.quantity } });
		}
	} catch (error) {
		console.log("error==>releaseInventory", error);
	}
};

// A duplicate key means either a retry of this request or a second checkout of
// the same cart. We cannot tell them apart from the error: when both cartId and
// idempotencyKey collide, mongo reports only one of the two indexes. So ask the
// question directly — if an order already exists under our key, it is ours.
const resolveDuplicateOrder = async (idempotencyKey) => {
	const order = await Order.findOne({ idempotencyKey });

	if (order) {
		return order;
	}

	throw appError(409, "CART_ALREADY_CHECKED_OUT", "This cart has already been checked out");
};

export const checkoutCart = async (cartId, idempotencyKey, couponCode) => {
	try {
		// A retry that arrives after the original finished never gets past here.
		const existingOrder = await Order.findOne({ idempotencyKey });

		if (existingOrder) {
			return { order: existingOrder, replayed: true };
		}

		let cart;

		try {
			cart = await findActiveCart(cartId);
		} catch (error) {
			// The winner of a same-key race may have closed the cart since the lookup
			// above. That is a replay, not a conflict, so check for our order again
			// before treating it as a second checkout.
			if (error.code === "CART_ALREADY_CHECKED_OUT") {
				const ourOrder = await Order.findOne({ idempotencyKey });

				if (ourOrder) {
					return { order: ourOrder, replayed: true };
				}
			}

			throw error;
		}

		if (cart.items.length === 0) {
			throw appError(422, "CART_EMPTY", "Cannot check out an empty cart", { cartId });
		}

		const lines = await buildOrderLines(cart);
		const subtotal = sumMinor(lines.map((line) => line.lineTotalMinor));

		let reserved = [];
		let coupon = null;

		try {
			reserved = await reserveInventory(lines);

			coupon = couponCode ? await reserveCoupon(couponCode, cartId) : null;
			const discount = coupon ? discountMinor(subtotal, coupon.discountPercent) : 0;
			const total = subtotal - discount;

			await chargePayment({ amountMinor: total, reference: String(cartId) });

			const order = await Order.create({
				cartId,
				idempotencyKey,
				items: lines,
				subtotalMinor: subtotal,
				discountMinor: discount,
				totalMinor: total,
				coupon: coupon ? { code: coupon.code, discountPercent: coupon.discountPercent } : null,
				couponId: coupon ? coupon._id : null,
			});

			await Cart.updateOne(
				{ _id: cartId },
				{ $set: { status: CART_STATUS.CHECKED_OUT, orderId: order._id, checkedOutAt: new Date() } }
			);

			if (coupon) {
				await redeemCoupon(coupon._id, order._id);
			}

			return { order, replayed: false };
		} catch (error) {
			// Everything written since the try began is undone here, so a failed
			// checkout leaves no stock held and no coupon consumed.
			await releaseInventory(reserved);

			if (coupon) {
				await releaseCoupon(coupon._id);
			}

			if (error.code === 11000) {
				const order = await resolveDuplicateOrder(idempotencyKey);
				return { order, replayed: true };
			}

			throw error;
		}
	} catch (error) {
		console.log("error==>checkoutCart", error);
		throw error;
	}
};
