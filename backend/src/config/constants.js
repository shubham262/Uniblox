export const appConfig = {
	currency: "INR",
	couponOrderInterval: Number(process.env.COUPON_ORDER_INTERVAL) || 5,
	couponDiscountPercent: Number(process.env.COUPON_DISCOUNT_PERCENT) || 10,
};

export const CART_STATUS = {
	ACTIVE: "active",
	CHECKED_OUT: "checked_out",
};

export const ORDER_STATUS = {
	PLACED: "placed",
};

export const COUPON_STATUS = {
	AVAILABLE: "available",
	RESERVED: "reserved",
	REDEEMED: "redeemed",
};
