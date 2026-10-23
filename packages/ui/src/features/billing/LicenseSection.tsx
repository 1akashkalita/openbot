import {
  type BillingCurrency,
  type BillingInterval,
  type BillingSubscriptionStatus,
  isOpenBillingStatus,
} from "@openbot/contracts/billing";
import {
  LICENSE_DEVICES_PER_USER,
  LICENSE_INCLUDED_USERS,
  LICENSE_MAX_USERS,
  LICENSE_YEAR_DISCOUNT_PERCENT,
  type License,
  type LicenseCheckoutRequest,
  type LicensePlan,
  type LicenseState,
  type LicenseTier,
  type LicenseUser,
  licenseIncludedUsers,
  licensePeriodAmount,
  licensePlanOf,
  licensePlanPrice,
} from "@openbot/contracts/license";
import type { AppFormat, AppTextKey } from "@openbot/i18n";
import {
  Alert,
  AlertActions,
  AlertContent,
  AlertDescription,
  AlertIcon,
  Badge,
  Button,
  buttonVariants,
  ConfirmDialog,
  CreditCard,
  DropdownMenu,
  Ellipsis,
  IconButton,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
  Minus,
  OctagonX,
  Plus,
  RotateCcw,
  SettingsSection,
  ShieldCheck,
  SliderField,
  SlidersHorizontal,
  SlidingTabs,
  Spinner,
  Text,
  TriangleAlert,
  UsersRound,
  Zap,
} from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, For, Match, Show, Switch, untrack } from "solid-js";
import { useText } from "../../text";
import {
  guessHostedCurrency,
  HOSTED_BILLING_CURRENCY,
  HostedBillingSwitch,
  type HostedCurrency,
  HostedCurrencySelect,
} from "../servers/HostedServerPricing";
import type { LicenseStore } from "./license-store";

export interface LicenseSectionProps {
  store: LicenseStore;
  /** Opens the Stripe Customer Portal of the account, where the owner changes the payment method. */
  onManagePayment?: (() => void) | undefined;
  /** Opens the sales contact, for a team with more than `LICENSE_MAX_USERS` users. */
  onContactUs?: (() => void) | undefined;
}

/** A price in minor units. A whole amount shows no cents. */
export function formatLicenseMoney(format: AppFormat, amount: number, currency: BillingCurrency): string {
  return format.number(amount / 100, {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
  });
}

/** The fewest users that the owner can set: the included users, or the people who use the license now. */
export function licenseMinimumUsers(state: LicenseState): number {
  return Math.min(LICENSE_MAX_USERS, Math.max(LICENSE_INCLUDED_USERS, state.used));
}

/** The statuses that show a badge. An active license shows none. */
const STATUS_BADGE: Partial<
  Record<BillingSubscriptionStatus, { text: AppTextKey; variant: "info-light" | "destructive-light" | "warning-light" }>
> = {
  trialing: { text: "billing.status.trialing", variant: "info-light" },
  past_due: { text: "billing.status.paymentFailed", variant: "destructive-light" },
  unpaid: { text: "billing.status.paymentFailed", variant: "destructive-light" },
  paused: { text: "billing.status.paused", variant: "warning-light" },
};

function paymentFailed(license: License): boolean {
  return license.status === "past_due" || license.status === "unpaid";
}

/** True for the Starter tier at either price: 1 user, and no users to change. */
function isOneUser(license: License): boolean {
  return licensePlanOf(license).tier !== "team";
}

const TIER_TITLE = {
  starter: "billing.license.tier.starter.title",
  server: "billing.license.tier.starter.title",
  team: "billing.license.tier.team.title",
} as const satisfies Record<LicenseTier, AppTextKey>;

/**
 * The License part of Billing: the commercial license of the account, above the server plans. It
 * shows nothing until the account server says that it sells licenses, so an older account server, or
 * one with no license price, shows the Billing panel as before.
 */
export function LicenseSection(props: LicenseSectionProps): JSX.Element {
  const { t } = useText();
  const [changing, setChanging] = createSignal(false);
  const [planning, setPlanning] = createSignal(false);
  const [listing, setListing] = createSignal(false);
  const [cancelling, setCancelling] = createSignal(false);
  const state = () => props.store.state.license;
  const open = () => {
    const license = state()?.license;
    return license && isOpenBillingStatus(license.status) ? license : null;
  };

  return (
    <Show when={state()?.available ? state() : null}>
      {(current) => (
        <>
          <SettingsSection title={t("billing.license.title")} description={t("billing.license.description")}>
            <div class="billing-license">
              <Show when={props.store.state.actionError}>
                {(message) => (
                  <Alert tone="danger" role="alert">
                    <AlertIcon>
                      <TriangleAlert aria-hidden="true" />
                    </AlertIcon>
                    <AlertContent>
                      <AlertDescription>{message()}</AlertDescription>
                    </AlertContent>
                  </Alert>
                )}
              </Show>
              <Show when={open()}>
                {(license) => (
                  <LicenseAlerts
                    license={license()}
                    used={current().used}
                    store={props.store}
                    onChangeUsers={() => (isOneUser(license()) ? setPlanning(true) : setChanging(true))}
                    onManagePayment={props.onManagePayment}
                  />
                )}
              </Show>
              <Show
                when={open()}
                fallback={<LicenseOffer state={current()} store={props.store} onContactUs={props.onContactUs} />}
              >
                {(license) => (
                  <ActiveLicenseRow
                    license={license()}
                    used={current().used}
                    pending={props.store.state.pending}
                    onShowUsers={() => setListing(true)}
                    onChangeUsers={() => setChanging(true)}
                    onChangePlan={() => setPlanning(true)}
                    onManagePayment={props.onManagePayment}
                    onCancel={() => setCancelling(true)}
                    onRenew={() => void props.store.setRenewal(false)}
                  />
                )}
              </Show>
            </div>
          </SettingsSection>
          <hr class="billing-license-divider" />
          <Show when={changing() ? open() : null}>
            {(license) => (
              <ChangeUsersDialog
                license={license()}
                minimum={licenseMinimumUsers(current())}
                used={current().used}
                store={props.store}
                onContactUs={props.onContactUs}
                onClose={() => setChanging(false)}
              />
            )}
          </Show>
          <Show when={planning() ? open() : null}>
            {(license) => (
              <ChangePlanDialog
                license={license()}
                minimum={licenseMinimumUsers(current())}
                store={props.store}
                onClose={() => setPlanning(false)}
              />
            )}
          </Show>
          <Show when={listing() ? open() : null}>
            {(license) => (
              <LicenseUsersDialog users={current().users} license={license()} onClose={() => setListing(false)} />
            )}
          </Show>
          <Show when={open()}>
            {(license) => (
              <ConfirmDialog
                open={cancelling()}
                onCancel={() => {
                  setCancelling(false);
                  props.store.track("cancel_kept");
                }}
                title={t("billing.license.cancel.title")}
                description={<CancelDescription license={license()} />}
                confirmLabel={t("billing.license.action.cancel")}
                cancelLabel={t("billing.license.cancel.keep")}
                pending={props.store.state.pending === "renewal"}
                onConfirm={async () => {
                  if (await props.store.setRenewal(true)) setCancelling(false);
                }}
              />
            )}
          </Show>
        </>
      )}
    </Show>
  );
}

function CancelDescription(props: { license: License }): JSX.Element {
  const { t, format } = useText();
  return (
    <Show when={props.license.currentPeriodEnd} fallback={t("billing.license.cancel.descriptionNow")}>
      {(end) => t("billing.license.cancel.description", { date: format.date(end(), { dateStyle: "long" }) })}
    </Show>
  );
}

/** The failed payment and the over-limit warnings of an open license. */
function LicenseAlerts(props: {
  license: License;
  used: number;
  store: LicenseStore;
  onChangeUsers: () => void;
  onManagePayment: (() => void) | undefined;
}): JSX.Element {
  const { t } = useText();
  createEffect(
    () => props.used > props.license.users,
    (overLimit) => {
      if (overLimit) props.store.track("over_limit_shown");
    },
  );
  return (
    <>
      <Show when={paymentFailed(props.license)}>
        <Alert tone="warning">
          <AlertIcon>
            <TriangleAlert aria-hidden="true" />
          </AlertIcon>
          <AlertContent>
            <AlertDescription>{t("billing.license.paymentFailed")}</AlertDescription>
          </AlertContent>
          <Show when={props.onManagePayment}>
            {(manage) => (
              <AlertActions>
                <Button type="button" size="sm" onClick={() => manage()()}>
                  {t("billing.action.updatePayment")}
                </Button>
              </AlertActions>
            )}
          </Show>
        </Alert>
      </Show>
      <Show when={props.used > props.license.users}>
        <Alert tone="warning">
          <AlertIcon>
            <TriangleAlert aria-hidden="true" />
          </AlertIcon>
          <AlertContent>
            <AlertDescription>
              {isOneUser(props.license)
                ? t("billing.license.overLimitOneUser", { used: props.used })
                : t("billing.license.overLimit", { used: props.used, users: props.license.users })}
            </AlertDescription>
          </AlertContent>
          <AlertActions>
            <Button
              type="button"
              size="sm"
              disabled={props.store.state.pending !== null}
              onClick={() => props.onChangeUsers()}
            >
              {isOneUser(props.license)
                ? t("billing.license.action.changeToTeam")
                : t("billing.license.action.changeUsers")}
            </Button>
          </AlertActions>
        </Alert>
      </Show>
    </>
  );
}

function LicenseIcon(): JSX.Element {
  return (
    <ItemMedia>
      <span class="billing-license-icon">
        <ShieldCheck aria-hidden="true" />
      </span>
    </ItemMedia>
  );
}

/** The open license of the account: tier, users, renewal date, price, and the actions menu. */
function ActiveLicenseRow(props: {
  license: License;
  used: number;
  pending: string | null;
  onShowUsers: () => void;
  onChangeUsers: () => void;
  onChangePlan: () => void;
  onManagePayment: (() => void) | undefined;
  onCancel: () => void;
  onRenew: () => void;
}): JSX.Element {
  const { t, format } = useText();
  const badge = () => STATUS_BADGE[props.license.status];
  const plan = () => licensePlanOf(props.license);
  const price = () => {
    if (plan().interval === "month") {
      return t("billing.server.price.month", {
        amount: formatLicenseMoney(format, props.license.amount, props.license.currency),
      });
    }
    const amount = licensePeriodAmount(plan(), props.license.users, props.license.currency);
    return t("billing.server.price.year", { amount: formatLicenseMoney(format, amount, props.license.currency) });
  };
  const periodEnd = () => {
    const end = props.license.currentPeriodEnd;
    if (end === null) return null;
    const date = format.date(end, { dateStyle: "long" });
    return props.license.cancelAtPeriodEnd ? t("billing.server.ends", { date }) : t("billing.server.renews", { date });
  };
  return (
    <ItemGroup class="billing-license-row">
      <Item>
        <LicenseIcon />
        <ItemContent>
          <div class="billing-server-title">
            <ItemTitle>{t(TIER_TITLE[plan().tier])}</ItemTitle>
            <Show when={badge()}>{(item) => <Badge variant={item().variant}>{t(item().text)}</Badge>}</Show>
          </div>
          <ItemDescription>
            {t("billing.license.work.used", {
              used: format.number(props.used),
              users: format.number(props.license.users),
            })}
          </ItemDescription>
          <Show when={periodEnd()}>{(line) => <ItemDescription>{line()}</ItemDescription>}</Show>
        </ItemContent>
        <ItemActions>
          <Text as="span" variant="label" class="billing-server-price">
            {price()}
          </Text>
          <Show when={props.pending}>
            <Spinner size="sm" label={t("billing.license.saving")} />
          </Show>
          <DropdownMenu.Root placement="bottom-end" gutter={4}>
            <DropdownMenu.Trigger
              class={buttonVariants({ variant: "ghost", size: "icon-sm" })}
              aria-label={t("billing.license.action.menu")}
              disabled={props.pending !== null}
            >
              <Ellipsis aria-hidden="true" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content>
                <DropdownMenu.Item onSelect={() => props.onShowUsers()}>
                  <UsersRound aria-hidden="true" />
                  {t("billing.license.action.users")}
                </DropdownMenu.Item>
                <Show when={plan().tier === "team"}>
                  <DropdownMenu.Item onSelect={() => props.onChangeUsers()}>
                    <SlidersHorizontal aria-hidden="true" />
                    {t("billing.license.action.changeUsers")}
                  </DropdownMenu.Item>
                </Show>
                <Show when={plan().tier !== "team" || plan().interval === "month"}>
                  <DropdownMenu.Item onSelect={() => props.onChangePlan()}>
                    <Zap aria-hidden="true" />
                    {plan().tier === "team"
                      ? t("billing.license.action.changeToYear")
                      : t("billing.license.action.changeToTeam")}
                  </DropdownMenu.Item>
                </Show>
                <Show when={props.onManagePayment}>
                  {(manage) => (
                    <DropdownMenu.Item onSelect={() => manage()()}>
                      <CreditCard aria-hidden="true" />
                      {t("billing.action.updatePayment")}
                    </DropdownMenu.Item>
                  )}
                </Show>
                <Show
                  when={!props.license.cancelAtPeriodEnd}
                  fallback={
                    <DropdownMenu.Item onSelect={() => props.onRenew()}>
                      <RotateCcw aria-hidden="true" />
                      {t("billing.license.action.renew")}
                    </DropdownMenu.Item>
                  }
                >
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item class="ui-action-menu-danger" onSelect={() => props.onCancel()}>
                    <OctagonX aria-hidden="true" />
                    {t("billing.license.action.cancel")}
                  </DropdownMenu.Item>
                </Show>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </ItemActions>
      </Item>
    </ItemGroup>
  );
}

/**
 * The row of an account with no open license: personal use, an ended license, or the license of a
 * server owner that covers this account. "Buy a license" opens the lower part of the same card.
 */
function LicenseOffer(props: {
  state: LicenseState;
  store: LicenseStore;
  onContactUs: (() => void) | undefined;
}): JSX.Element {
  const { t, format } = useText();
  const [buying, setBuying] = createSignal(false);
  const ended = () => {
    const license = props.state.license;
    return license?.currentPeriodEnd ? license.currentPeriodEnd : null;
  };
  const owners = () => props.state.coveredBy.map((coverage) => coverage.ownerName ?? coverage.ownerEmail);
  return (
    <ItemGroup class="billing-license-row">
      <Item>
        <LicenseIcon />
        <Switch>
          <Match when={owners().length > 0}>
            <ItemContent>
              <ItemTitle>{t("billing.license.covered.title")}</ItemTitle>
              <ItemDescription>
                {t("billing.license.covered.description", { owners: format.list(owners()) })}
              </ItemDescription>
            </ItemContent>
          </Match>
          <Match when>
            <ItemContent>
              <div class="billing-server-title">
                <ItemTitle>{t("billing.license.personal.title")}</ItemTitle>
                <Show when={ended()}>
                  <Badge variant="secondary">{t("billing.license.status.ended")}</Badge>
                </Show>
              </div>
              <ItemDescription>{t("billing.license.personal.description")}</ItemDescription>
              <Show when={ended()}>
                {(end) => (
                  <ItemDescription>
                    {t("billing.license.ended", { date: format.date(end(), { dateStyle: "long" }) })}
                  </ItemDescription>
                )}
              </Show>
            </ItemContent>
          </Match>
        </Switch>
        <Show when={!buying()}>
          <ItemActions>
            <Button
              type="button"
              size="sm"
              variant={owners().length > 0 ? "outline" : "default"}
              aria-expanded="false"
              onClick={() => {
                setBuying(true);
                props.store.track("buy_opened");
              }}
            >
              {t("billing.license.buy")}
            </Button>
          </ItemActions>
        </Show>
      </Item>
      <Show when={buying()}>
        <LicenseBuy
          locked={props.state.currency}
          used={props.state.used}
          serverPrice={props.state.serverPrice ?? false}
          store={props.store}
          onContactUs={props.onContactUs}
          onClose={() => setBuying(false)}
        />
      </Show>
    </ItemGroup>
  );
}

/** The choices of the buy form. Starter is monthly only. */
const BUY_CHOICES = ["starter", "team_month", "team_year"] as const;
type BuyChoice = (typeof BUY_CHOICES)[number];

/**
 * The lower part of the license card: the tier, the users and the price, the license terms, and the
 * actions. Starter is for 1 user, so it is not available when more people use the owner's servers.
 */
function LicenseBuy(props: {
  locked: BillingCurrency | null;
  used: number;
  /** The account pays for a Starter server, so Starter costs the lower `server` price. */
  serverPrice: boolean;
  store: LicenseStore;
  onContactUs: (() => void) | undefined;
  onClose: () => void;
}): JSX.Element {
  const { t, format } = useText();
  const starterAllowed = () => props.used <= 1;
  const [choice, setChoice] = createSignal<BuyChoice>(untrack(() => (props.used <= 1 ? "starter" : "team_month")));
  const [users, setUsers] = createSignal(LICENSE_INCLUDED_USERS);
  const [chosen, setChosen] = createSignal<HostedCurrency>(guessHostedCurrency());
  // A Stripe customer pays all its subscriptions in one currency.
  const currency = () => props.locked ?? HOSTED_BILLING_CURRENCY[chosen()];
  const checkingOut = () => props.store.state.pending === "checkout";
  const plan = (): LicensePlan => {
    const current = choice();
    if (current === "starter") return { tier: props.serverPrice ? "server" : "starter", interval: "month" };
    return { tier: "team", interval: current === "team_year" ? "year" : "month" };
  };
  const count = () => (plan().tier === "team" ? users() : 1);
  return (
    <section class="billing-license-buy" aria-label={t("billing.license.buy")}>
      <SlidingTabs.Root
        value={choice()}
        onChange={(value) => {
          const next = BUY_CHOICES.find((option) => option === value);
          if (next) setChoice(next);
        }}
      >
        <SlidingTabs.List aria-label={t("billing.license.tier.label")}>
          <SlidingTabs.Trigger value="starter" disabled={!starterAllowed()}>
            {t("billing.license.tier.starter.name")}
          </SlidingTabs.Trigger>
          <SlidingTabs.Trigger value="team_month">{t("billing.license.tier.team.name")}</SlidingTabs.Trigger>
          <SlidingTabs.Trigger value="team_year">{t("billing.license.tier.teamYear.name")}</SlidingTabs.Trigger>
        </SlidingTabs.List>
      </SlidingTabs.Root>
      <div class="billing-license-buy-line">
        <div class="billing-license-buy-users">
          <Text as="span" variant="label">
            {t("billing.license.users.label")}
          </Text>
          <Show
            when={plan().tier === "team"}
            fallback={
              <Text as="span" variant="label" class="billing-license-stepper-value">
                {format.number(1)}
              </Text>
            }
          >
            <UserStepper users={users()} onChange={setUsers} />
          </Show>
        </div>
        <div class="billing-license-buy-price">
          <div class="billing-license-buy-total">
            <Show when={!props.locked}>
              <HostedCurrencySelect currency={chosen()} onChange={setChosen} disabled={checkingOut()} />
            </Show>
            <Text as="span" variant="label" class="billing-server-price">
              <PeriodPrice plan={plan()} users={count()} currency={currency()} />
            </Text>
          </div>
          <Text as="span" variant="caption" tone="muted">
            <Breakdown plan={plan()} users={count()} currency={currency()} />
          </Text>
        </div>
      </div>
      <div class="billing-license-notes">
        <Text variant="caption" tone="muted">
          {t("billing.license.devices", { count: LICENSE_DEVICES_PER_USER })}
        </Text>
        <Show when={plan().tier === "server"}>
          <Text variant="caption" tone="muted">
            {t("billing.license.serverPrice")}
          </Text>
        </Show>
        <Show when={plan().interval === "year"}>
          <Text variant="caption" tone="muted">
            {t("billing.license.yearSaving", { percent: LICENSE_YEAR_DISCOUNT_PERCENT })}
          </Text>
        </Show>
        <Show when={!starterAllowed()}>
          <Text variant="caption" tone="muted">
            {t("billing.license.starter.inUse", { used: format.number(props.used) })}
          </Text>
        </Show>
      </div>
      <div class="billing-license-buy-line">
        <ContactLine onContactUs={props.onContactUs} />
        <div class="billing-license-actions">
          <Button type="button" size="sm" variant="ghost" disabled={checkingOut()} onClick={() => props.onClose()}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={props.store.state.pending !== null}
            aria-busy={checkingOut() ? "true" : undefined}
            onClick={async () => {
              const request: LicenseCheckoutRequest = {
                users: count(),
                currency: currency(),
                tier: choice() === "starter" ? "starter" : "team",
                interval: plan().interval,
              };
              if (await props.store.openCheckout(request)) props.onClose();
            }}
          >
            {checkingOut() ? t("billing.opening") : t("billing.license.checkout")}
          </Button>
        </div>
      </div>
    </section>
  );
}

/** "€30 / month" or "€864 / year": the amount of one period. */
function PeriodPrice(props: { plan: LicensePlan; users: number; currency: BillingCurrency }): JSX.Element {
  const { t, format } = useText();
  const amount = () =>
    formatLicenseMoney(format, licensePeriodAmount(props.plan, props.users, props.currency), props.currency);
  return (
    <Show when={props.plan.interval === "year"} fallback={t("billing.server.price.month", { amount: amount() })}>
      {t("billing.server.price.year", { amount: amount() })}
    </Show>
  );
}

/** "€80 + 3 × €15", or "5 users included" at the minimum. */
function Breakdown(props: { plan: LicensePlan; users: number; currency: BillingCurrency }): JSX.Element {
  const { t, format } = useText();
  const included = () => licenseIncludedUsers(props.plan.tier);
  const extra = () => props.users - included();
  const price = () => licensePlanPrice(props.plan, props.currency);
  return (
    <Show when={extra() > 0} fallback={t("billing.license.included", { count: included() })}>
      {t("billing.license.breakdown", {
        base: formatLicenseMoney(format, price().base, props.currency),
        extra: format.number(extra()),
        price: formatLicenseMoney(format, price().extraUser, props.currency),
      })}
    </Show>
  );
}

/** Minus, the number, and plus. */
function UserStepper(props: { users: number; onChange: (users: number) => void }): JSX.Element {
  const { t, format } = useText();
  return (
    <fieldset class="billing-license-stepper" aria-label={t("billing.license.users.label")}>
      <IconButton
        label={t("billing.license.users.remove")}
        variant="outline"
        size="icon-sm"
        disabled={props.users <= LICENSE_INCLUDED_USERS}
        onClick={() => props.onChange(props.users - 1)}
      >
        <Minus />
      </IconButton>
      <output class="billing-license-stepper-value" aria-live="polite">
        {format.number(props.users)}
      </output>
      <IconButton
        label={t("billing.license.users.add")}
        variant="outline"
        size="icon-sm"
        disabled={props.users >= LICENSE_MAX_USERS}
        onClick={() => props.onChange(props.users + 1)}
      >
        <Plus />
      </IconButton>
    </fieldset>
  );
}

function ContactLine(props: { onContactUs: (() => void) | undefined }): JSX.Element {
  const { t } = useText();
  return (
    <Text variant="caption" tone="muted">
      {t("billing.license.contact.question", { count: LICENSE_MAX_USERS })}{" "}
      <Show when={props.onContactUs}>
        {(contact) => (
          <Button type="button" variant="link" size="xs" class="billing-license-link" onClick={() => contact()()}>
            {t("billing.license.contact.action")}
          </Button>
        )}
      </Show>
    </Text>
  );
}

/** The price lines of a plan for a number of users, and the total of one period. */
function Quote(props: { plan: LicensePlan; users: number; currency: BillingCurrency }): JSX.Element {
  const { t, format } = useText();
  const included = () => licenseIncludedUsers(props.plan.tier);
  const extra = () => props.users - included();
  const price = () => licensePlanPrice(props.plan, props.currency);
  const money = (amount: number) => formatLicenseMoney(format, amount, props.currency);
  return (
    <div class="billing-license-quote">
      <dl class="billing-license-lines">
        <div>
          <dt>{t("billing.license.line.base", { count: included() })}</dt>
          <dd>{money(price().base)}</dd>
        </div>
        <Show when={extra() > 0}>
          <div>
            <dt>
              {t("billing.license.line.extra", { extra: format.number(extra()), price: money(price().extraUser) })}
            </dt>
            <dd>{money(extra() * price().extraUser)}</dd>
          </div>
        </Show>
      </dl>
      <p class="billing-license-total">
        <span class="billing-license-total-amount">
          {money(licensePeriodAmount(props.plan, props.users, props.currency))}
        </span>
        <Text as="span" variant="caption" tone="muted">
          {props.plan.interval === "year"
            ? t("billing.license.total.year", { currency: props.currency.toUpperCase() })
            : t("billing.license.total.month", { currency: props.currency.toUpperCase() })}
        </Text>
      </p>
    </div>
  );
}

/** The value after the maximum means "more than 25 users". */
const SLIDER_MAX = LICENSE_MAX_USERS + 1;

/**
 * Changes the users of the open license. The minimum is the people who use it now. More users bill
 * the difference for the rest of the period now; fewer users take effect on the next invoice.
 */
function ChangeUsersDialog(props: {
  license: License;
  minimum: number;
  used: number;
  store: LicenseStore;
  onContactUs: (() => void) | undefined;
  onClose: () => void;
}): JSX.Element {
  const { t, format } = useText();
  const [users, setUsers] = createSignal(untrack(() => Math.max(props.license.users, props.minimum)));
  const contact = () => users() > LICENSE_MAX_USERS;
  const money = (amount: number) => formatLicenseMoney(format, amount, props.license.currency);
  return (
    <ConfirmDialog
      open
      tone="default"
      icon={<UsersRound />}
      title={t("billing.license.change.title")}
      description={t("billing.license.change.description", {
        users: format.number(props.license.users),
        amount: money(props.license.amount),
      })}
      confirmLabel={contact() ? t("billing.license.contact.action") : t("common.save")}
      pendingLabel={t("billing.license.saving")}
      pending={props.store.state.pending === "users"}
      error={props.store.state.actionError ?? undefined}
      onCancel={() => {
        props.store.clearActionError();
        props.onClose();
      }}
      onConfirm={async () => {
        if (contact()) {
          props.onContactUs?.();
          return;
        }
        if (users() === props.license.users || (await props.store.setUsers(users()))) props.onClose();
      }}
    >
      <div class="billing-license-change">
        <SliderField
          label={t("billing.license.users.label")}
          value={users()}
          minValue={props.minimum}
          maxValue={SLIDER_MAX}
          disabled={props.store.state.pending !== null}
          formatValue={(value) =>
            value > LICENSE_MAX_USERS
              ? t("billing.license.change.more", { count: LICENSE_MAX_USERS })
              : format.number(value)
          }
          onChange={setUsers}
        />
        <Show when={props.used > LICENSE_INCLUDED_USERS}>
          <Text variant="caption" tone="muted">
            {t("billing.license.change.minimum", { used: format.number(props.used) })}
          </Text>
        </Show>
        <Show
          when={!contact()}
          fallback={
            <div class="billing-license-quote">
              <p class="billing-license-total">
                <span class="billing-license-total-amount">{t("billing.license.change.custom")}</span>
              </p>
              <Text variant="caption" tone="muted">
                {t("billing.license.change.customDescription", { count: LICENSE_MAX_USERS })}
              </Text>
            </div>
          }
        >
          <Quote plan={licensePlanOf(props.license)} users={users()} currency={props.license.currency} />
          <Show when={users() !== props.license.users}>
            <Text variant="caption" tone="muted">
              <Switch>
                <Match when={users() < props.license.users}>{t("billing.license.change.decrease")}</Match>
                <Match when={licensePlanOf(props.license).interval === "year"}>
                  {t("billing.license.change.increaseYear")}
                </Match>
                <Match when>{t("billing.license.change.increase")}</Match>
              </Switch>
            </Text>
          </Show>
        </Show>
      </div>
    </ConfirmDialog>
  );
}

/**
 * Moves a Starter license to Team, or a monthly Team license to yearly. The account server bills the
 * difference now. It sells no other change: to go down, the owner cancels and buys again.
 */
function ChangePlanDialog(props: {
  license: License;
  minimum: number;
  store: LicenseStore;
  onClose: () => void;
}): JSX.Element {
  const { t, format } = useText();
  const toTeam = () => isOneUser(props.license);
  const [interval, setInterval] = createSignal<BillingInterval>(untrack(() => (toTeam() ? "month" : "year")));
  const [users, setUsers] = createSignal(untrack(() => Math.max(props.license.users, props.minimum)));
  const plan = (): LicensePlan => ({ tier: "team", interval: interval() });
  return (
    <ConfirmDialog
      open
      tone="default"
      icon={<Zap />}
      title={toTeam() ? t("billing.license.action.changeToTeam") : t("billing.license.action.changeToYear")}
      description={
        toTeam()
          ? t("billing.license.plan.teamDescription", { min: LICENSE_INCLUDED_USERS, max: LICENSE_MAX_USERS })
          : t("billing.license.plan.yearDescription", { percent: LICENSE_YEAR_DISCOUNT_PERCENT })
      }
      confirmLabel={t("billing.license.plan.confirm")}
      pendingLabel={t("billing.license.saving")}
      pending={props.store.state.pending === "plan"}
      error={props.store.state.actionError ?? undefined}
      onCancel={() => {
        props.store.clearActionError();
        props.onClose();
      }}
      onConfirm={async () => {
        if (await props.store.changePlan({ interval: interval(), users: users() })) props.onClose();
      }}
    >
      <div class="billing-license-change">
        <Show when={toTeam()}>
          <HostedBillingSwitch
            billing={interval() === "year" ? "yearly" : "monthly"}
            discountPercent={LICENSE_YEAR_DISCOUNT_PERCENT}
            disabled={props.store.state.pending !== null}
            onChange={(billing) => setInterval(billing === "yearly" ? "year" : "month")}
          />
        </Show>
        <SliderField
          label={t("billing.license.users.label")}
          value={users()}
          minValue={props.minimum}
          maxValue={LICENSE_MAX_USERS}
          disabled={props.store.state.pending !== null}
          formatValue={(value) => format.number(value)}
          onChange={setUsers}
        />
        <Quote plan={plan()} users={users()} currency={props.license.currency} />
        <Text variant="caption" tone="muted">
          {t("billing.license.plan.charge")}
        </Text>
      </div>
    </ConfirmDialog>
  );
}

/** Who uses the license: the owner and each member of the owner's servers. */
function LicenseUsersDialog(props: { users: LicenseUser[]; license: License; onClose: () => void }): JSX.Element {
  const { t, format } = useText();
  return (
    <ConfirmDialog
      open
      tone="default"
      hideCancel
      icon={<UsersRound />}
      title={t("billing.license.users.title")}
      description={t("billing.license.users.description", {
        used: format.number(props.users.length),
        users: format.number(props.license.users),
      })}
      confirmLabel={t("common.close")}
      onCancel={() => props.onClose()}
      onConfirm={() => props.onClose()}
    >
      <ItemGroup class="billing-license-users" role="list">
        <For each={props.users}>
          {(user) => (
            <Item role="listitem" size="compact">
              <ItemContent>
                <div class="billing-server-title">
                  <ItemTitle>{user.name ?? user.email}</ItemTitle>
                  <Show when={user.owner}>
                    <Badge variant="secondary">{t("billing.license.users.owner")}</Badge>
                  </Show>
                </div>
                <Show when={user.name}>
                  <ItemDescription>{user.email}</ItemDescription>
                </Show>
                <Show when={user.servers.length > 0}>
                  <ItemDescription>{format.list(user.servers)}</ItemDescription>
                </Show>
              </ItemContent>
            </Item>
          )}
        </For>
      </ItemGroup>
    </ConfirmDialog>
  );
}
