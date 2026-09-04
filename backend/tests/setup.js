import { createServer } from "http";
import { once } from "events";
import mongoose from "mongoose";
import app from "../app.js";
import { runSeed } from "../src/service/seed.js";

// Tests run against their own database so they never touch development data.
const TEST_DATABASE = process.env.TEST_DATABASE || "uniblox_test";
const TEST_MONGO_URI = "mongodb://127.0.0.1:27017/" + TEST_DATABASE;

let server = null;
let baseUrl = "";

// Most of these tests deliberately trigger failures, and every failure path logs.
// Silence that noise so the test report is readable; SHOW_LOGS=1 brings it back
// when a test is actually being debugged.
const silenceServiceLogs = () => {
	if (!process.env.SHOW_LOGS) {
		console.log = () => {};
	}
};

export const startTestServer = async () => {
	try {
		await mongoose.connect(TEST_MONGO_URI);
		silenceServiceLogs();
		server = createServer(app).listen(0);
		await once(server, "listening");
		baseUrl = `http://localhost:${server.address().port}/api`;
	} catch (error) {
		console.log("error==>startTestServer", error);
		throw error;
	}
};

export const stopTestServer = async () => {
	try {
		await mongoose.connection.dropDatabase();
		await mongoose.disconnect();
		server.close();
		await once(server, "close");
	} catch (error) {
		console.log("error==>stopTestServer", error);
	}
};

// Every test starts from the seeded catalogue, so tests do not depend on order.
export const resetDatabase = async () => {
	await runSeed({ silent: true });
};

export const api = async (method, path, { body, idempotencyKey } = {}) => {
	const headers = { "content-type": "application/json" };

	if (idempotencyKey) {
		headers["Idempotency-Key"] = idempotencyKey;
	}

	const response = await fetch(baseUrl + path, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});

	return { status: response.status, body: await response.json() };
};

// Deliberately sends no content-type and no body, the way a plain curl call
// does. express.json() skips such requests, so req.body is undefined.
export const apiWithoutBody = async (method, path, { idempotencyKey } = {}) => {
	const headers = {};

	if (idempotencyKey) {
		headers["Idempotency-Key"] = idempotencyKey;
	}

	const response = await fetch(baseUrl + path, { method, headers });
	return { status: response.status, body: await response.json() };
};

export const getProduct = async (sku) => {
	const { body } = await api("GET", "/products");
	return body.data.products.find((product) => product.sku === sku);
};

export const createCartWith = async (sku, quantity) => {
	const product = await getProduct(sku);
	const { body } = await api("POST", "/carts");
	await api("POST", `/carts/${body.data.cartId}/items`, { body: { productId: product.productId, quantity } });
	return { cartId: body.data.cartId, product };
};

let keyCounter = 0;

export const uniqueKey = (label) => `${label}-${Date.now()}-${keyCounter++}`;
