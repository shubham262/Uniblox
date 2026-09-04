export const sendSuccess = (res, status, data) => {
	return res.status(status).json({ success: true, data });
};

export const sendError = (res, status, code, message, details) => {
	return res.status(status).json({ success: false, code, message, details });
};

// Business failures are thrown from helpers and caught by controllers, so the
// happy path stays free of if/else checks.
export const appError = (status, code, message, details) => {
	const error = new Error(message);
	error.status = status;
	error.code = code;
	error.details = details;
	return error;
};

export const handleControllerError = (res, name, error) => {
	console.log(`error==>${name}`, error);

	if (error.status) {
		return sendError(res, error.status, error.code, error.message, error.details);
	}

	return sendError(res, 500, "INTERNAL_ERROR", "Something went wrong");
};
