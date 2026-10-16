import {
  assertOutsideUsageScope,
  decodeOutsideUsageReport,
  type OutsideUsageInput,
  type OutsideUsageReport,
} from "@openbot/contracts/ipc";
import { OUTSIDE_USAGE_CAPABILITY, OUTSIDE_USAGE_ROUTES } from "@openbot/contracts/team-protocol/outside-usage-v1";
import { Effect } from "effect";
import { AnalyticsRequestError } from "./agent-analytics";

/** The host's usage outside OpenBot, or null when the host does not advertise `outside-usage-v1`. */
export const readOutsideUsage = Effect.fn("TeamClient.readOutsideUsage")(function* (
  request: <T>(method: "POST", path: string, decode: (value: unknown) => T, body: OutsideUsageInput) => Promise<T>,
  capabilities: readonly string[],
  input: OutsideUsageInput,
): Effect.fn.Return<OutsideUsageReport | null, AnalyticsRequestError> {
  if (!capabilities.includes(OUTSIDE_USAGE_CAPABILITY)) return null;
  const body = { startDate: input.startDate, endDate: input.endDate, timeZone: input.timeZone };
  return yield* Effect.tryPromise({
    try: () =>
      request(
        "POST",
        OUTSIDE_USAGE_ROUTES.read,
        (value) => assertOutsideUsageScope(decodeOutsideUsageReport(value), body),
        body,
      ),
    catch: (cause) => new AnalyticsRequestError({ cause }),
  });
});
