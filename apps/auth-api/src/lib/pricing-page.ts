// The /pricing page: hosted servers and the license, as one order form. No JSX here, for the same
// reason `content-collection.ts` holds none.

import {
  BILLING_PLANS,
  type BillingCurrency,
  type BillingInterval,
  billingListPrices,
} from "@openbot/contracts/billing";
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

/**
 * The monthly price of the Starter license, for one member, in minor units. Only this page shows it:
 * the app's Billing sells the Team license, so "Buy a license" opens that.
 */
export const STARTER_LICENSE_MONTHLY: Readonly<Record<BillingCurrency, number>> = { eur: 3000, usd: 3600, pln: 13200 };

/** Yearly billing takes this much off a license. Like the bundle discount, only this page uses it for now. */
export const LICENSE_YEARLY_DISCOUNT_PERCENT = 10;

/** A license bought with any server costs this much less a month, in minor units. */
export const LICENSE_BUNDLE_DISCOUNT: Readonly<Record<"starter" | "team", Readonly<Record<BillingCurrency, number>>>> =
  {
    starter: { eur: 1000, usd: 1200, pln: 4400 },
    team: { eur: 2000, usd: 2400, pln: 8800 },
  };

/** The price for one month of a license, in minor units, from its monthly price. */
export function licenseMonthlyPrice(month: number, interval: BillingInterval): number {
  return interval === "month" ? month : Math.round((month * (100 - LICENSE_YEARLY_DISCOUNT_PERCENT)) / 100);
}

/** What the page sells: the server plans with their prices, and the VAT of the visitor. */
export interface PricingOffer {
  plans: readonly HostedServerCatalogPlan[];
  inEu: boolean;
}

/**
 * The plans at their list prices. Stripe has the same amounts (`scripts/stripe-bootstrap.ts`), so the page
 * shows these when the Stripe catalog does not load, as on a preview Worker.
 */
export const LIST_PRICE_PLANS: readonly HostedServerCatalogPlan[] = BILLING_PLANS.map((plan) => {
  const month = billingListPrices(plan.id, "month");
  const year = billingListPrices(plan.id, "year");
  return {
    id: plan.id,
    diskGb: plan.storageGb,
    memberLimit: plan.memberLimit,
    relativeSpeed: plan.relativeSpeed,
    prices: {
      eur: { month: month.eur, year: year.eur },
      usd: { month: month.usd, year: year.usd },
      pln: { month: month.pln, year: year.pln },
    },
  };
});

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
