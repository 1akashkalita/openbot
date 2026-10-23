import {
  BILLING_PLANS,
  type BillingCurrency,
  type BillingInterval,
  type BillingPlanId,
} from "@openbot/contracts/billing";
import type { HostedServerCatalogPlan } from "@openbot/contracts/hosted-servers";
import { LICENSE_INCLUDED_USERS, LICENSE_MAX_USERS, LICENSE_PRICES } from "@openbot/contracts/license";
import type { AppTextKey, AppTranslate } from "@openbot/i18n";
import {
  formatMoney,
  LICENSE_BUNDLE_DISCOUNT,
  LICENSE_YEARLY_DISCOUNT_PERCENT,
  licenseMonthlyPrice,
  yearlyDiscountPercent,
} from "../../lib/pricing-page";

/*
 * The text of the pricing page, built from `sitePage.pricing.*` catalog keys. Loader data carries it to
 * the browser, so it holds plain strings: each text with a number that the page changes is built for
 * each value. This module has only a type import of the catalogs.
 */

const PLAN_NAME = {
  starter: "settings.hostedServers.plan.starter.name",
  standard: "settings.hostedServers.plan.standard.name",
  pro: "settings.hostedServers.plan.pro.name",
} as const satisfies Record<BillingPlanId, AppTextKey>;

const BEST_FOR = {
  starter: "sitePage.pricing.server.bestFor.starter",
  standard: "sitePage.pricing.server.bestFor.standard",
  pro: "sitePage.pricing.server.bestFor.pro",
} as const satisfies Record<BillingPlanId, AppTextKey>;

/** Keeps "50 GB storage" and "2× speed" on one line on a phone. */
function noBreak(text: string): string {
  return text.replaceAll(" ", " ");
}

function byCurrency(build: (currency: BillingCurrency) => string): Record<BillingCurrency, string> {
  return { eur: build("eur"), usd: build("usd"), pln: build("pln") };
}

/** The largest team that the page sells to. A larger team contacts sales. */
const PRICING_MAX_MEMBERS = Math.max(LICENSE_MAX_USERS, ...BILLING_PLANS.map((plan) => plan.memberLimit));

export function pricingPageText(t: AppTranslate, plans: readonly HostedServerCatalogPlan[]) {
  const counts = Array.from({ length: LICENSE_MAX_USERS + 1 }, (_, count) => count);
  const yearlyPercent = byCurrency((currency) => String(yearlyDiscountPercent(plans, currency)));
  const teamDetail = (interval: BillingInterval) =>
    byCurrency((currency) =>
      t("sitePage.pricing.license.teamDetail", {
        included: LICENSE_INCLUDED_USERS,
        price: formatMoney(licenseMonthlyPrice(LICENSE_PRICES[currency].extraUser, interval), currency),
      }),
    );
  return {
    title: t("sitePage.pricing.title"),
    description: t("sitePage.pricing.description"),
    heading: t("sitePage.pricing.heading"),
    billing: t("sitePage.pricing.billing"),
    monthly: t("sitePage.pricing.monthly"),
    yearly: t("sitePage.pricing.yearly"),
    currency: t("sitePage.pricing.currency"),
    server: {
      title: t("sitePage.pricing.server.title"),
      summary: t("sitePage.pricing.server.summary"),
      none: t("sitePage.pricing.server.none"),
      noneDetail: t("sitePage.pricing.server.noneDetail"),
      bestValue: t("sitePage.pricing.server.bestValue"),
      yearlySaving: byCurrency((currency) =>
        t("sitePage.pricing.server.yearlySaving", { percent: yearlyPercent[currency] }),
      ),
      /** In the order of `BILLING_PLANS`. */
      plans: BILLING_PLANS.map((plan) => {
        const name = t(PLAN_NAME[plan.id]);
        const detail = [t(BEST_FOR[plan.id]), noBreak(t("sitePage.pricing.server.storage", { size: plan.storageGb }))];
        if (plan.relativeSpeed > 1)
          detail.push(noBreak(t("sitePage.pricing.server.speed", { speed: plan.relativeSpeed })));
        return {
          id: plan.id,
          name,
          detail: detail.join(" · "),
          summary: t("sitePage.pricing.summary.server", { plan: name, count: plan.memberLimit }),
        };
      }),
    },
    license: {
      title: t("sitePage.pricing.license.title"),
      summary: t("sitePage.pricing.license.summary"),
      none: t("sitePage.pricing.license.none"),
      noneDetail: t("sitePage.pricing.license.noneDetail"),
      starter: t("sitePage.pricing.license.starter"),
      starterDetail: t("sitePage.pricing.memberCount", { count: 1 }),
      starterSummary: t("sitePage.pricing.summary.starterLicense"),
      yearlySaving: t("sitePage.pricing.server.yearlySaving", { percent: LICENSE_YEARLY_DISCOUNT_PERCENT }),
      bundleSaving: {
        starter: byCurrency((currency) =>
          t("sitePage.pricing.license.bundleSaving", {
            price: formatMoney(LICENSE_BUNDLE_DISCOUNT.starter[currency], currency),
          }),
        ),
        team: byCurrency((currency) =>
          t("sitePage.pricing.license.bundleSaving", {
            price: formatMoney(LICENSE_BUNDLE_DISCOUNT.team[currency], currency),
          }),
        ),
      },
      team: t("sitePage.pricing.license.team"),
      teamDetail: {
        month: teamDetail("month"),
        year: teamDetail("year"),
      },
      members: t("sitePage.pricing.license.members"),
      fewer: t("sitePage.pricing.license.fewer"),
      more: t("sitePage.pricing.license.more"),
      /** Index: the number of members. */
      memberCount: counts.map((count) => t("sitePage.pricing.memberCount", { count })),
      /** Index: the number of members of a server too small for the Team license. */
      serverMembers: counts.map((count) => t("sitePage.pricing.license.serverMembers", { count })),
      /** Index: the number of members. */
      summaryLine: counts.map((count) => t("sitePage.pricing.summary.license", { count })),
    },
    summary: {
      title: t("sitePage.pricing.summary.title"),
      yearlyDiscount: byCurrency((currency) =>
        t("sitePage.pricing.summary.yearlyDiscount", { percent: yearlyPercent[currency] }),
      ),
      licenseYearlyDiscount: t("sitePage.pricing.summary.yearlyDiscount", { percent: LICENSE_YEARLY_DISCOUNT_PERCENT }),
      bundleDiscount: t("sitePage.pricing.summary.bundleDiscount"),
      personal: t("sitePage.pricing.summary.personal"),
      total: t("sitePage.pricing.summary.total"),
    },
    unit: {
      month: t("sitePage.pricing.unit.month"),
      monthBilledYearly: t("sitePage.pricing.unit.monthBilledYearly"),
      monthExclVat: t("sitePage.pricing.unit.monthExclVat"),
      monthBilledYearlyExclVat: t("sitePage.pricing.unit.monthBilledYearlyExclVat"),
      free: t("sitePage.pricing.unit.free"),
    },
    cta: {
      server: t("sitePage.pricing.cta.server"),
      license: t("sitePage.pricing.cta.license"),
      download: t("sitePage.pricing.cta.download"),
    },
    enterprise: {
      title: t("sitePage.pricing.enterprise.title"),
      body: t("sitePage.pricing.enterprise.body", { count: PRICING_MAX_MEMBERS }),
      contact: t("sitePage.pricing.enterprise.contact"),
    },
  };
}

export type PricingPageText = ReturnType<typeof pricingPageText>;
