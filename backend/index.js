import { handleMongoDBConnection } from "./src/config/index.js";
import app from "./app.js";

await handleMongoDBConnection();

const port = process.env.PORT || 3001;

app.listen(port, () => {
	console.log(`Server is running on port ${port}`);
});
