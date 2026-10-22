import { BILLING_CURRENCIES, type BillingCurrency, type BillingInterval } from "@openbot/contracts/billing";
import type { HostedServerCatalogPlan } from "@openbot/contracts/hosted-servers";
import { LICENSE_INCLUDED_USERS, LICENSE_MAX_USERS, licenseAmount } from "@openbot/contracts/license";
import { createDigitRoll } from "@openbot/ui/digit-roll";
import { cx, prefersReducedMotion } from "@openbot/ui/utils";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, onSettled, Show, untrack } from "solid-js";
import { landingAnalytics } from "../../lib/analytics";
import {
  EU_VAT_PERCENT,
  formatMoney,
  LICENSE_BUNDLE_DISCOUNT,
  licenseMonthlyPrice,
  PRICING_ROUTE,
  type PricingOffer,
  planMonthlyPrice,
  STARTER_LICENSE_MONTHLY,
} from "../../lib/pricing-page";
import { LandingBeam } from "../landing/LandingBeam";
import { LandingFooter } from "../landing/LandingFooter";
import { LandingGlow } from "../landing/LandingGlow";
import { SiteHeader } from "../landing/SiteHeader";
import { ButtonLink } from "../ui/button";
import type { PricingPageText } from "./pricing-page-text";
import "./PricingPage.css";

const CURRENCY_LABEL: Record<BillingCurrency, string> = { eur: "EUR", usd: "USD", pln: "PLN" };

/**
 * Like loot rarity in a game: a bigger order gives a faster beam in a rarer colour. The laser palette
 * has no green or yellow, so the steps are silver, sky, blue, violet, pink and orange.
 */
const RARITY = [
  { color: "#9aa3b8", rgb: "154, 163, 184", pace: 0.55 },
  { color: "#38a8ff", rgb: "56, 168, 255", pace: 0.8 },
  { color: "#3847ff", rgb: "56, 71, 255", pace: 1.05 },
  { color: "#a46cf5", rgb: "164, 108, 245", pace: 1.3 },
  { color: "#ec4899", rgb: "236, 72, 153", pace: 1.6 },
  { color: "#ff6a2b", rgb: "255, 106, 43", pace: 1.9 },
] as const;

type LicenseChoice = "none" | "starter" | "team";

/** A license moves the colour: Standard with the Team license is pink, and Pro with it is orange. */
const LICENSE_RARITY_STEPS: Record<LicenseChoice, number> = { none: 0, starter: 1, team: 2 };

function isDigit(character: string) {
  return /\d/u.test(character);
}

/**
 * A money amount whose digits roll to each new value, as the app's hosted server prices do. They fall when the
 * amount goes down and rise when it goes up. Assistive technology reads the plain text.
 */
function RollingAmount(props: { value: number; currency: BillingCurrency }) {
  const roll = createDigitRoll(() => props.value, { settleMs: 0, animate: () => !prefersReducedMotion() });
  let previous = untrack(roll.displayed);
  const direction = createMemo(() => {
    const next = roll.displayed();
    const result = next < previous ? -1 : 1;
    previous = next;
    return result;
  });
  const characters = () => formatMoney(roll.displayed(), props.currency).split("");
  // The last two digits trail the others, so the digit that changes most lands last.
  const stagger = (index: number) => {
    const digits = characters().flatMap((character, position) => (isDigit(character) ? [position] : []));
    if (index === digits.at(-1)) return "2";
    if (index === digits.at(-2)) return "1";
    return undefined;
  };
  return (
    <>
      <span class="landing-visually-hidden">{formatMoney(props.value, props.currency)}</span>
      <span ref={roll.ref} class="pricing-digits" style={{ "--pricing-digit-dir": direction() }} aria-hidden="true">
        <For each={characters()} keyed={false}>
          {(character, index) => (
            <span
              class={isDigit(character()) ? "pricing-digit" : undefined}
              data-stagger={isDigit(character()) ? stagger(index) : undefined}
            >
              {character()}
            </span>
          )}
        </For>
      </span>
    </>
  );
}

function Price(props: { children: JSX.Element; unit?: string | undefined; class?: string }) {
  return (
    <p class={cx("pricing-price", props.class)}>
      <span class="pricing-price-amount">{props.children}</span>
      <Show when={props.unit}>{(unit) => <span class="pricing-price-unit">{unit()}</span>}</Show>
    </p>
  );
}

/** A pill switch. The pill slides to the pressed option; every column has the same width. */
function Segment<T extends string>(props: {
  label: string;
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const index = () =>
    Math.max(
      0,
      props.options.findIndex((option) => option.id === props.value),
    );
  return (
    <fieldset class="pricing-segment" style={{ "--pricing-count": props.options.length, "--pricing-index": index() }}>
      <legend class="landing-visually-hidden">{props.label}</legend>
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            aria-pressed={option.id === props.value ? "true" : "false"}
            onClick={() => props.onChange(option.id)}
          >
            {option.label}
          </button>
        )}
      </For>
    </fieldset>
  );
}

/** The beam's position as a share of the page width: the centre of `surface`, clear of its corners. */
function beamPosition(surface: HTMLElement): number {
  const box = surface.getBoundingClientRect();
  const margin = Math.min(48, box.width / 4);
  const x = Math.min(box.right - margin, Math.max(box.left + margin, box.left + box.width / 2));
  return x / document.documentElement.clientWidth;
}

/**
 * The beam on the order form. It mounts only after the first measurement of the form, because the laser can
 * stop drawing frames on a slow device and then would not show a later position. It measures again when the
 * page changes size.
 */
function MeasuredBeam(props: {
  surface: () => HTMLElement | undefined;
  onImpact: () => void;
  tint: () => string;
  pace: () => number;
}) {
  const [position, setPosition] = createSignal<number | undefined>();
  onSettled(() => {
    const measure = () => {
      const surface = props.surface();
      if (surface) setPosition(beamPosition(surface));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(document.documentElement);
    return () => observer.disconnect();
  });
  return (
    <Show when={position()}>
      {(beam) => (
        <LandingBeam
          surface={props.surface}
          beamPosition={beam()}
          color={untrack(props.tint)}
          tint={props.tint}
          pace={props.pace}
          onImpact={props.onImpact}
        />
      )}
    </Show>
  );
}

/** One row of a radio group. Extra content, such as the members stepper, goes under the label. */
function ChoiceRow(props: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  title: string;
  badge?: string | undefined;
  /** A green pill by the title, such as the bundle discount. */
  saving?: string | undefined;
  detail: string;
  price: number;
  /** The price without the yearly discount. In yearly billing it shows struck through. */
  fullPrice?: number;
  currency: BillingCurrency;
  unit?: string | undefined;
  children?: JSX.Element;
}) {
  return (
    <div class="pricing-choice">
      <label>
        <input type="radio" name={props.name} checked={props.checked} onChange={() => props.onSelect()} />
        <span class="pricing-choice-dot" aria-hidden="true" />
        <span class="pricing-row-name">
          <strong>{props.title}</strong>
          <Show when={props.badge}>{(badge) => <span class="pricing-badge">{badge()}</span>}</Show>
          <Show when={props.saving}>
            {(saving) => (
              <span class="pricing-yearly pricing-saving" data-active="">
                {saving()}
              </span>
            )}
          </Show>
          <span>{props.detail}</span>
        </span>
        <Price unit={props.unit}>
          <Show when={props.fullPrice}>
            {(full) => (
              <span class="pricing-was" data-shown={full() > props.price ? "" : undefined} aria-hidden="true">
                <span>
                  <s>{formatMoney(full(), props.currency)}</s>
                </span>
              </span>
            )}
          </Show>
          <RollingAmount value={props.price} currency={props.currency} />
        </Price>
      </label>
      {props.children}
    </div>
  );
}

function MemberStepper(props: { text: PricingPageText["license"]; value: number; onChange: (value: number) => void }) {
  return (
    <fieldset class="pricing-stepper">
      <legend class="landing-visually-hidden">{props.text.members}</legend>
      <button
        type="button"
        aria-label={props.text.fewer}
        disabled={props.value <= LICENSE_INCLUDED_USERS}
        onClick={() => props.onChange(props.value - 1)}
      >
        −
      </button>
      <span aria-live="polite">{props.text.memberCount[props.value]}</span>
      <button
        type="button"
        aria-label={props.text.more}
        disabled={props.value >= LICENSE_MAX_USERS}
        onClick={() => props.onChange(props.value + 1)}
      >
        +
      </button>
    </fieldset>
  );
}

/** A summary line that opens and closes. While it closes, it keeps the text that it had when it was open. */
function SummaryLine(props: {
  open: boolean;
  label: string;
  value: number;
  currency: BillingCurrency;
  minus?: boolean;
}) {
  let last = untrack(() => ({ label: props.label, value: props.value }));
  const shown = createMemo(() => {
    if (props.open) last = { label: props.label, value: props.value };
    return last;
  });
  return (
    <li
      class="pricing-summary-line"
      data-open={props.open ? "" : undefined}
      data-minus={props.minus ? "" : undefined}
      aria-hidden={props.open ? undefined : "true"}
    >
      <div>
        <div>
          <span>{shown().label}</span>
          <span>
            {props.minus ? "−" : ""}
            <RollingAmount value={shown().value} currency={props.currency} />
          </span>
        </div>
      </div>
    </li>
  );
}

/**
 * The pricing page: one order form with a hosted server on the left and the license on the right, one summary
 * under both, and one button. The beam's colour and speed follow the size of the order.
 */
export function PricingPage(props: { text: PricingPageText; offer: PricingOffer; lang: string }) {
  const [interval, setInterval] = createSignal<BillingInterval>("month");
  const [currency, setCurrency] = createSignal<BillingCurrency>("eur");
  const plans = () => props.offer.plans;
  // Standard is the default. Users and server members are the same people, so the Team license starts
  // with every member of the server.
  const standard = untrack(() => {
    const plan = plans().find((item) => item.id === "standard");
    return plan ? { id: plan.id, memberLimit: plan.memberLimit } : undefined;
  });
  const [serverId, setServerId] = createSignal<string>(standard?.id ?? "none");
  const [license, setLicense] = createSignal<LicenseChoice>("team");
  const licensed = () => license() !== "none";
  const [members, setMembers] = createSignal(
    Math.min(LICENSE_MAX_USERS, Math.max(LICENSE_INCLUDED_USERS, standard?.memberLimit ?? 0)),
  );
  const [struck, setStruck] = createSignal(false);
  let frame: HTMLDivElement | undefined;

  onSettled(() => landingAnalytics.start(document, window.location.hostname, PRICING_ROUTE));

  const server = (): HostedServerCatalogPlan | undefined => plans().find((plan) => plan.id === serverId());
  const serverText = (plan: HostedServerCatalogPlan) => props.text.server.plans.find((entry) => entry.id === plan.id);
  const isYearly = () => interval() === "year";
  const serverCost = () => {
    const plan = server();
    return plan ? planMonthlyPrice(plan, interval(), currency()) : 0;
  };
  /** The monthly price of the chosen server. In yearly billing the summary takes the discount off as its own line. */
  const serverFull = () => {
    const plan = server();
    return plan ? planMonthlyPrice(plan, "month", currency()) : 0;
  };
  /** The monthly price of a license. In yearly billing the summary takes the discount off as its own line. */
  const licenseMonthly = (choice: LicenseChoice) => {
    if (choice === "starter") return STARTER_LICENSE_MONTHLY[currency()];
    return choice === "team" ? licenseAmount(members(), currency()) : 0;
  };
  const licenseFull = () => licenseMonthly(license());
  const licenseCost = () => licenseMonthlyPrice(licenseFull(), interval());
  /** What a license saves with any server. Each license row shows its price less this amount. */
  const bundleOff = (choice: "starter" | "team") => (server() ? LICENSE_BUNDLE_DISCOUNT[choice][currency()] : 0);
  const bundleSaving = (choice: "starter" | "team") =>
    server() ? props.text.license.bundleSaving[choice][currency()] : undefined;
  const discount = () => {
    const choice = license();
    return choice === "none" ? 0 : bundleOff(choice);
  };
  const subtotal = () => serverCost() + licenseCost() - discount();
  const vat = () => (props.offer.inEu ? Math.round((subtotal() * EU_VAT_PERCENT) / 100) : 0);
  const total = () => subtotal() + vat();
  const buying = () => server() !== undefined || licensed();
  const unit = () => (isYearly() ? props.text.unit.monthBilledYearly : props.text.unit.month);
  const pickServer = (plan: HostedServerCatalogPlan) => {
    setServerId(plan.id);
    setMembers(Math.min(LICENSE_MAX_USERS, Math.max(LICENSE_INCLUDED_USERS, plan.memberLimit)));
  };
  const rarity = () => {
    const size = plans().findIndex((plan) => plan.id === serverId()) + 1;
    const step = size + LICENSE_RARITY_STEPS[license()];
    return RARITY[Math.min(RARITY.length - 1, step)] ?? RARITY[0];
  };

  return (
    <div class="landing-page pricing-page" lang={props.lang}>
      <SiteHeader page="landing" />
      <main>
        {/* The accent colour of the whole hero follows the beam. */}
        <section
          class="landing-hero pricing-hero"
          aria-labelledby="pricing-title"
          style={{ "--pricing-beam": rarity().rgb }}
        >
          <MeasuredBeam
            surface={() => frame}
            onImpact={() => setStruck(true)}
            tint={() => rarity().color}
            pace={() => rarity().pace}
          />
          <div class="pricing-split">
            <div class="landing-section-heading pricing-heading">
              <h1 id="pricing-title">{props.text.heading}</h1>
            </div>
            <div class="pricing-controls">
              <Segment
                label={props.text.billing}
                options={[
                  { id: "month", label: props.text.monthly },
                  { id: "year", label: props.text.yearly },
                ]}
                value={interval()}
                onChange={setInterval}
              />
              <Segment
                label={props.text.currency}
                options={BILLING_CURRENCIES.map((id) => ({ id, label: CURRENCY_LABEL[id] }))}
                value={currency()}
                onChange={setCurrency}
              />
            </div>
          </div>

          <div ref={frame} class="pricing-frame" data-struck={struck() ? "" : undefined}>
            <section class="pricing-half" aria-labelledby="pricing-servers">
              <div class="pricing-half-title">
                <h2 id="pricing-servers">{props.text.server.title}</h2>
                <span class="pricing-yearly" data-active={isYearly() ? "" : undefined}>
                  {props.text.server.yearlySaving[currency()]}
                </span>
              </div>
              <p class="pricing-half-summary">{props.text.server.summary}</p>
              <div class="pricing-choices" role="radiogroup" aria-labelledby="pricing-servers">
                <ChoiceRow
                  name="pricing-server"
                  checked={serverId() === "none"}
                  onSelect={() => setServerId("none")}
                  title={props.text.server.none}
                  detail={props.text.server.noneDetail}
                  price={0}
                  currency={currency()}
                />
                <For each={plans()}>
                  {(plan) => (
                    <ChoiceRow
                      name="pricing-server"
                      checked={serverId() === plan.id}
                      onSelect={() => pickServer(plan)}
                      title={serverText(plan)?.name ?? plan.id}
                      badge={plan.id === "standard" ? props.text.server.bestValue : undefined}
                      detail={serverText(plan)?.detail ?? ""}
                      price={planMonthlyPrice(plan, interval(), currency())}
                      fullPrice={planMonthlyPrice(plan, "month", currency())}
                      currency={currency()}
                      unit={unit()}
                    />
                  )}
                </For>
              </div>
            </section>

            <section class="pricing-half" aria-labelledby="pricing-license">
              <div class="pricing-half-title">
                <h2 id="pricing-license">{props.text.license.title}</h2>
                <span class="pricing-yearly" data-active={isYearly() ? "" : undefined}>
                  {props.text.license.yearlySaving}
                </span>
              </div>
              <p class="pricing-half-summary">{props.text.license.summary}</p>
              <div class="pricing-choices" role="radiogroup" aria-labelledby="pricing-license">
                <ChoiceRow
                  name="pricing-license"
                  checked={license() === "none"}
                  onSelect={() => setLicense("none")}
                  title={props.text.license.none}
                  detail={props.text.license.noneDetail}
                  price={0}
                  currency={currency()}
                />
                <ChoiceRow
                  name="pricing-license"
                  checked={license() === "starter"}
                  onSelect={() => setLicense("starter")}
                  title={props.text.license.starter}
                  saving={bundleSaving("starter")}
                  detail={props.text.license.starterDetail}
                  price={licenseMonthlyPrice(licenseMonthly("starter"), interval()) - bundleOff("starter")}
                  fullPrice={licenseMonthly("starter")}
                  currency={currency()}
                  unit={unit()}
                />
                <ChoiceRow
                  name="pricing-license"
                  checked={license() === "team"}
                  onSelect={() => setLicense("team")}
                  title={props.text.license.team}
                  saving={bundleSaving("team")}
                  detail={props.text.license.teamDetail[interval()][currency()]}
                  price={licenseMonthlyPrice(licenseMonthly("team"), interval()) - bundleOff("team")}
                  fullPrice={licenseMonthly("team")}
                  currency={currency()}
                  unit={unit()}
                >
                  <MemberStepper
                    text={props.text.license}
                    value={members()}
                    onChange={(value) => {
                      setMembers(value);
                      setLicense("team");
                    }}
                  />
                </ChoiceRow>
              </div>
            </section>

            <section class="pricing-summary" aria-labelledby="pricing-summary">
              <h2 id="pricing-summary" class="landing-visually-hidden">
                {props.text.summary.title}
              </h2>
              {/* Each part sits under its own half: the server on the left, the license on the right. */}
              <ul class="pricing-summary-lines pricing-summary-server">
                <SummaryLine
                  open={server() !== undefined}
                  label={(() => {
                    const plan = server();
                    return plan ? (serverText(plan)?.summary ?? "") : "";
                  })()}
                  value={serverFull()}
                  currency={currency()}
                />
                <SummaryLine
                  open={server() !== undefined && isYearly()}
                  label={props.text.summary.yearlyDiscount[currency()]}
                  value={serverFull() - serverCost()}
                  currency={currency()}
                  minus
                />
              </ul>
              <ul class="pricing-summary-lines pricing-summary-license">
                <SummaryLine
                  open={licensed()}
                  label={
                    license() === "starter"
                      ? props.text.license.starterSummary
                      : (props.text.license.summaryLine[members()] ?? "")
                  }
                  value={licenseFull()}
                  currency={currency()}
                />
                <SummaryLine
                  open={licensed() && isYearly()}
                  label={props.text.summary.licenseYearlyDiscount}
                  value={licenseFull() - licenseCost()}
                  currency={currency()}
                  minus
                />
                <SummaryLine
                  open={discount() > 0}
                  label={props.text.summary.bundleDiscount}
                  value={discount()}
                  currency={currency()}
                  minus
                />
              </ul>
              <ul class="pricing-summary-lines pricing-summary-personal">
                <SummaryLine open={!buying()} label={props.text.summary.personal} value={0} currency={currency()} />
              </ul>
              <ul class="pricing-summary-lines pricing-summary-vat">
                <SummaryLine open={vat() > 0} label={props.text.summary.vat} value={vat()} currency={currency()} />
              </ul>
              <div class="pricing-summary-total">
                <span class="pricing-summary-total-label">{props.text.summary.total}</span>
                <Price unit={buying() ? unit() : props.text.unit.free}>
                  <RollingAmount value={total()} currency={currency()} />
                </Price>
                <Show
                  when={buying()}
                  fallback={
                    <ButtonLink to="/download" variant="secondary" size="md" icon="download" class="pricing-cta">
                      {props.text.cta.download}
                    </ButtonLink>
                  }
                >
                  {/* A full page load, as the header's App link. The web app reads `start` after sign-in and opens
                      the add server dialog or Billing. The app sells each product in its own flow, so each
                      chosen product has its own button. */}
                  <Show when={server()}>
                    <ButtonLink
                      to="/app"
                      search={{ start: "server" }}
                      reloadDocument
                      variant="primary"
                      size="md"
                      icon="arrow-right"
                      class="pricing-cta"
                    >
                      {props.text.cta.server}
                    </ButtonLink>
                  </Show>
                  <Show when={licensed()}>
                    <ButtonLink
                      to="/app"
                      search={{ start: "license" }}
                      reloadDocument
                      variant={server() ? "secondary" : "primary"}
                      size="md"
                      icon="arrow-right"
                      class="pricing-cta"
                    >
                      {props.text.cta.license}
                    </ButtonLink>
                  </Show>
                </Show>
              </div>
            </section>
          </div>

          <section class="pricing-enterprise" aria-labelledby="pricing-enterprise">
            <div>
              <h2 id="pricing-enterprise">{props.text.enterprise.title}</h2>
              <p class="pricing-half-summary">{props.text.enterprise.body}</p>
            </div>
            <ButtonLink to="/contact" variant="secondary" size="md" icon="contact">
              {props.text.enterprise.contact}
            </ButtonLink>
          </section>
        </section>
      </main>
      <LandingFooter />
      <LandingGlow />
    </div>
  );
}
