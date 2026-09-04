import express from "express";
import cors from "cors";
import { handleMongoDBConnection } from "./src/config/index.js";
import router from "./src/routes/index.js";
import { sendError } from "./src/helper/response.js";

await handleMongoDBConnection();

const app = express();
app.use(cors());
app.use(express.json());

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

app.listen(process.env.PORT, () => {
	console.log(`Server is running on port ${process.env.PORT}`);
});
