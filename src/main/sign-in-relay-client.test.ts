import { createServer } from "node:net";
import type { McpServerConfig, McpTestResult } from "@openbot/contracts/ipc";
import { translateFor } from "@openbot/i18n";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { SignInRelayClient, type SignInRelayRemote } from "./sign-in-relay-client";
import { SignInRelayHost } from "./sign-in-relay-host";

const STATE = "state-1";
const CODE = "grant-code-123456";

function config(): McpServerConfig {
  return {
    id: "",
    name: "Signed in",
    transport: "http",
    enabled: true,
    command: "",
    args: [],
    env: [],
    envPassthrough: [],
    workingDirectory: "",
    url: "https://mcp.example.com/mcp",
    headers: [],
  };
}

/** Binds `port` (0: any free port) on loopback, closes it, and answers the port. */
function freePort(port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** A real host and a real client, joined by direct calls in place of the encrypted Team channel. */
function setup(
  port: number,
  options: { ownListener?: boolean; browser: (client: SignInRelayClient) => Promise<void> },
) {
  const granted: string[] = [];
  let result: McpTestResult | null = null;
  const page = `https://auth.example.com/authorize?state=${STATE}&redirect_uri=${encodeURIComponent(`http://127.0.0.1:${port}/cb`)}`;
  const host = new SignInRelayHost({
    mcp: {
      startRelay: () => Effect.void,
      relayStatus: () => ({ pageUrl: result ? null : page, result }),
      cancel: () => {
        result = { toolCount: 0, error: "stopped" };
      },
    },
    receiveMcpGrant: (_state, code) => {
      granted.push(code);
      result = { toolCount: 3, error: null };
      return true;
    },
  });
  const remote: SignInRelayRemote<unknown> = {
    start: host.startMcp("admin", { config: config() }),
    status: (flowId) => Effect.try(() => host.status("admin", flowId)),
    complete: (flowId, query) => Effect.try(() => host.complete("admin", flowId, query)),
    cancel: (flowId) => Effect.try(() => host.cancel("admin", flowId)),
  };
  const client: SignInRelayClient = new SignInRelayClient({
    openExternal: () => options.browser(client),
    language: { locale: "en", translate: translateFor("en") },
    ownListener: () => (options.ownListener ? { port, path: "/cb" } : null),
  });
  return { granted, run: () => Effect.runPromise(client.run("key", remote)) };
}

describe("SignInRelayClient", () => {
  it("takes the callback on the host's port, refuses another sign-in's, and frees the port", async () => {
    const port = await freePort();
    const statuses: number[] = [];
    const { granted, run } = setup(port, {
      browser: async () => {
        for (const state of ["other", STATE]) {
          const response = await fetch(`http://127.0.0.1:${port}/cb?code=${CODE}&state=${state}`);
          statuses.push(response.status);
        }
      },
    });

    expect(await run()).toEqual({ toolCount: 3, error: null });
    expect(statuses).toEqual([400, 200]);
    expect(granted).toEqual([CODE]);
    await expect(freePort(port)).resolves.toBe(port);
  });

  it("sends a pasted address when its own listener has the port", async () => {
    const port = await freePort();
    const { granted, run } = setup(port, {
      ownListener: true,
      browser: async (client) => {
        expect(() => client.paste("key", "https://example.com/?code=x&state=other")).toThrow();
        client.paste("key", `http://127.0.0.1:${port}/cb?code=${CODE}&state=${STATE}`);
      },
    });

    expect(await run()).toEqual({ toolCount: 3, error: null });
    expect(granted).toEqual([CODE]);
  });
});
