/**
 * APPLICATION SERVICE FEE — a BookKaro charge, clearly distinguished from the
 * RAILWAY fare quoted by providers. Displayed separately everywhere money is
 * mentioned; never merged into the railway fare, never invented as railway data.
 */

/** Flat service fee per booking, in paise. Policy constant (no payment gateway exists yet). */
export const APPLICATION_SERVICE_FEE_MINOR = 2000; // ₹20.00

export const SERVICE_FEE_LABEL = 'BookKaro service fee';

export function totalPayableMinor(railwayFareMinor: number): number {
  return railwayFareMinor + APPLICATION_SERVICE_FEE_MINOR;
}
