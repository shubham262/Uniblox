import express from "express";
import productRouter from "./product.js";
import cartRouter from "./cart.js";
import orderRouter from "./order.js";
import adminRouter from "./admin.js";
import { appConfig } from "../config/constants.js";

const router = express.Router();

router.get("/health", (req, res) => {
	return res.status(200).json({
		success: true,
		data: {
			status: "ok",
			couponOrderInterval: appConfig.couponOrderInterval,
			couponDiscountPercent: appConfig.couponDiscountPercent,
		},
	});
});

router.use("/products", productRouter);
router.use("/carts", cartRouter);
router.use("/orders", orderRouter);
router.use("/admin", adminRouter);

export default router;
