import mongoose from "mongoose";

const database = process.env.DATABASE;
const MONGO_URI = "mongodb://127.0.0.1:27017/" + database;

export const handleMongoDBConnection = async () => {
	try {
		await mongoose.connect(MONGO_URI);
		console.log("mongodb connection successfull");
	} catch (error) {
		console.log("error==>handleMongoDBConnection", error);
	}
};
