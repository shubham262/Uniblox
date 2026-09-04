import mongoose from "mongoose";

// Defaults so the service still starts if .env is missing, rather than silently
// connecting to a database literally named "undefined".
const database = process.env.DATABASE || "uniblox";
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/" + database;

export const handleMongoDBConnection = async () => {
	try {
		await mongoose.connect(MONGO_URI);
		console.log("mongodb connection successfull");
	} catch (error) {
		console.log("error==>handleMongoDBConnection", error);
		// A server that boots without a database would accept requests it cannot
		// honour, so the caller must be able to abort startup.
		throw error;
	}
};

export const handleMongoDBDisconnection = async () => {
	try {
		await mongoose.disconnect();
		console.log("mongodb disconnected");
	} catch (error) {
		console.log("error==>handleMongoDBDisconnection", error);
	}
};
