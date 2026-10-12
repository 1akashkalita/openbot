import { SIGN_IN_RELAY_CAPABILITY, SIGN_IN_RELAY_ROUTES } from "@openbot/contracts/team-protocol/sign-in-relay-v1";
import { sourceText } from "@openbot/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import { parseTestMcpServer } from "../ipc/mcp-inputs";
import type { TeamApiSignInRelay } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin, stringField } from "./request-helpers";

const ROUTES: ReadonlySet<string> = new Set(Object.values(SIGN_IN_RELAY_ROUTES));

/**
 * Sign-ins of this host that an administrator finishes in the browser of their own computer. Frozen
 * by `sign-in-relay-v1`.
 *
 * `complete` carries the query of the callback, which holds a grant. It travels only on the encrypted
 * Team channel, and `SignInRelayHost` never logs it. `requireAdmin` runs on every route, and a flow
 * answers only the member who started it.
 */
export async function routeSignInRelay(
  context: TeamApiRequestContext,
  relay: TeamApiSignInRelay | undefined,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json } = context;
  if (method !== "POST" || !ROUTES.has(url.pathname)) return "unmatched";
  if (!relay || !capabilities.has(SIGN_IN_RELAY_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.signInRelayUnsupported"));
  requireAdmin(member);
  // `readJson` has already run the body through the `sign-in-relay-v1` codec.
  const body = await readJson(request);
  switch (url.pathname) {
    case SIGN_IN_RELAY_ROUTES.mcpStart:
      return json(200, await runCauseEffect(relay.startMcp(member.id, parseTestMcpServer(body))));
    case SIGN_IN_RELAY_ROUTES.status:
      return json(200, relay.status(member.id, stringField(body, "flowId")));
    case SIGN_IN_RELAY_ROUTES.complete:
      return json(200, relay.complete(member.id, stringField(body, "flowId"), stringField(body, "query", true, 8_192)));
    default:
      relay.cancel(member.id, stringField(body, "flowId"));
      return json(200, {});
  }
}
