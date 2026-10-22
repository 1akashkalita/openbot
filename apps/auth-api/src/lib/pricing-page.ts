// The /pricing page: hosted servers and the license, as one order form. No JSX here, for the same
// reason `content-collection.ts` holds none.

import type { BillingCurrency, BillingInterval } from "@openbot/contracts/billing";
import type { HostedServerCatalogPlan } from "@openbot/contracts/hosted-servers";

export const PRICING_ROUTE = "/pricing";

/** The sitemap date of the page. Change it when its text changes. */
export const PRICING_PAGE_UPDATED_AT = "2026-10-22";

/**
 * The VAT that the page adds for a visitor in the EU. Every buyer in the EU pays Polish VAT, with no
 * VAT ID check. A buyer outside the EU pays none. Checkout does not charge it yet.
 */
export const EU_VAT_PERCENT = 23;

/** The EU member states, as the ISO 3166-1 alpha-2 codes of the `CF-IPCountry` header. */
const EU_COUNTRIES: ReadonlySet<string> = new Set([
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
]);

/** True for a `CF-IPCountry` value in the EU. A missing or unknown country is not in the EU. */
export function isEuCountry(country: string | undefined): boolean {
  return country !== undefined && EU_COUNTRIES.has(country.toUpperCase());
}

/** What the page sells: the server plans with their Stripe prices, and the VAT of the visitor. */
export interface PricingOffer {
  /** Null when the prices did not load. The page then sells only the license. */
  plans: readonly HostedServerCatalogPlan[] | null;
  inEu: boolean;
}

export function formatMoney(minor: number, currency: BillingCurrency): string {
  // Polish writes the złoty after the amount: "440 zł".
  return new Intl.NumberFormat(currency === "pln" ? "pl" : "en", {
    style: "currency",
    currency: currency.toUpperCase(),
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: minor % 100 === 0 ? 0 : 2,
  }).format(minor / 100);
}

/** The price for one month of a plan, in minor units. On yearly billing it is the yearly price divided by 12. */
export function planMonthlyPrice(
  plan: HostedServerCatalogPlan,
  interval: BillingInterval,
  currency: BillingCurrency,
): number {
  const prices = plan.prices[currency];
  return interval === "month" ? prices.month : Math.round(prices.year / 12);
}

/**
 * How much less yearly billing costs than twelve monthly payments, in whole percent. It is the smallest
 * discount of the plans, so the text is true for each plan, as in the app's create dialog.
 */
export function yearlyDiscountPercent(plans: readonly HostedServerCatalogPlan[], currency: BillingCurrency): number {
  const discounts = plans.map((plan) => {
    const twelveMonths = plan.prices[currency].month * 12;
    return twelveMonths > 0 ? Math.floor(((twelveMonths - plan.prices[currency].year) * 100) / twelveMonths) : 0;
  });
  return discounts.length === 0 ? 0 : Math.max(0, Math.min(...discounts));
}
