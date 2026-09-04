import { appError } from "./response.js";

// Stand-in for a real payment gateway. It always succeeds, but it is a real
// step with a real failure path, so checkout already knows how to unwind when a
// charge is declined. Swapping this for a live gateway changes nothing else.
export const chargePayment = async ({ amountMinor, reference }) => {
	try {
		if (!Number.isInteger(amountMinor) || amountMinor < 0) {
			throw appError(422, "INVALID_CHARGE_AMOUNT", "Charge amount must be a non-negative whole number");
		}

		return { status: "succeeded", provider: "fake", reference: `fake_${reference}`, amountMinor };
	} catch (error) {
		console.log("error==>chargePayment", error);
		throw error;
	}
};
