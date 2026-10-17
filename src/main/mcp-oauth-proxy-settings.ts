// The port and the secret of `McpOAuthProxy`, kept across restarts. Codex keeps the MCP
// configuration a session started with, so a resumed session sends the old secret to the old port.
// The secret is encrypted at rest by the operating system and registered for redaction, as the
// GitHub MCP proxy keeps its own in the GitHub sign-in record.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createOpenBotLogger, registerSecretValue, toLogValue } from "@openbot/logging";
import { Effect, Result } from "effect";
import { z } from "zod";
import { writeFileAtomically } from "../backend/atomic-json-file";
import { McpOAuthProxy, type McpOAuthProxyOptions } from "../backend/mcp-oauth-proxy";
import type { SecretCipher } from "./provider-credential-store";

const logger = createOpenBotLogger("mcp-oauth-proxy");

const fileSchema = z.object({
  version: z.literal(1),
  port: z.number().int().min(1).max(65_535),
  secret: z.string(),
});

function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Starts the proxy on the port it had, with the secret it had. A new port gets a new secret, because
 * another program can now listen on the old one and resumed sessions still send it there. `null`
 * when the proxy cannot listen: providers are then handed the stored token, as before the proxy.
 */
export const startMcpOAuthProxy = Effect.fn("McpOAuthProxySettings.start")(function* (
  path: string,
  cipher: SecretCipher,
  tokens: McpOAuthProxyOptions["tokens"],
) {
  const saved = yield* Effect.tryPromise(async () => {
    const file = fileSchema.parse(JSON.parse(await readFile(path, "utf8")));
    const secret = cipher.decrypt(Buffer.from(file.secret, "base64"));
    if (secret.length < 32) throw new Error("The MCP sign-in proxy secret is too short.");
    return { port: file.port, secret };
  }).pipe(Effect.catch(() => Effect.succeed(null)));
  let secret = saved?.secret ?? newSecret();
  registerSecretValue(secret);
  const proxy = new McpOAuthProxy({ tokens, secret: () => secret });
  const started = yield* proxy.start(saved?.port ?? null).pipe(Effect.result);
  if (Result.isFailure(started)) {
    logger.warn("The MCP sign-in proxy did not start. Agents get the stored token, which can expire.", {
      cause: toLogValue(started.failure.cause),
    });
    return null;
  }
  const port = started.success;
  if (saved?.port === port) return proxy;
  if (saved) {
    secret = newSecret();
    registerSecretValue(secret);
  }
  const content = yield* Effect.try(
    () => `${JSON.stringify({ version: 1, port, secret: cipher.encrypt(secret).toString("base64") })}\n`,
  ).pipe(Effect.catch(() => Effect.succeed(null)));
  const written = content
    ? yield* writeFileAtomically(path, content, { createDirectory: true }).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      )
    : false;
  if (!written)
    logger.warn("The MCP sign-in proxy port could not be saved. Codex sessions start again after a restart.");
  return proxy;
});
