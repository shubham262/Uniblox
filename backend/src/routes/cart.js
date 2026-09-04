import express from "express";
import {
	handleCreateCart,
	handleGetCart,
	handleAddCartItem,
	handleUpdateCartItem,
	handleRemoveCartItem,
} from "../controllers/cart.js";
import { handleCheckout } from "../controllers/order.js";

const cartRouter = express.Router();

cartRouter.post("/", handleCreateCart);
cartRouter.get("/:cartId", handleGetCart);
cartRouter.post("/:cartId/items", handleAddCartItem);
cartRouter.patch("/:cartId/items/:productId", handleUpdateCartItem);
cartRouter.delete("/:cartId/items/:productId", handleRemoveCartItem);
cartRouter.post("/:cartId/checkout", handleCheckout);

export default cartRouter;
