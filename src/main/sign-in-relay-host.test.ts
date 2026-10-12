import type { McpServerConfig } from "@openbot/contracts/ipc";
import { loopbackCallback } from "@openbot/contracts/ipc";
import { redactText } from "@openbot/logging";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { SIGN_IN_RELAY_TTL_MS, SignInRelayHost } from "./sign-in-relay-host";
import { HttpError } from "./team-api/http-error";

const PAGE = "https://auth.example.com/authorize?state=state-1&redirect_uri=http%3A%2F%2F127.0.0.1%3A28417%2Fmcp-auth";

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

function setup() {
  let now = 1_000;
  const cancel = vi.fn();
  const receiveMcpGrant = vi.fn((_state: string, _code: string) => true);
  const host = new SignInRelayHost({
    mcp: { startRelay: () => Effect.void, relayStatus: () => ({ pageUrl: PAGE, result: null }), cancel },
    receiveMcpGrant,
    now: () => now,
  });
  const start = (memberId = "admin") => Effect.runPromise(host.startMcp(memberId, { config: config() }));
  return { host, cancel, receiveMcpGrant, start, advance: (ms: number) => (now += ms) };
}

function refusal(run: () => unknown): number {
  try {
    run();
  } catch (error) {
    if (error instanceof HttpError) return error.status;
    throw error;
  }
  throw new Error("The call was not refused.");
}

describe("SignInRelayHost", () => {
  it("delivers a callback once, and masks its code in every later log line", async () => {
    const { host, receiveMcpGrant, start } = setup();
    const { flowId } = await start();

    host.complete("admin", flowId, "code=grant-code-123456&state=state-1");

    expect(receiveMcpGrant).toHaveBeenCalledWith("state-1", "grant-code-123456");
    expect(redactText("code grant-code-123456")).not.toContain("grant-code-123456");
    expect(refusal(() => host.complete("admin", flowId, "code=grant-code-123456&state=state-1"))).toBe(409);
  });

  it("answers another member as it answers an unknown flow", async () => {
    const { host, receiveMcpGrant, start } = setup();
    const { flowId } = await start("admin");

    expect(refusal(() => host.status("other", flowId))).toBe(404);
    expect(refusal(() => host.complete("other", flowId, "code=c&state=state-1"))).toBe(404);
    expect(refusal(() => host.status("admin", "unknown"))).toBe(404);
    expect(receiveMcpGrant).not.toHaveBeenCalled();
  });

  it("refuses a callback for another sign-in", async () => {
    const { host, receiveMcpGrant, start } = setup();
    const { flowId } = await start();

    expect(refusal(() => host.complete("admin", flowId, "code=c&state=state-2"))).toBe(400);
    expect(receiveMcpGrant).not.toHaveBeenCalled();
  });

  it("ends an expired flow and stops its sign-in", async () => {
    const { host, cancel, start, advance } = setup();
    const { flowId } = await start();

    advance(SIGN_IN_RELAY_TTL_MS);

    expect(refusal(() => host.complete("admin", flowId, "code=c&state=state-1"))).toBe(404);
    expect(cancel).toHaveBeenCalledWith("https://mcp.example.com/mcp");
  });

  it("ends the sign-in when the user refused on the page, with no delivery", async () => {
    const { host, cancel, receiveMcpGrant, start } = setup();
    const { flowId } = await start();

    host.complete("admin", flowId, "error=access_denied&state=state-1");

    expect(cancel).toHaveBeenCalled();
    expect(receiveMcpGrant).not.toHaveBeenCalled();
  });
});

describe("loopbackCallback", () => {
  it("names only a loopback callback, so a client cannot choose another address", () => {
    expect(loopbackCallback(PAGE)).toEqual({ port: 28417, path: "/mcp-auth", state: "state-1" });
    expect(
      loopbackCallback("https://auth.example.com/authorize?redirect_uri=http%3A%2F%2F10.0.0.2%3A80%2Fcb"),
    ).toBeNull();
    expect(loopbackCallback("https://auth.example.com/authorize?redirect_uri=openbot%3A%2F%2Fmcp-auth")).toBeNull();
  });
});
