import { pathToFileURL } from "url";
import { handleMongoDBConnection, handleMongoDBDisconnection } from "../config/index.js";
import Product from "../models/product.js";
import Cart from "../models/cart.js";
import Order from "../models/order.js";
import Coupon from "../models/coupon.js";

// Prices are in paise. 129900 => Rs 1,299.00
export const seedProducts = [
	{ sku: "MOUSE-WL-01", name: "Wireless Mouse", unitPriceMinor: 129900, inventory: 50 },
	{ sku: "KEYB-MECH-01", name: "Mechanical Keyboard", unitPriceMinor: 449950, inventory: 25 },
	{ sku: "STAND-LAP-01", name: "Aluminium Laptop Stand", unitPriceMinor: 89900, inventory: 40 },
	{ sku: "HUB-USBC-01", name: "7-in-1 USB-C Hub", unitPriceMinor: 219900, inventory: 12 },
	// Deliberately scarce, so concurrent checkouts have something to fight over.
	{ sku: "MON-4K-27", name: '27" 4K Monitor', unitPriceMinor: 2899900, inventory: 3 },
	{ sku: "HEAD-ANC-01", name: "Noise Cancelling Headphones", unitPriceMinor: 1575000, inventory: 2 },
];

// Resets the whole domain, not just products. A reviewer running this wants a
// known state to evaluate against, and leaving old orders behind would skew the
// coupon milestone count and the admin report.
export const runSeed = async () => {
	try {
		await Promise.all([
			Product.deleteMany({}),
			Cart.deleteMany({}),
			Order.deleteMany({}),
			Coupon.deleteMany({}),
		]);
		console.log("cleared products, carts, orders and coupons");

		const products = await Product.insertMany(seedProducts);
		console.log(`seeded ${products.length} products`);

		products.forEach((product) => {
			console.log(`  ${product.sku.padEnd(14)} ${String(product.inventory).padStart(3)} in stock  ${product.name}`);
		});

		return products;
	} catch (error) {
		console.log("error==>runSeed", error);
		throw error;
	}
};

const handleSeedCommand = async () => {
	try {
		await handleMongoDBConnection();
		await runSeed();
		await handleMongoDBDisconnection();
		console.log("seed complete");
		process.exit(0);
	} catch (error) {
		console.log("error==>handleSeedCommand", error);
		process.exit(1);
	}
};

// Only run when invoked as a script (`npm run seed`). Tests import `runSeed`
// directly and manage their own connection, so importing this file must not
// wipe the database as a side effect.
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
	handleSeedCommand();
}
