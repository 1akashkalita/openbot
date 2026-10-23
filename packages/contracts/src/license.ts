import {
  BILLING_CURRENCIES,
  BILLING_INTERVALS,
  BILLING_SUBSCRIPTION_STATUSES,
  type BillingCurrency,
  type BillingInterval,
  type BillingPlanId,
  type BillingSubscriptionStatus,
  isStripeCheckoutUrl,
} from "./billing";
import { isBoolean, isDynamicRecord, isNumber, isOneOf, isString } from "./runtime-values";

/**
 * The commercial license: one Stripe subscription per account. Its quantity is the number of users.
 * People count, not servers or computers: the owner and each account that is an active member of a
 * server that the owner owns. AI agents and chat-app participants do not count.
 *
 * There are three tiers. Starter is 1 user. Server is the Starter tier at a lower price, for an account
 * that pays for a Starter hosted server. Team is 5 to 25 users, monthly or yearly.
 */

export type LicenseTier = "starter" | "server" | "team";
export const LICENSE_TIERS: readonly LicenseTier[] = ["starter", "server", "team"];
/** The tiers that a checkout names. The account server sells `server` in place of `starter` when it applies. */
export type LicenseCheckoutTier = "starter" | "team";
export const LICENSE_CHECKOUT_TIERS: readonly LicenseCheckoutTier[] = ["starter", "team"];

/** One license Price: a tier and its billing interval. */
export interface LicensePlan {
  tier: LicenseTier;
  interval: BillingInterval;
}

/** The plans that Stripe sells, one Price each. The 1-user tiers are monthly only. */
export const LICENSE_PLANS: readonly LicensePlan[] = [
  { tier: "starter", interval: "month" },
  { tier: "server", interval: "month" },
  { tier: "team", interval: "month" },
  { tier: "team", interval: "year" },
];

/** The Stripe Price lookup key of the Team monthly license. A license from before the tiers uses it. */
export const LICENSE_LOOKUP_KEY = "openbot_license_month";

/** The Stripe Price lookup key of one license plan. `stripe-bootstrap.ts` creates them. */
export function licenseLookupKey(plan: LicensePlan): string {
  return plan.tier === "team" ? `openbot_license_${plan.interval}` : `openbot_license_${plan.tier}_${plan.interval}`;
}

/** The lookup keys of all license Prices. */
export const LICENSE_LOOKUP_KEYS: readonly string[] = LICENSE_PLANS.map(licenseLookupKey);
/** The Stripe Product of the license. */
export const LICENSE_PRODUCT_ID = "openbot_license";
/**
 * The subscription metadata of a license. It names the account with `BILLING_METADATA.userId` and has
 * no server id, so a Worker that knows only server plans ignores it.
 */
export const LICENSE_METADATA = {
  kind: "openbot_kind",
  /**
   * The most users that Stripe invoiced in the period that ends at `paidPeriodEnd`. Fewer users apply
   * with no refund, so a later increase up to this count is already paid.
   */
  paidUsers: "openbot_paid_users",
  /** The end of the period that `paidUsers` is for, in milliseconds since the epoch. */
  paidPeriodEnd: "openbot_paid_period_end",
  /** The tier of a license Price. Not `openbot_plan`: the server plan sync reads that key. */
  tier: "openbot_license_tier",
  /** The billing interval of a license Price. */
  interval: "openbot_license_interval",
} as const;
export const LICENSE_METADATA_KIND = "license";

/** The base price of the Team tier includes this many users. */
export const LICENSE_INCLUDED_USERS = 5;
/** The largest license that the app sells. A larger team contacts sales. */
export const LICENSE_MAX_USERS = 25;
/** A yearly Team license costs 12 months less this share. */
export const LICENSE_YEAR_DISCOUNT_PERCENT = 10;
/** The license terms allow this many devices for each user. The app does not count them. */
export const LICENSE_DEVICES_PER_USER = 3;
/** An account that pays for a server with one of these plans buys the 1-user license at the `server` price. */
export const LICENSE_SERVER_BUNDLE_PLANS: readonly BillingPlanId[] = ["starter"];

/** The price of one plan in minor units: the base for the included users, then each extra user. */
export interface LicensePrice {
  base: number;
  extraUser: number;
}

/**
 * The price of each plan for its whole period. Each amount is written out, so a rounding decision
 * changes data only. A yearly amount is 12 months less `LICENSE_YEAR_DISCOUNT_PERCENT` and divides by 12.
 */
export const LICENSE_PLAN_PRICES: Readonly<
  Record<"starter_month" | "server_month" | "team_month" | "team_year", Readonly<Record<BillingCurrency, LicensePrice>>>
> = {
  starter_month: {
    eur: { base: 3_000, extraUser: 0 },
    usd: { base: 3_600, extraUser: 0 },
    pln: { base: 13_200, extraUser: 0 },
  },
  server_month: {
    eur: { base: 2_000, extraUser: 0 },
    usd: { base: 2_400, extraUser: 0 },
    pln: { base: 8_800, extraUser: 0 },
  },
  team_month: {
    eur: { base: 8_000, extraUser: 1_500 },
    usd: { base: 9_600, extraUser: 1_800 },
    pln: { base: 35_200, extraUser: 6_600 },
  },
  team_year: {
    eur: { base: 86_400, extraUser: 16_200 },
    usd: { base: 103_680, extraUser: 19_440 },
    pln: { base: 380_160, extraUser: 71_280 },
  },
};

/** The monthly price of the Team tier. */
export const LICENSE_PRICES: Readonly<Record<BillingCurrency, LicensePrice>> = LICENSE_PLAN_PRICES.team_month;

/** The price table of one plan, or null for a plan that Stripe does not sell (a yearly 1-user tier). */
export function licensePlanPrices(plan: LicensePlan): Readonly<Record<BillingCurrency, LicensePrice>> | null {
  if (plan.tier === "team")
    return plan.interval === "year" ? LICENSE_PLAN_PRICES.team_year : LICENSE_PLAN_PRICES.team_month;
  if (plan.interval !== "month") return null;
  return plan.tier === "starter" ? LICENSE_PLAN_PRICES.starter_month : LICENSE_PLAN_PRICES.server_month;
}

/** The users that the base price of a tier includes. */
export function licenseIncludedUsers(tier: LicenseTier) {
  return tier === "team" ? LICENSE_INCLUDED_USERS : 1;
}

/** The most users that the app sells in a tier. */
export function licenseMaxUsers(tier: LicenseTier) {
  return tier === "team" ? LICENSE_MAX_USERS : 1;
}

/** The price of one period of a plan. A plan that Stripe does not sell gives the Team monthly price. */
export function licensePlanPrice(plan: LicensePlan, currency: BillingCurrency): LicensePrice {
  return (licensePlanPrices(plan) ?? LICENSE_PLAN_PRICES.team_month)[currency];
}

/** The amount of one period of a plan with this many users, in minor units. */
export function licensePeriodAmount(plan: LicensePlan, users: number, currency: BillingCurrency): number {
  const price = licensePlanPrice(plan, currency);
  return price.base + Math.max(0, users - licenseIncludedUsers(plan.tier)) * price.extraUser;
}

/** The amount of a plan for one month, in minor units. A yearly plan gives a twelfth of its year. */
export function licenseMonthlyAmount(plan: LicensePlan, users: number, currency: BillingCurrency): number {
  const amount = licensePeriodAmount(plan, users, currency);
  return plan.interval === "year" ? Math.round(amount / 12) : amount;
}

/** The monthly amount of a Team license with this many users, in minor units. */
export function licenseAmount(users: number, currency: BillingCurrency): number {
  return licensePeriodAmount({ tier: "team", interval: "month" }, users, currency);
}

/** True for a user count that the app can buy or set in the Team tier. */
export function isLicenseUserCount(value: unknown): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= LICENSE_INCLUDED_USERS && value <= LICENSE_MAX_USERS;
}

/** True for a user count that the app sells in this tier. */
export function isLicenseTierUserCount(tier: LicenseTier, value: unknown): value is number {
  return tier === "team" ? isLicenseUserCount(value) : value === 1;
}

/**
 * The plan of a license Price. The Price metadata names it; a Price from before the tiers has only the
 * Team monthly lookup key. An unknown Price is read as Team monthly.
 */
export function licensePlanFromPrice(price: {
  lookup_key: string | null;
  metadata: Readonly<Record<string, string>>;
}): LicensePlan {
  const tier = price.metadata[LICENSE_METADATA.tier];
  const interval = price.metadata[LICENSE_METADATA.interval];
  if (isOneOf(LICENSE_TIERS, tier) && isOneOf(BILLING_INTERVALS, interval)) return { tier, interval };
  return (
    LICENSE_PLANS.find((plan) => licenseLookupKey(plan) === price.lookup_key) ?? { tier: "team", interval: "month" }
  );
}

/** The plan of a license. A license from an account server before the tiers is Team monthly. */
export function licensePlanOf(license: { tier?: LicenseTier; interval?: BillingInterval }): LicensePlan {
  return { tier: license.tier ?? "team", interval: license.interval ?? "month" };
}

export interface License {
  /** The Stripe subscription id. */
  subscriptionId: string;
  /** The number of users that the license pays for. */
  users: number;
  currency: BillingCurrency;
  /**
   * The monthly list price in minor units, before discounts and tax. A yearly license gives a twelfth of
   * its year, so an app from before yearly licenses shows a correct monthly price.
   */
  amount: number;
  /** Absent from an account server before the tiers: Team. */
  tier?: LicenseTier;
  /** Absent from an account server before the tiers: monthly. */
  interval?: BillingInterval;
  status: BillingSubscriptionStatus;
  /** Milliseconds since the epoch. */
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
}

/** One person that the license of the account counts. */
export interface LicenseUser {
  name: string | null;
  email: string;
  /** The names of the owner's servers where this person is an active member. */
  servers: string[];
  /** True for the owner of the license. */
  owner: boolean;
}

/** The license of a server owner that covers this account. */
export interface LicenseCoverage {
  ownerName: string | null;
  ownerEmail: string;
}

export interface LicenseState {
  /** False when the account server has no billing. The app then shows no license. */
  available: boolean;
  /**
   * The currency of the account's open subscriptions. A Stripe customer pays in one currency, so a new
   * license must use it. Null when the account has no open subscription.
   */
  currency: BillingCurrency | null;
  /** The open license of the account, else its newest ended license, else null. */
  license: License | null;
  /** The number of people that the license counts now. */
  used: number;
  users: LicenseUser[];
  /** The open licenses of the owners of servers where this account is a member. */
  coveredBy: LicenseCoverage[];
  /** True when the account pays for a server that gives the 1-user license at the `server` price. */
  serverPrice?: boolean;
}

export interface LicenseCheckoutRequest {
  users: number;
  currency: BillingCurrency;
  /** Absent from an app before the tiers: Team. */
  tier?: LicenseCheckoutTier;
  /** Absent from an app before the tiers: monthly. */
  interval?: BillingInterval;
}

/** A change of an open license to the Team tier, or of a monthly Team license to yearly. */
export interface LicensePlanRequest {
  interval: BillingInterval;
  users: number;
}

export interface LicenseUsersRequest {
  users: number;
}

export interface LicenseRenewalRequest {
  /** True cancels the license at the end of its period. False renews it again. */
  cancel: boolean;
}

export const LICENSE_UNAVAILABLE_STATE: LicenseState = {
  available: false,
  currency: null,
  license: null,
  used: 0,
  users: [],
  coveredBy: [],
};

const SUBSCRIPTION_ID_PATTERN = /^sub_[A-Za-z0-9]{1,250}$/u;

function isCount(value: unknown): value is number {
  return isNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

function parseLicense(value: unknown): License | null {
  if (
    !isDynamicRecord(value) ||
    !isString(value.subscriptionId) ||
    !SUBSCRIPTION_ID_PATTERN.test(value.subscriptionId) ||
    !isCount(value.users) ||
    !isOneOf(BILLING_CURRENCIES, value.currency) ||
    !isCount(value.amount) ||
    !isOneOf(BILLING_SUBSCRIPTION_STATUSES, value.status) ||
    !(value.currentPeriodEnd === null || isNumber(value.currentPeriodEnd)) ||
    !isBoolean(value.cancelAtPeriodEnd)
  ) {
    return null;
  }
  return {
    subscriptionId: value.subscriptionId,
    users: value.users,
    currency: value.currency,
    amount: value.amount,
    status: value.status,
    currentPeriodEnd: value.currentPeriodEnd,
    cancelAtPeriodEnd: value.cancelAtPeriodEnd,
    // A value from a later account server that this app does not know is left out.
    ...(isOneOf(LICENSE_TIERS, value.tier) ? { tier: value.tier } : {}),
    ...(isOneOf(BILLING_INTERVALS, value.interval) ? { interval: value.interval } : {}),
  };
}

function parseLicenseUser(value: unknown): LicenseUser | null {
  if (
    !isDynamicRecord(value) ||
    !(value.name === null || isString(value.name)) ||
    !isString(value.email) ||
    !Array.isArray(value.servers) ||
    !value.servers.every(isString) ||
    !isBoolean(value.owner)
  ) {
    return null;
  }
  return { name: value.name, email: value.email, servers: [...value.servers], owner: value.owner };
}

function parseLicenseCoverage(value: unknown): LicenseCoverage | null {
  if (
    !isDynamicRecord(value) ||
    !(value.ownerName === null || isString(value.ownerName)) ||
    !isString(value.ownerEmail)
  )
    return null;
  return { ownerName: value.ownerName, ownerEmail: value.ownerEmail };
}

/** Returns null for a value that is not a license state in the account server shape. */
export function parseLicenseState(value: unknown): LicenseState | null {
  if (
    !isDynamicRecord(value) ||
    !isBoolean(value.available) ||
    !(value.currency === null || isOneOf(BILLING_CURRENCIES, value.currency)) ||
    !isCount(value.used) ||
    !Array.isArray(value.users) ||
    !Array.isArray(value.coveredBy)
  ) {
    return null;
  }
  const license = value.license === null ? null : parseLicense(value.license);
  if (value.license !== null && !license) return null;
  const users: LicenseUser[] = [];
  for (const item of value.users) {
    const user = parseLicenseUser(item);
    if (user) users.push(user);
  }
  const coveredBy: LicenseCoverage[] = [];
  for (const item of value.coveredBy) {
    const coverage = parseLicenseCoverage(item);
    if (coverage) coveredBy.push(coverage);
  }
  return {
    available: value.available,
    currency: value.currency,
    license,
    used: value.used,
    users,
    coveredBy,
    ...(isBoolean(value.serverPrice) ? { serverPrice: value.serverPrice } : {}),
  };
}

/** A request with no tier or interval is the Team monthly license that apps before the tiers buy. */
export function parseLicenseCheckoutRequest(value: unknown): Required<LicenseCheckoutRequest> | null {
  if (!isDynamicRecord(value) || !isOneOf(BILLING_CURRENCIES, value.currency)) return null;
  const tier = value.tier === undefined ? "team" : value.tier;
  const interval = value.interval === undefined ? "month" : value.interval;
  if (!isOneOf(LICENSE_CHECKOUT_TIERS, tier) || !isOneOf(BILLING_INTERVALS, interval)) return null;
  if (!licensePlanPrices({ tier, interval }) || !isLicenseTierUserCount(tier, value.users)) return null;
  return { users: value.users, currency: value.currency, tier, interval };
}

export function parseLicensePlanRequest(value: unknown): LicensePlanRequest | null {
  if (!isDynamicRecord(value) || !isOneOf(BILLING_INTERVALS, value.interval) || !isLicenseUserCount(value.users))
    return null;
  return { interval: value.interval, users: value.users };
}

export function parseLicenseUsersRequest(value: unknown): LicenseUsersRequest | null {
  if (!isDynamicRecord(value) || !isLicenseUserCount(value.users)) return null;
  return { users: value.users };
}

export function parseLicenseRenewalRequest(value: unknown): LicenseRenewalRequest | null {
  if (!isDynamicRecord(value) || !isBoolean(value.cancel)) return null;
  return { cancel: value.cancel };
}

/** Returns the Checkout page URL from a `{ url }` response, or null when it is not a Stripe Checkout page. */
export function parseLicenseCheckoutUrl(value: unknown): string | null {
  return isDynamicRecord(value) && isStripeCheckoutUrl(value.url) ? value.url : null;
}
