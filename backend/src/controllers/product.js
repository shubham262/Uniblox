import { sendSuccess, handleControllerError } from "../helper/response.js";
import { listActiveProducts } from "../service/product.js";

export const handleListProducts = async (req, res) => {
	try {
		const products = await listActiveProducts();
		return sendSuccess(res, 200, { products });
	} catch (error) {
		return handleControllerError(res, "handleListProducts", error);
	}
};
