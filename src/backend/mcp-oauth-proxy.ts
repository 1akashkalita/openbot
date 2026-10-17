// The loopback address through which providers reach the http MCP servers that OpenBot signed in
// to. A provider holds only this address and its secret. For each request the proxy adds the access
// token that is stored now, so a provider session that runs for days never sends a token that
// expired while it ran. When the server refuses the token with 401, the proxy renews it one time
// through `McpOAuth` and sends the request again one time.
//
// This module imports no Electron, so `scripts/mcp-oauth-proxy-e2e.ts` runs the real proxy.

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { McpServerConfig } from "@openbot/contracts/ipc";
import { isString } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger, registerSecretValue, toLogValue } from "@openbot/logging";
import { Effect } from "effect";
import { type McpOperationError, mcpCall, mcpFailure, mcpSync } from "./mcp-effects";
import { isLoopback, type McpOAuthAuthority, secureOAuthRequest } from "./mcp-oauth-provider";
import { type McpHandoffAuthorization, mcpNamesAuthorization } from "./mcp-provider-shapes";

const logger = createOpenBotLogger("mcp-oauth-proxy");

/**
 * The largest request body the proxy accepts. The body is kept until the upstream answers, so the
 * one retry after a 401 can send it again. MCP requests are JSON-RPC messages, far below this.
 */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** The path prefix of every route. The rest of the path names one upstream server. */
const ROUTE_PREFIX = "/mcp/";

/**
 * Headers that describe one connection and not the request, from RFC 9110 section 7.6.1, and the
 * headers that the proxy sets itself. `authorization` is the proxy secret on the way in.
 */
const REQUEST_HEADERS_NOT_FORWARDED = new Set([
  "authorization",
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  // `fetch` asks for the encodings it can decode and gives the body decoded.
  "accept-encoding",
]);

/** `fetch` gives the body decoded, so its encoding and length no longer apply. */
const RESPONSE_HEADERS_NOT_FORWARDED = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-connection",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface McpOAuthProxyOptions {
  tokens: Pick<McpOAuthAuthority, "accessToken" | "renewAccessToken">;
  /**
   * The bearer that providers send. It stays the same across restarts while the port does, so a
   * resumed Codex session, which keeps the configuration it started with, still reaches the proxy.
   */
  secret: () => string;
}

/**
 * A raw HTTP reverse proxy on 127.0.0.1. It forwards every method, so MCP Streamable HTTP works:
 * a POST with a JSON or an event-stream answer, the GET event stream, and the DELETE that ends a
 * session. A response streams through as it arrives, with backpressure, and a request that the
 * provider abandons is aborted upstream.
 *
 * Only an upstream that `route` registered can be reached. `McpGateway` registers one at each
 * hand-off, which always comes before the provider connects. The proxy adds no deadline and no
 * retry of its own other than the one retry after a 401: the provider keeps its own deadlines.
 */
export class McpOAuthProxy {
  readonly #options: McpOAuthProxyOptions;
  /** The upstream URL of each route key. */
  readonly #routes = new Map<string, string>();
  #server: Server | null = null;
  #port: number | null = null;

  constructor(options: McpOAuthProxyOptions) {
    this.#options = options;
  }

  /** The origin of the proxy, or `null` before `start`. */
  origin(): string | null {
    return this.#port === null ? null : `http://127.0.0.1:${this.#port}`;
  }

  secret(): string {
    return this.#options.secret();
  }

  /**
   * The address a provider is given for `upstream`, and the route that makes it reachable. `null`
   * while the proxy does not listen. The key is a digest of the URL, so the address stays the same
   * across restarts and does not show a secret that the URL path can hold.
   */
  route(upstream: string): string | null {
    const origin = this.origin();
    if (origin === null) return null;
    const key = createHash("sha256").update(upstream).digest("base64url").slice(0, 32);
    this.#routes.set(key, upstream);
    return `${origin}${ROUTE_PREFIX}${key}`;
  }

  /**
   * Listens on `preferredPort` when it is free, so a resumed session finds the same address, and on
   * a new port when it is not. Returns the port.
   */
  readonly start = Effect.fn("McpOAuthProxy.start")(function* (this: McpOAuthProxy, preferredPort: number | null) {
    if (this.#port !== null) return this.#port;
    registerSecretValue(this.#options.secret());
    const server = yield* this.#listen(preferredPort ?? 0).pipe(
      Effect.catch((error) => (preferredPort === null ? Effect.fail(error) : this.#listen(0))),
    );
    const address = server.address();
    if (!address || isString(address)) {
      server.close();
      return yield* Effect.fail(mcpFailure(new Error("The MCP sign-in proxy has no loopback port.")));
    }
    this.#server = server;
    this.#port = address.port;
    return address.port;
  });

  /** Stops listening and ends the open connections, so a provider stream does not hold the close. */
  readonly stop = Effect.fn("McpOAuthProxy.stop")(function* (this: McpOAuthProxy) {
    const server = this.#server;
    this.#server = null;
    this.#port = null;
    this.#routes.clear();
    if (!server) return;
    yield* Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
      server.closeAllConnections();
    });
  });

  #listen(port: number): Effect.Effect<Server, McpOperationError> {
    return Effect.callback((resume) => {
      const server = createServer((request, response) => {
        // `#handle` answers every expected failure itself; a defect ends only this connection.
        Effect.runPromise(this.#handle(request, response)).catch((error: unknown) => {
          logger.warn("The MCP sign-in proxy stopped a request.", { cause: toLogValue(error) });
          response.destroy();
        });
      });
      let transferred = false;
      const failed = (cause: Error) => resume(Effect.fail(mcpFailure(cause)));
      server.once("error", failed);
      server.listen(port, "127.0.0.1", () => {
        transferred = true;
        server.off("error", failed);
        resume(Effect.succeed(server));
      });
      return Effect.sync(() => {
        server.off("error", failed);
        if (!transferred) server.close();
      });
    });
  }

  /** One provider request, from the secret check to the end of the upstream answer. Never fails. */
  readonly #handle = Effect.fn("McpOAuthProxy.handle")(function* (
    this: McpOAuthProxy,
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    if (!this.#authorized(request)) return reply(response, 401, "unauthorized");
    const upstream = this.#upstream(request.url);
    if (!upstream) return reply(response, 404, "not_found");
    // The provider left: the upstream request, or its answer, stops too.
    const abandoned = new AbortController();
    const abandon = () => {
      if (!response.writableFinished) abandoned.abort();
    };
    response.once("close", abandon);
    yield* this.#forward(request, response, upstream, abandoned.signal).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          if (abandoned.signal.aborted) return;
          logger.warn("An MCP server could not be reached through the sign-in proxy.", {
            server: originOf(upstream),
            cause: toLogValue(error.cause),
          });
          if (!response.headersSent) reply(response, 502, "upstream_unreachable");
          else response.destroy();
        }),
      ),
      Effect.ensuring(Effect.sync(() => response.off("close", abandon))),
    );
  });

  readonly #forward = Effect.fn("McpOAuthProxy.forward")(function* (
    this: McpOAuthProxy,
    request: IncomingMessage,
    response: ServerResponse,
    upstream: string,
    signal: AbortSignal,
  ) {
    const body = yield* readBody(request, MAX_BODY_BYTES);
    if (body === "too_large") return reply(response, 413, "request_too_large");
    const method = request.method ?? "GET";
    const headers = forwardedHeaders(request.headers);
    const token = yield* this.#options.tokens.accessToken(upstream).pipe(Effect.catch(() => Effect.succeed(null)));
    let answer = yield* this.#send(upstream, method, headers, body, token, signal);
    if (answer.status === 401 && token) {
      const renewed = yield* this.#options.tokens
        .renewAccessToken(upstream, token)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (renewed) {
        yield* mcpCall(() => answer.body?.cancel()).pipe(Effect.catch(() => Effect.void));
        logger.info("An MCP server refused its access token. The token was renewed and the request sent again.", {
          server: originOf(upstream),
        });
        answer = yield* this.#send(upstream, method, headers, body, renewed, signal);
      } else {
        logger.warn("An MCP server refused its access token, and the token could not be renewed.", {
          server: originOf(upstream),
        });
      }
    }
    yield* relay(answer, response);
  });

  #send(
    upstream: string,
    method: string,
    headers: Headers,
    body: Uint8Array<ArrayBuffer> | null,
    token: string | null,
    signal: AbortSignal,
  ): Effect.Effect<Response, McpOperationError> {
    const sent = new Headers(headers);
    if (token) {
      registerSecretValue(token);
      sent.set("authorization", `Bearer ${token}`);
    }
    return secureOAuthRequest(
      upstream,
      { method, headers: sent, ...(body && method !== "GET" && method !== "HEAD" ? { body } : {}) },
      signal,
    );
  }

  /** The same secret check as `GitHubMcpProxy`: a bearer compared in constant time. */
  #authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return false;
    const candidate = Buffer.from(header.slice("Bearer ".length));
    const secret = Buffer.from(this.#options.secret());
    return candidate.length === secret.length && timingSafeEqual(candidate, secret);
  }

  /** The upstream of a request path. A query on the path is not read: every route is one URL. */
  #upstream(path: string | undefined): string | null {
    if (!path?.startsWith(ROUTE_PREFIX)) return null;
    const key = path.slice(ROUTE_PREFIX.length).split("?")[0] ?? "";
    return this.#routes.get(key) ?? null;
  }
}

/**
 * What one http server is handed. A server whose sign-in this machine can renew goes through the
 * proxy, with the proxy secret as its bearer. Every other server keeps the earlier hand-off: the
 * stored token, which `McpOAuth.accessToken` refreshes when it is about to expire. A header that
 * the user typed wins, as in `mcpHandoffHeaders`.
 */
export const mcpOAuthHandoff = Effect.fn("McpOAuthProxy.handoff")(function* (
  config: McpServerConfig,
  oauth: McpOAuthAuthority,
  proxy: McpOAuthProxy | null,
): Effect.fn.Return<McpHandoffAuthorization | null, McpOperationError> {
  const url = proxiedAddress(config, oauth, proxy);
  if (proxy && url) return { bearer: proxy.secret(), url };
  const token = yield* oauth.accessToken(config.url);
  return token ? { bearer: token } : null;
});

/**
 * The proxy address of one configuration, or `null` when it is handed off without the proxy. The
 * proxy sends a token only to https, or to http on this computer, as `secureOAuthRequest` does; any
 * other server keeps the earlier hand-off, so it does not stop working.
 */
export function proxiedAddress(
  config: McpServerConfig,
  oauth: Pick<McpOAuthAuthority, "renewable">,
  proxy: McpOAuthProxy | null,
): string | null {
  if (
    !proxy ||
    config.transport !== "http" ||
    !secureUpstream(config.url) ||
    mcpNamesAuthorization(config) ||
    !oauth.renewable(config.url)
  )
    return null;
  return proxy.route(config.url);
}

function secureUpstream(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return parsed.protocol === "https:" || (parsed.protocol === "http:" && isLoopback(parsed.hostname));
}

function reply(response: ServerResponse, status: number, error: string): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error }));
}

function originOf(url: string): string {
  return URL.canParse(url) ? new URL(url).origin : "unknown";
}

function forwardedHeaders(incoming: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || REQUEST_HEADERS_NOT_FORWARDED.has(name)) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

/** The request body, kept whole for the retry. `null` when there is none. */
const readBody = Effect.fn("McpOAuthProxy.readBody")(function* (request: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  const iterator = request[Symbol.asyncIterator]();
  let finished = false;
  return yield* Effect.gen(function* () {
    while (true) {
      const next = yield* mcpCall(() => iterator.next());
      if (next.done) {
        finished = true;
        break;
      }
      const chunk = yield* mcpSync(() => (Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value)));
      size += chunk.length;
      if (size > maxBytes) return "too_large" as const;
      chunks.push(chunk);
    }
    // A copy into a plain `ArrayBuffer`, the body type `fetch` accepts.
    return chunks.length === 0 ? null : new Uint8Array(Buffer.concat(chunks));
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        if (finished) return;
        yield* mcpCall(() => iterator.return?.()).pipe(Effect.catch(() => Effect.void));
      }),
    ),
  );
});

/**
 * Writes the upstream answer as it arrives. An event stream is never collected: each chunk goes to
 * the provider when it comes, and the next read waits while the provider is slow to take it.
 */
const relay = Effect.fn("McpOAuthProxy.relay")(function* (answer: Response, response: ServerResponse) {
  const headers: Record<string, string | string[]> = {};
  answer.headers.forEach((value, name) => {
    if (!RESPONSE_HEADERS_NOT_FORWARDED.has(name)) headers[name] = value;
  });
  const cookies = answer.headers.getSetCookie();
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  response.writeHead(answer.status, headers);
  response.flushHeaders();
  const body = answer.body;
  if (!body) {
    response.end();
    return;
  }
  const reader = body.getReader();
  let done = false;
  yield* Effect.gen(function* () {
    while (true) {
      const chunk = yield* mcpCall(() => reader.read());
      if (chunk.done) break;
      if (!response.write(chunk.value)) yield* drained(response);
    }
    done = true;
    response.end();
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        if (done) return;
        yield* mcpCall(() => reader.cancel()).pipe(Effect.catch(() => Effect.void));
      }),
    ),
  );
});

/** Waits until the provider takes the written data, or leaves. */
function drained(response: ServerResponse): Effect.Effect<void, McpOperationError> {
  return Effect.callback((resume) => {
    const onDrain = () => {
      cleanup();
      resume(Effect.void);
    };
    const onClose = () => {
      cleanup();
      resume(Effect.fail(mcpFailure(new Error("The provider closed the MCP connection."))));
    };
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
    };
    response.once("drain", onDrain);
    response.once("close", onClose);
    return Effect.sync(cleanup);
  });
}
