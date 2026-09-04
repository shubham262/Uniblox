import mongoose from "mongoose";
import { appError } from "./response.js";

export const validateId = (id, label) => {
	if (!mongoose.Types.ObjectId.isValid(id)) {
		throw appError(400, "INVALID_ID", `${label} is not a valid id`, { value: id });
	}

	return id;
};

export const validateQuantity = (quantity) => {
	if (!Number.isInteger(quantity) || quantity < 1) {
		throw appError(400, "INVALID_QUANTITY", "quantity must be a whole number of at least 1", { value: quantity });
	}

	return quantity;
};
