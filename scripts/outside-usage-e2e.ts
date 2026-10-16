// Checks the import of the usage that the Claude and Codex CLIs log for sessions OpenBot did not run. Writes CLI
// log trees with a marker in every prompt, path and working folder, reads them with the real scanner into a real
// database on a temporary profile, and changes them as the CLIs do: appends, an unfinished line, a rewrite and a
// move to the archive. It then reads the report through the Team API route and the team client on a local HTTP
// server. No app, provider, account or network is started.
//
// Run: bun scripts/outside-usage-e2e.ts
// Writes .openbot-build/outside-usage-e2e/report.json and exits non-zero on a failure.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_PROVIDER_ACCOUNT_ID, type OutsideUsageInput, type OutsideUsageReport } from "@openbot/contracts/ipc";
import { OUTSIDE_USAGE_CAPABILITY, OUTSIDE_USAGE_ROUTES } from "@openbot/contracts/team-protocol/outside-usage-v1";
import { teamSideRouteCodec } from "@openbot/contracts/team-protocol/side-routes";
import { TEAM_CAPABILITIES_HEADER, TEAM_PROTOCOL_VERSION_HEADER } from "@openbot/contracts/team-protocol/v1";
import { teeLogLines } from "@openbot/logging";
import { readOutsideUsage } from "@openbot/team-client";
import { Effect, Exit, Scope } from "effect";
import { OutsideUsageScanner, type OutsideUsageScanSummary } from "../src/backend/agent/outside-usage-scanner";
import { claimProviderSession } from "../src/backend/database/outside-usage";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { HttpError } from "../src/main/team-api/http-error";
import type { TeamApiRequestContext } from "../src/main/team-api/request-context";
import { requestCapabilities, requestProtocol } from "../src/main/team-api/request-helpers";
import { routeOutsideUsage } from "../src/main/team-api/route-outside-usage";

const OUT = resolve(import.meta.dirname, "../.openbot-build/outside-usage-e2e");
/** Lower-case letters and digits only, so every encoding of it still contains it. */
const MARKER = `obe2e${randomBytes(6).toString("hex")}`;
const root = join(tmpdir(), `openbot-outside-usage-${MARKER}`);
const userData = join(root, "user-data");
const claudeHome = join(root, `claude-${MARKER}`);
const codexHome = join(root, `codex-${MARKER}`);
const RANGE: OutsideUsageInput = { startDate: "2026-10-14", endDate: "2026-10-16", timeZone: "UTC" };

interface Report {
  marker: string;
  scans: Record<string, OutsideUsageScanSummary>;
  records: Record<string, number>;
  totals?: OutsideUsageReport["totals"];
  models?: { provider: string; model: string; processedTokens: number; estimatedCostUsd: number | null }[];
  route?: { status: number; sameAsDatabase: boolean; withoutCapability: number; clientWithoutCapability: null };
  markerFound: { database: boolean; output: boolean };
  passed: boolean;
  error?: string;
}

const report: Report = {
  marker: MARKER,
  scans: {},
  records: {},
  markerFound: { database: true, output: true },
  passed: false,
};

// A copy of every scanner log line, to check that no marker leaks into it.
const output: string[] = [];
const stopTee = teeLogLines(["outside-usage"], (line) => output.push(line));

function writeLines(path: string, lines: readonly object[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
}

function claudeUser(sessionId: string, timestamp: string) {
  return {
    type: "user",
    sessionId,
    timestamp,
    cwd: `/Users/${MARKER}/project`,
    message: { role: "user", content: `Secret prompt ${MARKER}` },
  };
}

/** The usage fields of a Claude CLI assistant line. */
interface ClaudeUsage {
  input_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number };
  output_tokens: number;
}

function claudeAssistant(sessionId: string, timestamp: string, id: string, model: string, usage: ClaudeUsage) {
  return {
    type: "assistant",
    sessionId,
    requestId: `req-${id}`,
    timestamp,
    cwd: `/Users/${MARKER}/project`,
    message: { id, role: "assistant", model, content: [{ type: "text", text: `Answer ${MARKER}` }], usage },
  };
}

function codexMeta(id: string, originator: string, timestamp: string) {
  return { type: "session_meta", timestamp, payload: { id, originator, cwd: `/Users/${MARKER}/project` } };
}

function codexContext(model: string, timestamp: string) {
  return { type: "turn_context", timestamp, payload: { model, cwd: `/Users/${MARKER}/project` } };
}

function codexPrompt(timestamp: string) {
  return {
    type: "response_item",
    timestamp,
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: `Secret prompt ${MARKER}` }] },
  };
}

function codexCount(timestamp: string, total: number, input: number, cached: number, outputTokens: number) {
  return {
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 0, total_tokens: total },
        last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: outputTokens },
      },
    },
  };
}

// API rates per million tokens from usage-pricing.ts, written out so a price change shows here.
const usd = (millionths: number) => millionths / 1_000_000;
// claude-sonnet-4-6 at 3 / 0.3 / 15: 100 input, 1,000 cache reads, 1,500 five-minute and 500 one-hour cache
// writes at 1.25 and 2 times input, and 40 output tokens, the largest of the two streaming lines.
const SONNET = usd(100 * 3 + 1_000 * 0.3 + 1_500 * 3 * 1.25 + 500 * 3 * 2 + 40 * 15);
// claude-opus-4-7 at 5 / 0.5 / 25.
const OPUS = usd(10 * 5 + 20 * 25);
const OPUS_APPENDED = usd(30 * 5 + 60 * 25);
const OPUS_FINISHED = usd(7 * 5 + 9 * 25);
// gpt-5.6-terra at 2 / 0.2 / 12. Codex input includes the cached input.
const TERRA_FIRST = usd(600 * 2 + 400 * 0.2 + 50 * 12);
const TERRA_SECOND = usd(500 * 2 + 1_500 * 0.2 + 80 * 12);
const TERRA_REWRITTEN = usd(300 * 2 + 0 * 0.2 + 10 * 12);
// gpt-5.6-luna at 0.2 / 0.02 / 1.2.
const LUNA = usd(400 * 0.2 + 100 * 0.02 + 100 * 1.2);

function closeTo(actual: number | null | undefined, expected: number, label: string): void {
  assert.ok(typeof actual === "number" && Math.abs(actual - expected) < 1e-12, `${label}: ${actual} != ${expected}`);
}

const database = new OpenBotDatabase(userData);
const scope = Effect.runSync(Scope.make());
let server: ReturnType<typeof createServer> | null = null;
try {
  await runCauseEffect(database.initialize());
  const scanner = new OutsideUsageScanner({
    usage: () => database.outsideUsage,
    scope: () => scope,
    roots: () => [
      { provider: "claude", accountRef: DEFAULT_PROVIDER_ACCOUNT_ID, home: claudeHome, folders: ["projects"] },
      {
        provider: "codex",
        accountRef: DEFAULT_PROVIDER_ACCOUNT_ID,
        home: codexHome,
        folders: ["sessions", "archived_sessions"],
      },
    ],
  });
  const scan = async (name: string) => {
    const summary = await Effect.runPromise(scanner.scan());
    report.scans[name] = summary;
    assert.equal(summary.failures, 0, `${name}: read failures`);
    return summary;
  };
  const records = (name: string) => {
    const row = database.connection.prepare("SELECT COUNT(*) AS count FROM outside_usage_records").get();
    const count = Number(row?.count);
    report.records[name] = count;
    return count;
  };
  // What a provider session bind does in its transaction.
  const claimSession = (provider: string, sessionId: string) => {
    database.connection.exec("BEGIN IMMEDIATE");
    claimProviderSession(database.connection, provider, sessionId, new Date().toISOString());
    database.connection.exec("COMMIT");
  };

  // Missing CLI folders are no usage, as on a server with no CLI.
  const empty = await scan("missingFolders");
  assert.deepEqual(empty, { files: 0, readFiles: 0, entries: 0, failures: 0 });

  const projectDir = join(claudeHome, "projects", `-Users-${MARKER}-project`);
  const outsideClaude = join(projectDir, "claude-outside.jsonl");
  writeLines(outsideClaude, [
    claudeUser("claude-outside", "2026-10-15T10:00:00.000Z"),
    // One line per content block: the second line has the final output count of the same request.
    claudeAssistant("claude-outside", "2026-10-15T10:00:01.000Z", "msg-1", "claude-sonnet-4-6", {
      input_tokens: 100,
      cache_read_input_tokens: 1_000,
      cache_creation_input_tokens: 2_000,
      cache_creation: { ephemeral_5m_input_tokens: 1_500, ephemeral_1h_input_tokens: 500 },
      output_tokens: 5,
    }),
    claudeAssistant("claude-outside", "2026-10-15T10:00:02.000Z", "msg-1", "claude-sonnet-4-6", {
      input_tokens: 100,
      cache_read_input_tokens: 1_000,
      cache_creation_input_tokens: 2_000,
      cache_creation: { ephemeral_5m_input_tokens: 1_500, ephemeral_1h_input_tokens: 500 },
      output_tokens: 40,
    }),
    claudeAssistant("claude-outside", "2026-10-15T10:01:00.000Z", "msg-2", "claude-opus-4-7", {
      input_tokens: 10,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 20,
    }),
    // The CLI writes an API error as a message of its own. No request ran.
    claudeAssistant("claude-outside", "2026-10-15T10:02:00.000Z", "msg-error", "<synthetic>", {
      input_tokens: 0,
      output_tokens: 0,
    }),
  ]);
  // A resumed session copies the earlier lines into a new file.
  writeLines(join(claudeHome, "projects", `-Users-${MARKER}-fork`, "claude-resumed.jsonl"), [
    claudeAssistant("claude-outside", "2026-10-15T10:00:02.000Z", "msg-1", "claude-sonnet-4-6", {
      input_tokens: 100,
      cache_read_input_tokens: 1_000,
      cache_creation_input_tokens: 2_000,
      cache_creation: { ephemeral_5m_input_tokens: 1_500, ephemeral_1h_input_tokens: 500 },
      output_tokens: 40,
    }),
  ]);
  // A session OpenBot ran, bound before the read, and one bound after it.
  claimSession("claude", "claude-owned");
  writeLines(join(projectDir, "claude-owned.jsonl"), [
    claudeAssistant("claude-owned", "2026-10-15T11:00:00.000Z", "msg-owned", "claude-sonnet-4-6", {
      input_tokens: 999,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 999,
    }),
  ]);
  writeLines(join(projectDir, "claude-late.jsonl"), [
    claudeAssistant("claude-late", "2026-10-15T11:00:00.000Z", "msg-late", "claude-sonnet-4-6", {
      input_tokens: 888,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 888,
    }),
  ]);

  const codexDay = join(codexHome, "sessions", "2026", "10", "15");
  const outsideCodex = join(codexDay, "rollout-outside.jsonl");
  writeLines(outsideCodex, [
    codexMeta("codex-outside", "codex_cli_rs", "2026-10-15T12:00:00.000Z"),
    codexContext("gpt-5.6-terra", "2026-10-15T12:00:00.000Z"),
    codexPrompt("2026-10-15T12:00:01.000Z"),
    codexCount("2026-10-15T12:00:02.000Z", 1_050, 1_000, 400, 50),
    // Codex sends the same totals again with no new request.
    codexCount("2026-10-15T12:00:03.000Z", 1_050, 1_000, 400, 50),
    codexCount("2026-10-15T12:01:00.000Z", 3_130, 2_000, 1_500, 80),
  ]);
  // OpenBot's own Codex client names itself "openbot".
  writeLines(join(codexDay, "rollout-openbot.jsonl"), [
    codexMeta("codex-openbot", "openbot", "2026-10-15T12:00:00.000Z"),
    codexContext("gpt-5.6-terra", "2026-10-15T12:00:00.000Z"),
    codexCount("2026-10-15T12:00:02.000Z", 7_777, 7_000, 0, 777),
  ]);
  // A newer Codex writes one record per request and repeats it as a token_count event.
  const recordCodex = join(codexDay, "rollout-records.jsonl");
  writeLines(recordCodex, [
    codexMeta("codex-records", "codex_exec", "2026-10-15T13:00:00.000Z"),
    codexContext("gpt-5.6-luna", "2026-10-15T13:00:00.000Z"),
    {
      type: "token_usage_record",
      timestamp: "2026-10-15T13:00:01.000Z",
      payload: {
        response_id: "resp-1",
        thread_id: "codex-records",
        usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 100 },
      },
    },
    codexCount("2026-10-15T13:00:01.000Z", 600, 500, 100, 100),
  ]);

  const first = await scan("first");
  assert.equal(first.files, 7);
  assert.equal(first.readFiles, 7);
  // msg-1, msg-2, claude-late, two Codex counts and one Codex record. The resumed copy is msg-1 again.
  assert.equal(records("first"), 6);
  claimSession("claude", "claude-late");
  assert.equal(records("afterLateBind"), 5, "a bind after the read removes the session's records");

  const unchanged = await scan("unchanged");
  assert.equal(unchanged.readFiles, 0, "an unchanged file is not read again");

  // The CLI appends a request, then starts the next line and finishes it later.
  appendFileSync(
    outsideClaude,
    `${JSON.stringify(
      claudeAssistant("claude-outside", "2026-10-15T14:00:00.000Z", "msg-3", "claude-opus-4-7", {
        input_tokens: 30,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 60,
      }),
    )}\n`,
  );
  const unfinished = JSON.stringify(
    claudeAssistant("claude-outside", "2026-10-15T14:01:00.000Z", "msg-4", "claude-opus-4-7", {
      input_tokens: 7,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 9,
    }),
  );
  appendFileSync(outsideClaude, unfinished.slice(0, 40));
  const appended = await scan("append");
  assert.deepEqual([appended.readFiles, appended.entries], [1, 1], "only the new complete line is read");
  assert.equal(records("append"), 6);
  appendFileSync(outsideClaude, `${unfinished.slice(40)}\n`);
  const finished = await scan("finishLine");
  assert.deepEqual([finished.readFiles, finished.entries], [1, 1], "the finished line is read once");
  assert.equal(records("finishLine"), 7);

  // The CLI writes the file again from the start, shorter than before: it is read from the start.
  writeLines(outsideCodex, [
    codexMeta("codex-outside", "codex_cli_rs", "2026-10-15T12:00:00.000Z"),
    codexContext("gpt-5.6-terra", "2026-10-15T12:00:00.000Z"),
    codexCount("2026-10-15T15:00:00.000Z", 3_440, 300, 0, 10),
  ]);
  const rewritten = await scan("rewrite");
  assert.deepEqual([rewritten.readFiles, rewritten.entries], [1, 1]);
  assert.equal(records("rewrite"), 8, "the rewritten file adds its new request and keeps the earlier ones");

  // Codex moves an archived session. Its requests are not counted again.
  const archived = join(codexHome, "archived_sessions", "rollout-records.jsonl");
  mkdirSync(dirname(archived), { recursive: true });
  renameSync(recordCodex, archived);
  const moved = await scan("move");
  assert.equal(moved.readFiles, 1);
  assert.equal(records("move"), 8, "a moved file adds no record");

  const result = database.outsideUsage.read(RANGE, scanner.scannedAt());
  report.totals = result.totals;
  report.models = result.models.map(({ provider, model, processedTokens, estimatedCostUsd }) => ({
    provider,
    model,
    processedTokens,
    estimatedCostUsd,
  }));
  assert.equal(result.totals.turns, 8);
  assert.equal(result.totals.sessions, 3, "claude-outside, codex-outside and codex-records");
  assert.equal(result.totals.unpricedRecords, 0);
  assert.equal(result.totals.incompleteRecords, 0);
  closeTo(
    result.totals.estimatedCostUsd,
    SONNET + OPUS + OPUS_APPENDED + OPUS_FINISHED + TERRA_FIRST + TERRA_SECOND + TERRA_REWRITTEN + LUNA,
    "total cost",
  );
  const model = (name: string) => result.models.find((item) => item.model === name);
  closeTo(model("claude-sonnet-4-6")?.estimatedCostUsd, SONNET, "claude-sonnet-4-6 cost");
  assert.equal(model("claude-sonnet-4-6")?.processedTokens, 100 + 1_000 + 2_000 + 40);
  closeTo(model("gpt-5.6-luna")?.estimatedCostUsd, LUNA, "gpt-5.6-luna cost");
  assert.deepEqual(result.sources, [
    { provider: "claude", files: 4 },
    { provider: "codex", files: 4 },
  ]);
  assert.equal(result.daily.find((day) => day.date === "2026-10-15")?.turns, 8);

  // `/v1/analytics` counts only OpenBot turns, so its report does not change.
  const legacy = database.usage.readHost(RANGE);
  assert.equal(legacy.totals.turns, 0);
  assert.equal(legacy.totals.processedTokens, 0);

  // The route on a local HTTP server, with the request context and the response encoding of the Team API server.
  const agents = {
    getOutsideUsage: (input: OutsideUsageInput) => database.outsideUsage.read(input, scanner.scannedAt()),
  };
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const json = (status: number, value: object | null) => {
      const codec = teamSideRouteCodec(url.pathname);
      assert.ok(codec, "the outside usage route has a side-route codec");
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(`${JSON.stringify(codec.response(url.pathname, status, value, {}))}\n`);
      return "handled" as const;
    };
    const context: TeamApiRequestContext = {
      request,
      response,
      method: request.method ?? "GET",
      url,
      protocol: requestProtocol(request),
      capabilities: requestCapabilities(request),
      member: {
        id: "member",
        username: "member",
        email: null,
        name: null,
        role: "member",
        createdAt: "2026-10-15T00:00:00.000Z",
        disabled: false,
      },
      token: "token",
      sessionId: "session",
      sessionExpiresAt: "2026-10-17T00:00:00.000Z",
      json,
      empty: (status) => {
        response.writeHead(status);
        response.end();
        return "handled";
      },
    };
    routeOutsideUsage(context, agents)
      .then((outcome) => {
        if (outcome === "unmatched") json(404, { error: "Not found." });
      })
      .catch((error: unknown) => {
        response.writeHead(error instanceof HttpError ? error.status : 500);
        response.end();
      });
  });
  await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const { port } = address;
  const capabilities = [OUTSIDE_USAGE_CAPABILITY];
  let requests = 0;
  const post = (headers: Record<string, string>, body: unknown) => {
    requests++;
    return fetch(`http://127.0.0.1:${port}${OUTSIDE_USAGE_ROUTES.read}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [TEAM_PROTOCOL_VERSION_HEADER]: "7", ...headers },
      body: JSON.stringify(body),
    });
  };
  const request = async <T>(_method: "POST", _path: string, decode: (value: unknown) => T, body: OutsideUsageInput) => {
    const response = await post({ [TEAM_CAPABILITIES_HEADER]: capabilities.join(",") }, body);
    assert.equal(response.status, 200);
    return decode(await response.json());
  };
  const remote = await Effect.runPromise(readOutsideUsage(request, capabilities, RANGE));
  assert.ok(remote);
  const local = database.outsideUsage.read(RANGE, scanner.scannedAt());
  assert.deepEqual(remote, local, "the remote report is the host's report");
  const withoutCapability = (await post({}, RANGE)).status;
  assert.equal(withoutCapability, 400, "a request without the capability is refused");
  const before = requests;
  const clientWithoutCapability = await Effect.runPromise(readOutsideUsage(request, [], RANGE));
  assert.equal(clientWithoutCapability, null);
  assert.equal(requests, before, "a client does not ask a host that does not offer the route");
  report.route = { status: 200, sameAsDatabase: true, withoutCapability, clientWithoutCapability };

  // The database holds numbers, models, times and hashes only.
  database.connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const files = ["openbot.db", "openbot.db-wal"].map((name) => join(userData, name));
  report.markerFound.database = files.some((file) => {
    try {
      return readFileSync(file).includes(MARKER);
    } catch {
      return false;
    }
  });
  assert.equal(report.markerFound.database, false, "no prompt, path or folder name is in the database");
  assert.ok(output.length > 0, "the scanner log lines were captured");
  report.markerFound.output = output.some((line) => line.includes(MARKER));
  assert.equal(report.markerFound.output, false, "no prompt, path or folder name is in the log output");
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  server?.close();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  database.close();
  await rm(root, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  stopTee();
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stderr.write(`${report.error}\n`);
}
