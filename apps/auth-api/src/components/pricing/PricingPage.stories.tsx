import { BILLING_PLANS, type BillingCurrency } from "@openbot/contracts/billing";
import type { HostedServerCatalogPlan } from "@openbot/contracts/hosted-servers";
import { translateFor } from "@openbot/i18n";
import type { JSX } from "@solidjs/web";
import { createRootRoute, createRoute, createRouter, RouterContextProvider } from "@tanstack/solid-router";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
// The site's stylesheet, loaded only when a site story opens. See `ArticleMedia.stories.tsx`.
import "../../styles.css";
import { PricingPage } from "./PricingPage";
import { pricingPageText } from "./pricing-page-text";

/** The monthly list prices of the Stripe bootstrap, in minor units. A year costs twelve months less 20%. */
const MONTHLY: Record<BillingCurrency, readonly number[]> = {
  eur: [2000, 5000, 10000],
  usd: [2500, 6000, 12000],
  pln: [9000, 22000, 44000],
};

const PLANS: HostedServerCatalogPlan[] = BILLING_PLANS.map((plan, index) => {
  const price = (currency: BillingCurrency) => {
    const month = MONTHLY[currency][index] ?? 0;
    return { month, year: Math.round(month * 12 * 0.8) };
  };
  return {
    id: plan.id,
    diskGb: plan.storageGb,
    memberLimit: plan.memberLimit,
    relativeSpeed: plan.relativeSpeed,
    prices: { eur: price("eur"), usd: price("usd"), pln: price("pln") },
  };
});

/**
 * The header and footer links need a router. The real route tree carries Worker-only modules, so this is
 * a small stand-in tree with the paths that the page links to. It is built at module level:
 * creating a router writes reactive state, which Solid refuses inside a component.
 */
const rootRoute = createRootRoute();
rootRoute.addChildren(
  [
    "/",
    "/news",
    "/guides",
    "/plugins",
    "/download",
    "/changelog",
    "/compare",
    "/compare/$slug",
    "/providers",
    "/providers/$slug",
    "/teams",
    "/pricing",
    "/contact",
    "/app",
  ].map((path) => createRoute({ getParentRoute: () => rootRoute, path })),
);
const router = createRouter({ routeTree: rootRoute });

function WithRouter(props: { children: () => JSX.Element }) {
  return <RouterContextProvider router={router}>{props.children}</RouterContextProvider>;
}

const meta = {
  title: "Site/Pricing page",
  component: PricingPage,
  args: { text: pricingPageText(translateFor("en"), PLANS), offer: { plans: PLANS, inEu: false }, lang: "en" },
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
  render: (args) => <WithRouter>{() => <PricingPage {...args} />}</WithRouter>,
} satisfies Meta<typeof PricingPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A visitor outside the EU: no VAT line. */
export const OutsideEu: Story = {};

/** A visitor in the EU: the summary adds 23% VAT. */
export const InEu: Story = {
  args: { offer: { plans: PLANS, inEu: true } },
};

/** The server prices did not load from Stripe. The page still sells the license. */
export const ServerPricesMissing: Story = {
  args: { text: pricingPageText(translateFor("en"), null), offer: { plans: null, inEu: false } },
};
