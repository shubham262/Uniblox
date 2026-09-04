import express from "express";
import { handleListProducts } from "../controllers/product.js";

const productRouter = express.Router();

productRouter.get("/", handleListProducts);

export default productRouter;
