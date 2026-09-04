import express from "express";
import cors from "cors";
import router from "./src/routes/index.js";
import { sendError } from "./src/helper/response.js";

const app = express();

app.use(cors());
app.use(express.json());

// express.json() only populates req.body for requests that carry a JSON content
// type, so a client posting without one leaves it undefined and every
// `req.body.x` throws. Guarantee an object instead of guarding at each use.
app.use((req, res, next) => {
	if (!req.body) {
		req.body = {};
	}

	return next();
});

app.use("/api", router);

app.use((req, res) => {
	return sendError(res, 404, "ROUTE_NOT_FOUND", `Cannot ${req.method} ${req.originalUrl}`);
});

app.use((error, req, res, next) => {
	console.log("error==>unhandledRequest", error);

	if (error.type === "entity.parse.failed") {
		return sendError(res, 400, "INVALID_JSON", "Request body is not valid JSON");
	}

	return sendError(res, 500, "INTERNAL_ERROR", "Something went wrong");
});

export default app;
