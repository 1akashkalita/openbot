import type { BillingCurrency, BillingPlanId } from "@openbot/contracts/billing";
import type { HostedServerCatalog } from "@openbot/contracts/hosted-servers";
import { LICENSE_INCLUDED_USERS, LICENSE_PLAN_PRICES } from "@openbot/contracts/license";
import type { AppFormat, AppTextKey } from "@openbot/i18n";
import {
  Badge,
  Button,
  Clock3,
  Gauge,
  HardDrive,
  RadioGroup,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Server,
  ShieldCheck,
  UsersRound,
} from "@openbot/ui";
import { RollingPrice } from "@openbot/ui/rolling-price";
import { For, Show } from "solid-js";
import { useText } from "../../text";

export type HostedServerPlanId = BillingPlanId;
export type HostedServerBilling = "monthly" | "yearly";

export const HOSTED_CURRENCIES = ["EUR", "USD", "PLN"] as const;
export type HostedCurrency = (typeof HOSTED_CURRENCIES)[number];

/** The Stripe currency of each shown currency. */
export const HOSTED_BILLING_CURRENCY = {
  EUR: "eur",
  USD: "usd",
  PLN: "pln",
} as const satisfies Record<HostedCurrency, BillingCurrency>;

/**
 * A first guess of the currency from the computer's time zone, for when the consumer does not know
 * the user's country. It reads only local settings and sends nothing.
 */
export function guessHostedCurrency(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): HostedCurrency {
  if (timeZone === "Europe/Warsaw") return "PLN";
  if (timeZone.startsWith("Europe/")) return "EUR";
  return "USD";
}

export interface HostedServerPlan {
  id: HostedServerPlanId;
  /**
   * The price for one month on monthly billing, in each currency. These are set prices, not
   * conversions, so each one is a round number.
   */
  monthlyPrice: Record<HostedCurrency, number>;
  /** The price for one year on yearly billing, in each currency. */
  yearlyPrice: Record<HostedCurrency, number>;
  diskGb: number;
  /** The most active members of the server, the owner included. */
  memberLimit: number;
  /** The speed compared with the smallest plan. 1 is the base speed. */
  relativeSpeed: number;
}

/**
 * How much less yearly billing costs than twelve monthly payments, in whole percent, from the prices of
 * the catalog. It is the smallest discount of the plans, so the text is true for each plan. 0 means no discount.
 */
export function hostedYearlyDiscountPercent(plans: readonly HostedServerPlan[], currency: HostedCurrency): number {
  const discounts = plans.map((plan) => {
    // In cents, so that the division does not get a floating point error such as 19.999.
    const twelveMonths = Math.round(plan.monthlyPrice[currency] * 100) * 12;
    const year = Math.round(plan.yearlyPrice[currency] * 100);
    return twelveMonths > 0 ? Math.floor(((twelveMonths - year) * 100) / twelveMonths) : 0;
  });
  return discounts.length === 0 ? 0 : Math.max(0, Math.min(...discounts));
}

/** The price for one month. On yearly billing this is the yearly price divided by 12. */
export function hostedPlanMonthlyPrice(
  plan: HostedServerPlan,
  billing: HostedServerBilling,
  currency: HostedCurrency,
): number {
  return billing === "yearly" ? plan.yearlyPrice[currency] / 12 : plan.monthlyPrice[currency];
}

/** The plans of the Stripe catalog. The catalog has amounts in cents; the plans show whole units. */
export function hostedServerPlansFromCatalog(catalog: HostedServerCatalog): HostedServerPlan[] {
  const amounts = (
    prices: HostedServerCatalog["plans"][number]["prices"],
    interval: "month" | "year",
  ): Record<HostedCurrency, number> => ({
    EUR: prices.eur[interval] / 100,
    USD: prices.usd[interval] / 100,
    PLN: prices.pln[interval] / 100,
  });
  return catalog.plans.map((plan) => ({
    id: plan.id,
    monthlyPrice: amounts(plan.prices, "month"),
    yearlyPrice: amounts(plan.prices, "year"),
    diskGb: plan.diskGb,
    memberLimit: plan.memberLimit,
    relativeSpeed: plan.relativeSpeed,
  }));
}

const PLAN_TEXT = {
  starter: { name: "settings.hostedServers.plan.starter.name", summary: "settings.hostedServers.plan.starter.summary" },
  standard: {
    name: "settings.hostedServers.plan.standard.name",
    summary: "settings.hostedServers.plan.standard.summary",
  },
  pro: { name: "settings.hostedServers.plan.pro.name", summary: "settings.hostedServers.plan.pro.summary" },
} as const satisfies Record<HostedServerPlanId, { name: AppTextKey; summary: AppTextKey }>;

const BILLING_OPTIONS: readonly HostedServerBilling[] = ["monthly", "yearly"];

interface HostedBillingSwitchProps {
  billing: HostedServerBilling;
  /** The yearly discount in whole percent. The switch does not show a discount of 0. */
  discountPercent: number;
  onChange: (billing: HostedServerBilling) => void;
  disabled?: boolean | undefined;
}

/** Monthly or yearly billing. The yearly option shows the discount. */
export function HostedBillingSwitch(props: HostedBillingSwitchProps) {
  const { t } = useText();
  return (
    <RadioGroup.Root
      class="hosted-billing"
      data-billing={props.billing}
      aria-label={t("server.add.billing.label")}
      value={props.billing}
      disabled={props.disabled ?? false}
      onChange={(value) => {
        const billing = BILLING_OPTIONS.find((option) => option === value);
        if (billing) props.onChange(billing);
      }}
    >
      <RadioGroup.Item class="hosted-billing-option" value="monthly">
        <RadioGroup.ItemInput />
        <RadioGroup.ItemControl class="hosted-billing-control">
          <RadioGroup.ItemLabel>{t("server.add.billing.monthly")}</RadioGroup.ItemLabel>
        </RadioGroup.ItemControl>
      </RadioGroup.Item>
      <RadioGroup.Item class="hosted-billing-option" value="yearly">
        <RadioGroup.ItemInput />
        <RadioGroup.ItemControl class="hosted-billing-control">
          <RadioGroup.ItemLabel>{t("server.add.billing.yearly")}</RadioGroup.ItemLabel>
          <Show when={props.discountPercent > 0}>
            <span class="hosted-billing-save">{t("server.add.billing.save", { percent: props.discountPercent })}</span>
          </Show>
        </RadioGroup.ItemControl>
      </RadioGroup.Item>
    </RadioGroup.Root>
  );
}

/** Kobalte takes a mutable array. */
const CURRENCY_OPTIONS: HostedCurrency[] = [...HOSTED_CURRENCIES];

interface HostedCurrencySelectProps {
  currency: HostedCurrency;
  onChange: (currency: HostedCurrency) => void;
  disabled?: boolean | undefined;
  /** The dialog element the popover portals into, so that it stays inside the dialog's focus trap. */
  mount?: HTMLElement | undefined;
}

/** The currency of the prices. The ISO code is the same in each language. */
export function HostedCurrencySelect(props: HostedCurrencySelectProps) {
  const { t } = useText();
  return (
    <Select<HostedCurrency>
      class="hosted-currency"
      options={CURRENCY_OPTIONS}
      value={props.currency}
      disabled={props.disabled ?? false}
      onChange={(currency) => currency && props.onChange(currency)}
      placement="bottom-start"
      sameWidth={false}
      itemComponent={(itemProps) => <SelectItem item={itemProps.item}>{itemProps.item.rawValue}</SelectItem>}
    >
      <SelectTrigger size="sm" aria-label={t("server.add.currency.label")}>
        <SelectValue<HostedCurrency>>{(state) => state.selectedOption()}</SelectValue>
      </SelectTrigger>
      <SelectContent mount={props.mount} />
    </Select>
  );
}

interface HostedServerPlansProps {
  plans: readonly HostedServerPlan[];
  billing: HostedServerBilling;
  currency: HostedCurrency;
  onChoose: (plan: HostedServerPlanId) => void;
  /** The plan that shows the "Best value" badge and the primary button. */
  recommended?: HostedServerPlanId | undefined;
  /** The plan whose button shows the loading state. All buttons are disabled while it is set. */
  pendingPlan?: HostedServerPlanId | null | undefined;
  /** Disables all buttons, such as when the account has the maximum number of servers. */
  disabled?: boolean | undefined;
}

/** A plan price: "zł 90" in place of "PLN 90", so that the old and the new price fit in a column. */
export function formatHostedPrice(format: AppFormat, value: number, currency: HostedCurrency): string {
  return format.number(value, {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

/**
 * The most characters that the old and the new yearly price of one plan have together, for example
 * 12 for "zł 440" and "zł 352". The dialog uses it to make the columns wide enough, so that the
 * price line does not break. It uses the yearly prices on both billings, so the width does not
 * change when the billing changes.
 */
export function hostedPriceLength(
  plans: readonly HostedServerPlan[],
  currency: HostedCurrency,
  format: AppFormat,
): number {
  return Math.max(
    0,
    ...plans.map(
      (plan) =>
        formatHostedPrice(format, plan.monthlyPrice[currency], currency).length +
        formatHostedPrice(format, hostedPlanMonthlyPrice(plan, "yearly", currency), currency).length,
    ),
  );
}

/** One column for each plan, in one panel. Each column has its own button, so one click creates the server. */
export function HostedServerPlans(props: HostedServerPlansProps) {
  const { t, format } = useText();
  const price = (value: number) => formatHostedPrice(format, value, props.currency);

  return (
    <ul class="hosted-plans" aria-label={t("settings.hostedServers.plan.label")}>
      <For each={props.plans}>
        {(plan, index) => {
          const recommended = () => plan.id === props.recommended;
          const yearly = () => props.billing === "yearly";
          const regular = () => plan.monthlyPrice[props.currency];
          const monthly = () => hostedPlanMonthlyPrice(plan, props.billing, props.currency);
          return (
            <li
              class="hosted-plan"
              data-recommended={recommended() ? "" : undefined}
              data-dimmed={props.pendingPlan != null && props.pendingPlan !== plan.id ? "" : undefined}
              style={{ "--plan-index": index() }}
            >
              <div class="hosted-plan-head">
                <h3 class="hosted-plan-name">{t(PLAN_TEXT[plan.id].name)}</h3>
                <Show when={recommended()}>
                  <Badge class="hosted-plan-badge" variant="outline">
                    {t("settings.hostedServers.plan.recommended")}
                  </Badge>
                </Show>
              </div>
              <p class="hosted-plan-price">
                {/* Always in the layout, so that it can grow in when the yearly price shows. */}
                <span
                  class="hosted-plan-was"
                  data-shown={yearly() ? "" : undefined}
                  aria-hidden={yearly() ? undefined : "true"}
                >
                  <span class="hosted-plan-was-inner">
                    <span class="sr-only">{t("server.add.regularPrice", { price: price(regular()) })}</span>
                    <s aria-hidden="true">{price(regular())}</s>
                  </span>
                </span>
                {/* The new price and "/ month" stay on one line. */}
                <span class="hosted-plan-now">
                  <RollingPrice value={monthly()} format={price} />
                  <span class="hosted-plan-period">{t("settings.hostedServers.plan.perMonth")}</span>
                </span>
              </p>
              {/* A new line for each billing period, so that it fades in again. */}
              <Show when={props.billing} keyed>
                {(billing) => (
                  <p class="hosted-plan-billed">
                    <Show when={billing === "yearly"} fallback={t("server.add.billedMonthly")}>
                      <span class="hosted-plan-billed-total">
                        {t("server.add.billedYearly", { price: price(monthly() * 12) })}
                      </span>
                      <span class="hosted-plan-saving">
                        {t("server.add.yearlySaving", { amount: price((regular() - monthly()) * 12) })}
                      </span>
                    </Show>
                  </p>
                )}
              </Show>
              <p class="hosted-plan-summary">{t(PLAN_TEXT[plan.id].summary)}</p>
              <Button
                class="hosted-plan-choose"
                variant={recommended() ? "default" : "secondary"}
                fullWidth
                loading={props.pendingPlan === plan.id}
                loadingLabel={t("settings.hostedServers.creating")}
                disabled={props.disabled || props.pendingPlan != null}
                onClick={() => props.onChoose(plan.id)}
              >
                {t("server.add.choosePlan", { plan: t(PLAN_TEXT[plan.id].name) })}
              </Button>
              <ul class="hosted-plan-facts">
                <li>
                  <Server aria-hidden="true" />
                  {t("settings.hostedServers.plan.linux")}
                </li>
                <li>
                  <Clock3 aria-hidden="true" />
                  {t("settings.hostedServers.plan.startsOnUse")}
                </li>
                <li>
                  <UsersRound aria-hidden="true" />
                  {t("settings.hostedServers.plan.members", { count: plan.memberLimit })}
                </li>
                <li>
                  <HardDrive aria-hidden="true" />
                  {t("settings.hostedServers.plan.disk", { count: plan.diskGb })}
                </li>
                <li>
                  <ShieldCheck aria-hidden="true" />
                  {/* A server too small for the Team license sells the Starter license, at the bundle price. */}
                  <Show
                    when={plan.memberLimit < LICENSE_INCLUDED_USERS}
                    fallback={t("settings.hostedServers.plan.license.team")}
                  >
                    {t("settings.hostedServers.plan.license.starter", {
                      price: price(
                        LICENSE_PLAN_PRICES.starter_bundle_month[HOSTED_BILLING_CURRENCY[props.currency]].base / 100,
                      ),
                    })}
                  </Show>
                </li>
                <li>
                  <Gauge aria-hidden="true" />
                  {plan.relativeSpeed === 1
                    ? t("settings.hostedServers.plan.speed.base")
                    : t("settings.hostedServers.plan.speed.faster", { factor: plan.relativeSpeed })}
                </li>
              </ul>
            </li>
          );
        }}
      </For>
    </ul>
  );
}
