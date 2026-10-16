import { parseOutsideUsageInput } from "@openbot/contracts/ipc";
import { OUTSIDE_USAGE_CAPABILITY, OUTSIDE_USAGE_ROUTES } from "@openbot/contracts/team-protocol/outside-usage-v1";
import { sourceText } from "@openbot/i18n/source";
import type { TeamApiAgents } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson } from "./request-helpers";

/**
 * The usage that the provider CLIs on this host logged for sessions OpenBot did not run. Any member can read it, as
 * any member can read `/v1/analytics`. Frozen by `outside-usage-v1`.
 */
export async function routeOutsideUsage(
  context: TeamApiRequestContext,
  agents: Pick<TeamApiAgents, "getOutsideUsage">,
): Promise<RouteOutcome> {
  const { method, url, capabilities, request, json } = context;
  if (method !== "POST" || url.pathname !== OUTSIDE_USAGE_ROUTES.read) return "unmatched";
  if (!capabilities.has(OUTSIDE_USAGE_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.outsideUsageUnsupported"));
  // `readJson` has already run the body through the outside-usage wire codec.
  return json(200, agents.getOutsideUsage(parseOutsideUsageInput(await readJson(request))));
}
