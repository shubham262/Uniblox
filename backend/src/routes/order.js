import express from "express";
import { handleGetOrder } from "../controllers/order.js";

const orderRouter = express.Router();

orderRouter.get("/:orderId", handleGetOrder);

export default orderRouter;
