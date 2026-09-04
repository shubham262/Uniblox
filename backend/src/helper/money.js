// All amounts are integers in minor units (paise). These helpers exist so no
// other file ever divides or multiplies money by hand.

export const toMajor = (minor) => (minor / 100).toFixed(2);

export const lineTotalMinor = (unitPriceMinor, quantity) => unitPriceMinor * quantity;

export const sumMinor = (values) => values.reduce((total, value) => total + value, 0);

// Rounded down, so the discount never exceeds the stated percentage, and capped
// at the subtotal so a total can never go negative.
export const discountMinor = (subtotalMinor, percent) => {
	const discount = Math.floor((subtotalMinor * percent) / 100);
	return Math.min(discount, subtotalMinor);
};
