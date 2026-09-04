import { handleMongoDBConnection } from "./src/config/index.js";
import app from "./app.js";

await handleMongoDBConnection();

app.listen(process.env.PORT, () => {
	console.log(`Server is running on port ${process.env.PORT}`);
});
