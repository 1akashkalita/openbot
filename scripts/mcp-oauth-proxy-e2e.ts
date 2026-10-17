// Runs the real McpOAuthProxy and McpOAuth against a fake MCP server on this computer whose access
// tokens stop working before their stated expiry, as in issue #2376. It checks that:
// - each provider configuration (Claude, ACP, Codex) holds the proxy address and secret, not a token;
// - a request without the proxy secret, or with a wrong one, is refused;
// - a refused token is renewed one time and the request is sent again one time with the same body;
// - two requests refused at the same time share one renewal;
// - an event stream passes through as it arrives, and a request the provider abandons ends upstream;
// - a renewal that fails gives the 401 back once, with no loop;
// - no access token, refresh token or proxy secret is in a log line.
// bun scripts/mcp-oauth-proxy-e2e.ts
// Writes .openbot-build/mcp-oauth-proxy-e2e/report.json. Uses no network outside 127.0.0.1.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { z } from "zod";

// The proxy writes its renewal line at `info`; read before the loggers are made.
process.env.OPENBOT_LOG_LEVEL = "debug";

const { Effect } = await import("effect");
const { teeLogLines } = await import("@openbot/logging");
const { McpOAuth } = await import("../src/backend/mcp-oauth-provider");
const { McpOAuthProxy, mcpOAuthHandoff } = await import("../src/backend/mcp-oauth-proxy");
const { acpMcpServers, claudeMcpServers, codexMcpServers, usableMcpServers } = await import(
  "../src/backend/mcp-provider-shapes"
);

type McpOAuthRecord = import("../src/backend/mcp-oauth-provider").McpOAuthRecord;
type McpServerConfig = import("@openbot/contracts/ipc").McpServerConfig;

const OUT = resolve(import.meta.dirname, "../.openbot-build/mcp-oauth-proxy-e2e");
/** A guard against a hang only. Every wait below ends on an event first. */
const STEP_DEADLINE_MS = 15_000;

const checks: { name: string; passed: boolean; detail: string }[] = [];
function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}

const logLines: string[] = [];
const stopTee = teeLogLines(["mcp-oauth-proxy", "mcp-oauth"], (line) => logLines.push(line));

function secret(label: string): string {
  return `${label}-${randomBytes(18).toString("base64url")}`;
}

// ---- The fake server: protected resource, authorization server and MCP endpoint in one ----------

interface Upstream {
  /** The tokens the server accepts now. A token leaves this set before its `expires_in` ends. */
  valid: Set<string>;
  /** The refresh token the server accepts next. Each refresh rotates it. */
  refreshToken: string;
  refuseRefresh: boolean;
  refreshes: number;
  /** Every authorization header and body that reached `/mcp`, for the checks. */
  requests: { authorization: string | null; body: string }[];
  /** Every token that the server issued, for the leak checks. */
  issued: string[];
  /** Released by the client when it has read the first event, so the second one can follow. */
  releaseSecondEvent: (() => void) | null;
  /** Set when an open GET event stream loses its client. */
  streamClosed: Promise<void>;
  markStreamClosed: () => void;
}

const firstToken = secret("access-1");
const firstRefresh = secret("refresh-1");
let markStreamClosed = () => {};
const upstream: Upstream = {
  valid: new Set(),
  refreshToken: firstRefresh,
  refuseRefresh: false,
  refreshes: 0,
  requests: [],
  issued: [firstToken, firstRefresh],
  releaseSecondEvent: null,
  streamClosed: new Promise<void>((done) => {
    markStreamClosed = done;
  }),
  markStreamClosed: () => markStreamClosed(),
};

function readAll(request: IncomingMessage): Promise<string> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    request.on("error", fail);
  });
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

let base = "";
const rpcMessage = z.object({ id: z.number(), method: z.string() });

async function serveUpstream(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = new URL(request.url ?? "/", base).pathname;
  if (path.startsWith("/.well-known/oauth-protected-resource")) {
    return json(response, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
  }
  if (path === "/.well-known/oauth-authorization-server") {
    return json(response, 200, {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
    });
  }
  if (path === "/token") {
    const form = new URLSearchParams(await readAll(request));
    upstream.refreshes += 1;
    if (
      upstream.refuseRefresh ||
      form.get("grant_type") !== "refresh_token" ||
      form.get("refresh_token") !== upstream.refreshToken
    ) {
      return json(response, 400, { error: "invalid_grant" });
    }
    const access = secret(`access-${upstream.refreshes + 1}`);
    const refresh = secret(`refresh-${upstream.refreshes + 1}`);
    upstream.issued.push(access, refresh);
    upstream.valid = new Set([access]);
    upstream.refreshToken = refresh;
    return json(response, 200, {
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refresh,
    });
  }
  if (path !== "/mcp") return json(response, 404, { error: "not_found" });
  const authorization = request.headers.authorization ?? null;
  const body = request.method === "POST" ? await readAll(request) : "";
  upstream.requests.push({ authorization, body });
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!upstream.valid.has(token)) {
    return json(
      response,
      401,
      { error: "invalid_token" },
      {
        "www-authenticate": `Bearer error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
      },
    );
  }
  if (request.method === "GET") {
    // The server-to-client event stream. It stays open until the client leaves.
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write(": open\n\n");
    response.on("close", () => upstream.markStreamClosed());
    return;
  }
  const message = rpcMessage.parse(JSON.parse(body));
  if (message.method === "tools/call") {
    // Two events with a wait between them that only the client can end: a proxy that collects the
    // answer before it writes would never deliver the first, and the client would wait forever.
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`,
    );
    await new Promise<void>((done) => {
      upstream.releaseSecondEvent = done;
    });
    response.end(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [] } })}\n\n`,
    );
    return;
  }
  return json(response, 200, { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18" } });
}

const server = createServer((request, response) => {
  serveUpstream(request, response).catch((error: unknown) => {
    if (!response.headersSent) json(response, 500, { error: String(error) });
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const serverAddress = server.address();
if (!serverAddress || typeof serverAddress === "string") throw new Error("The fake MCP server has no port.");
base = `http://127.0.0.1:${serverAddress.port}`;
const mcpUrl = `${base}/mcp`;

// ---- The real sign-in store and proxy ------------------------------------------------------------

const records = new Map<string, McpOAuthRecord>();
// Signed in a minute ago with a token that says it lives for an hour. The server already refuses it.
records.set(mcpUrl, {
  client: { client_id: "e2e-client", redirect_uris: ["http://127.0.0.1:1/callback"], issuer: base },
  tokens: {
    access_token: firstToken,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: firstRefresh,
    issuer: base,
  },
  obtainedAt: Date.now() - 60_000,
  discovery: { authorizationServerUrl: base, resourceMetadataUrl: `${base}/.well-known/oauth-protected-resource/mcp` },
});
const oauth = new McpOAuth({
  storage: {
    read: (resource) => records.get(resource) ?? null,
    write: (resource, record) => Effect.sync(() => void records.set(resource, record)),
    clear: (resource) => Effect.sync(() => void records.delete(resource)),
  },
  openExternal: async () => {
    throw new Error("The test never opens a browser.");
  },
  redirectUrl: "http://127.0.0.1:1/callback",
});
const proxySecret = randomBytes(32).toString("base64url");
const proxy = new McpOAuthProxy({ tokens: oauth, secret: () => proxySecret });
await Effect.runPromise(proxy.start(null));

const config: McpServerConfig = {
  id: "e2e-server",
  name: "e2e",
  transport: "http",
  enabled: true,
  command: "",
  args: [],
  env: [],
  envPassthrough: [],
  workingDirectory: "",
  url: mcpUrl,
  headers: [],
};

function withDeadline<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error(`${what} did not end in ${STEP_DEADLINE_MS} ms.`)), STEP_DEADLINE_MS);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

try {
  // ---- 1. The provider configurations ----------------------------------------------------------
  const usable = await Effect.runPromise(
    usableMcpServers([config], undefined, (subject) => mcpOAuthHandoff(subject, oauth, proxy)),
  );
  const shapes = {
    claude: claudeMcpServers(usable).servers,
    acp: acpMcpServers(usable).servers,
    codex: codexMcpServers(usable).servers,
  };
  const address = proxy.route(mcpUrl) ?? "";
  for (const [provider, shape] of Object.entries(shapes)) {
    const text = JSON.stringify(shape);
    const leaked = upstream.issued.filter((value) => text.includes(value));
    check(
      `${provider} config holds the proxy, not a token`,
      leaked.length === 0 && text.includes(address) && text.includes(proxySecret) && !text.includes(`"${mcpUrl}"`),
      `address=${text.includes(address)} secret=${text.includes(proxySecret)} upstreamUrl=${text.includes(`"${mcpUrl}"`)} leakedTokens=${leaked.length}`,
    );
  }

  // ---- 2. The proxy secret ---------------------------------------------------------------------
  const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const post = (headers: Record<string, string>, body = initialize, target = address, signal?: AbortSignal) =>
    fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body,
      ...(signal ? { signal } : {}),
    });
  const before = upstream.requests.length;
  const missing = await post({});
  const wrong = await post({ authorization: `Bearer ${randomBytes(32).toString("base64url")}` });
  const wrongLength = await post({ authorization: "Bearer short" });
  const unknownRoute = await post(
    { authorization: `Bearer ${proxySecret}` },
    initialize,
    `${proxy.origin()}/mcp/unknown`,
  );
  check(
    "a missing or wrong proxy secret is refused",
    missing.status === 401 &&
      wrong.status === 401 &&
      wrongLength.status === 401 &&
      unknownRoute.status === 404 &&
      upstream.requests.length === before,
    `missing=${missing.status} wrong=${wrong.status} wrongLength=${wrongLength.status} unknownRoute=${unknownRoute.status} reachedUpstream=${upstream.requests.length - before}`,
  );

  // ---- 3. A refused token is renewed one time, and the request is sent again one time ---------
  const authorized = { authorization: `Bearer ${proxySecret}` };
  const firstRequests = upstream.requests.length;
  const renewed = await post(authorized);
  const renewedBody = await renewed.text();
  const sent = upstream.requests.slice(firstRequests);
  const secondToken = upstream.issued[2] ?? "";
  check(
    "the first token is refused with 401, the proxy renews it, and the call succeeds",
    renewed.status === 200 &&
      renewedBody.includes("protocolVersion") &&
      upstream.refreshes === 1 &&
      sent.length === 2 &&
      sent[0]?.authorization === `Bearer ${firstToken}` &&
      sent[1]?.authorization === `Bearer ${secondToken}` &&
      sent.every((request) => request.body === initialize) &&
      records.get(mcpUrl)?.tokens?.access_token === secondToken,
    `status=${renewed.status} refreshes=${upstream.refreshes} upstreamRequests=${sent.length} sameBody=${sent.every((request) => request.body === initialize)}`,
  );
  const plainRequests = upstream.requests.length;
  const plain = await post(authorized);
  await plain.text();
  check(
    "a valid token is sent without a renewal",
    plain.status === 200 && upstream.refreshes === 1 && upstream.requests.length === plainRequests + 1,
    `status=${plain.status} refreshes=${upstream.refreshes}`,
  );

  // ---- 4. Two refused requests share one renewal -----------------------------------------------
  upstream.valid.clear();
  const [left, right] = await Promise.all([post(authorized), post(authorized)]);
  await Promise.all([left.text(), right.text()]);
  check(
    "two requests refused together share one renewal",
    left.status === 200 && right.status === 200 && upstream.refreshes === 2,
    `statuses=${left.status},${right.status} refreshes=${upstream.refreshes}`,
  );

  // ---- 5. An event stream passes through as it arrives -----------------------------------------
  const call = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "x", arguments: {} } });
  const streamed = await post(authorized, call);
  const reader = streamed.body?.getReader();
  const decoder = new TextDecoder();
  let received = "";
  const firstEvent = await withDeadline(
    (async () => {
      while (reader && !received.includes("notifications/progress")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += decoder.decode(chunk.value, { stream: true });
      }
      return received.includes("notifications/progress");
    })(),
    "the first event",
  );
  const secondEventWaiting = upstream.releaseSecondEvent !== null && !received.includes('"result"');
  upstream.releaseSecondEvent?.();
  while (reader) {
    const chunk = await withDeadline(reader.read(), "the second event");
    if (chunk.done) break;
    received += decoder.decode(chunk.value, { stream: true });
  }
  check(
    "a streaming response passes through as it arrives",
    streamed.status === 200 &&
      streamed.headers.get("content-type") === "text/event-stream" &&
      firstEvent &&
      secondEventWaiting &&
      received.includes('"result"'),
    `status=${streamed.status} type=${streamed.headers.get("content-type")} firstEventBeforeSecond=${firstEvent && secondEventWaiting} complete=${received.includes('"result"')}`,
  );

  // ---- 6. A request the provider abandons ends upstream ----------------------------------------
  const abandon = new AbortController();
  const listening = await fetch(address, {
    method: "GET",
    headers: { ...authorized, accept: "text/event-stream" },
    signal: abandon.signal,
  });
  const listenReader = listening.body?.getReader();
  await withDeadline(listenReader?.read() ?? Promise.resolve(null), "the open event stream");
  abandon.abort();
  await listenReader?.cancel().catch(() => {});
  const ended = await withDeadline(
    upstream.streamClosed.then(() => true),
    "the upstream close",
  ).catch(() => false);
  check(
    "an abandoned request is aborted upstream",
    listening.status === 200 && ended,
    `status=${listening.status} upstreamClosed=${ended}`,
  );

  // ---- 7. A renewal that fails gives the 401 back once ----------------------------------------
  upstream.valid.clear();
  upstream.refuseRefresh = true;
  const refreshesBefore = upstream.refreshes;
  const requestsBefore = upstream.requests.length;
  const refused = await post(authorized);
  await refused.text();
  check(
    "a failed renewal returns the 401 with no loop",
    refused.status === 401 &&
      upstream.refreshes === refreshesBefore + 1 &&
      upstream.requests.length === requestsBefore + 1,
    `status=${refused.status} refreshes=${upstream.refreshes - refreshesBefore} upstreamRequests=${upstream.requests.length - requestsBefore}`,
  );

  check(
    "upstream never receives the proxy secret",
    upstream.requests.every((request) => !request.authorization?.includes(proxySecret)),
    `requests=${upstream.requests.length}`,
  );

  // ---- 8. Logs --------------------------------------------------------------------------------
  const logText = logLines.join("\n");
  const leakedInLogs = [...upstream.issued, proxySecret].filter((value) => logText.includes(value));
  check(
    "no token or proxy secret is in a log line",
    logLines.length > 0 && leakedInLogs.length === 0 && logText.includes("renewed"),
    `lines=${logLines.length} leaked=${leakedInLogs.length}`,
  );
} finally {
  stopTee();
  await Effect.runPromise(proxy.stop());
  await Effect.runPromise(oauth.close());
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}

const report = {
  passed: checks.length > 0 && checks.every((item) => item.passed),
  upstreamRequests: upstream.requests.length,
  refreshes: upstream.refreshes,
  logLines: logLines.length,
  checks,
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
for (const item of checks) process.stdout.write(`${item.passed ? "PASS" : "FAIL"} ${item.name} (${item.detail})\n`);
const failed = checks.filter((item) => !item.passed);
assert.equal(failed.length, 0, `${failed.length} check(s) failed; see ${join(OUT, "report.json")}`);
