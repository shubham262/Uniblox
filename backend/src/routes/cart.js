import express from "express";
import {
	handleCreateCart,
	handleGetCart,
	handleAddCartItem,
	handleUpdateCartItem,
	handleRemoveCartItem,
} from "../controllers/cart.js";

const cartRouter = express.Router();

cartRouter.post("/", handleCreateCart);
cartRouter.get("/:cartId", handleGetCart);
cartRouter.post("/:cartId/items", handleAddCartItem);
cartRouter.patch("/:cartId/items/:productId", handleUpdateCartItem);
cartRouter.delete("/:cartId/items/:productId", handleRemoveCartItem);

export default cartRouter;
