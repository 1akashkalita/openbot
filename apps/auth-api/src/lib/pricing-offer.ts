import { createServerFn } from "@tanstack/solid-start";
import { isEuCountry, type PricingOffer } from "./pricing-page";

/**
 * Reads what the pricing page sells. It runs on the Worker: the server prices are Stripe Prices, and
 * the country is the `CF-IPCountry` header. The imports are inside the handler, so the browser bundle
 * never holds `cloudflare:workers`, and a test that imports the route does not load the Start server.
 *
 * When the prices do not load, the page still shows the license, so this logs the failure and gives no plans.
 */
export const readPricingOffer = createServerFn({ method: "GET" }).handler(async (): Promise<PricingOffer> => {
  const [{ getRequestHeader }, { requestBillingService }, { runApiEffect }, { BillingError }] = await Promise.all([
    import("@tanstack/solid-start/server"),
    import("../server/request-auth"),
    import("../server/effect-runtime"),
    import("../server/billing-errors"),
  ]);
  const inEu = isEuCountry(getRequestHeader("cf-ipcountry"));
  const billing = requestBillingService();
  if (!billing) return { plans: null, inEu };
  try {
    const catalog = await runApiEffect(billing.catalog());
    return { plans: catalog.plans, inEu };
  } catch (error) {
    console.warn("pricing: server prices did not load", error instanceof BillingError ? error.code : "unexpected");
    return { plans: null, inEu };
  }
});
