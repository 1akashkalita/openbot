// The host half of `sign-in-relay-v1`: sign-ins that an administrator starts on this host and finishes
// in the browser of their own computer.

import { randomBytes } from "node:crypto";
import type { McpTestResult, TestMcpServerInput } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { registerSecretValue } from "@openbot/logging";
import { Effect } from "effect";
import type { McpHostSignIns } from "./mcp-host-sign-ins";
import { HttpError } from "./team-api/http-error";

/** How long a flow can complete. The sign-in on this host has its own, equal deadline. */
export const SIGN_IN_RELAY_TTL_MS = 10 * 60_000;
/** Flows kept at one time. A new flow above this ends the oldest. */
const FLOW_LIMIT = 16;
/** The names a loopback callback can use. Any other address is not a callback on this host. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Where the sign-in page sends the browser back to, on this host. The client listens on the same port. */
export interface SignInRelayCallback {
  port: number;
  path: string;
  state: string | null;
}

/** What `status` and `complete` answer, as `sign-in-relay-v1` sends it. */
export interface SignInRelayView {
  authorizeUrl: string | null;
  callback: SignInRelayCallback | null;
  result: McpTestResult | null;
}

/** The part of a flow that differs by kind of sign-in. */
interface RelayTarget {
  /** One sign-in runs for each key; a new flow for the same key replaces the old one. */
  key: string;
  status: () => { pageUrl: string | null; result: McpTestResult | null };
  /** Gives the callback to the sign-in that waits for it, and answers whether one took it. */
  deliver: (query: URLSearchParams) => boolean;
  cancel: () => void;
}

interface Flow {
  memberId: string;
  expiresAt: number;
  target: RelayTarget;
  completed: boolean;
}

export interface SignInRelayHostDependencies {
  mcp: Pick<McpHostSignIns, "startRelay" | "relayStatus" | "cancel">;
  /** Gives an MCP grant to the sign-in on this host that waits for `state`, as the loopback listener does. */
  receiveMcpGrant: (state: string, code: string) => boolean;
  now?: () => number;
}

/**
 * The flows of relayed sign-ins.
 *
 * The client sends only the query of the callback. This host takes the rest of the callback from the
 * page address that its own sign-in made, so a client cannot choose a port or a path here. A flow
 * completes once, only for the member who started it, and ends at `expiresAt`. An unknown flow, an
 * expired flow and the flow of another member get the same answer, so the answer tells nothing about
 * the flows of other members.
 */
export class SignInRelayHost {
  readonly #dependencies: SignInRelayHostDependencies;
  readonly #now: () => number;
  readonly #flows = new Map<string, Flow>();

  constructor(dependencies: SignInRelayHostDependencies) {
    this.#dependencies = dependencies;
    this.#now = dependencies.now ?? Date.now;
  }

  /** Starts the MCP sign-in of `input` with no tab, and returns its flow at once. */
  startMcp(memberId: string, input: TestMcpServerInput) {
    return this.#startMcp(memberId, input);
  }

  readonly #startMcp = Effect.fn("SignInRelayHost.startMcp")(function* (
    this: SignInRelayHost,
    memberId: string,
    input: TestMcpServerInput,
  ) {
    const { mcp, receiveMcpGrant } = this.#dependencies;
    yield* mcp.startRelay(input);
    const url = input.config.url;
    return this.#open(memberId, {
      key: `mcp\n${url}`,
      status: () => mcp.relayStatus(url),
      deliver: (query) => {
        const state = query.get("state");
        const code = query.get("code");
        if (!state || !code) return false;
        registerSecretValue(code);
        return receiveMcpGrant(state, code);
      },
      cancel: () => mcp.cancel(url),
    });
  });

  status(memberId: string, flowId: string): SignInRelayView {
    return view(this.#flow(memberId, flowId));
  }

  /** Delivers the callback query of a flow. The client then reads `status` until the sign-in ends. */
  complete(memberId: string, flowId: string, query: string): SignInRelayView {
    const flow = this.#flow(memberId, flowId);
    if (flow.completed) throw new HttpError(409, sourceText("error.team.signInRelayUsed"));
    const current = view(flow);
    if (current.result) return current;
    const params = new URLSearchParams(query);
    // A callback for another sign-in, or for a page this flow has not shown yet, is not this one.
    const state = current.authorizeUrl ? new URL(current.authorizeUrl).searchParams.get("state") : null;
    if (!state || params.get("state") !== state) throw new HttpError(400, sourceText("error.team.signInRelayMismatch"));
    flow.completed = true;
    // The user refused on the sign-in page. Nothing comes after it, so the sign-in ends here.
    if (params.has("error")) {
      flow.target.cancel();
      return view(flow);
    }
    if (!flow.target.deliver(params)) throw new HttpError(400, sourceText("error.team.signInRelayMismatch"));
    return view(flow);
  }

  cancel(memberId: string, flowId: string): void {
    const flow = this.#flow(memberId, flowId);
    this.#flows.delete(flowId);
    if (!flow.target.status().result) flow.target.cancel();
  }

  #open(memberId: string, target: RelayTarget): { flowId: string; expiresAt: number } {
    this.#expire();
    // The new sign-in replaced the old one of the same key, so the old flow has nothing left to relay.
    for (const [id, flow] of this.#flows) if (flow.target.key === target.key) this.#flows.delete(id);
    for (const [id, flow] of this.#flows) {
      if (this.#flows.size < FLOW_LIMIT) break;
      this.#flows.delete(id);
      flow.target.cancel();
    }
    const flowId = randomBytes(16).toString("hex");
    const expiresAt = this.#now() + SIGN_IN_RELAY_TTL_MS;
    this.#flows.set(flowId, { memberId, expiresAt, target, completed: false });
    return { flowId, expiresAt };
  }

  #flow(memberId: string, flowId: string): Flow {
    this.#expire();
    const flow = this.#flows.get(flowId);
    if (!flow || flow.memberId !== memberId) throw new HttpError(404, sourceText("error.team.signInRelayUnknown"));
    return flow;
  }

  #expire(): void {
    const now = this.#now();
    for (const [id, flow] of this.#flows) {
      if (flow.expiresAt > now) continue;
      this.#flows.delete(id);
      if (!flow.target.status().result) flow.target.cancel();
    }
  }
}

function view(flow: Flow): SignInRelayView {
  const { pageUrl, result } = flow.target.status();
  return { authorizeUrl: pageUrl, callback: pageUrl ? loopbackCallback(pageUrl) : null, result };
}

/**
 * The loopback address that the page sends the browser back to, or `null`. A sign-in that returns to
 * another address, such as `openbot://`, has no callback to listen for: the client can then only send
 * an address that the user pastes.
 */
export function loopbackCallback(pageUrl: string): SignInRelayCallback | null {
  try {
    const page = new URL(pageUrl);
    const redirect = page.searchParams.get("redirect_uri");
    if (!redirect) return null;
    const target = new URL(redirect);
    if (target.protocol !== "http:" || !LOOPBACK_HOSTS.has(target.hostname) || !target.port) return null;
    return { port: Number(target.port), path: target.pathname, state: page.searchParams.get("state") };
  } catch {
    return null;
  }
}
