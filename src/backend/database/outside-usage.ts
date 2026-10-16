import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type AnalyticsProviderDay,
  type AnalyticsTotals,
  analyticsDate,
  decodeUsageTokens,
  emptyAnalyticsTotals,
  type OutsideUsageInput,
  type OutsideUsageReport,
  type OutsideUsageSource,
  parseOutsideUsageInput,
  type UsageTokens,
} from "@openbot/contracts/ipc";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { estimateRequestCost } from "../agent/usage-pricing";
import type { DatabaseCore } from "./database-core";
import { databaseRow, databaseRows, requiredStringColumn } from "./database-rows";

export type OutsideUsageProvider = "claude" | "codex";

/** One provider request that a CLI log recorded. `sessionId` is the provider's id; it is stored only as a hash. */
export interface OutsideUsageEntry {
  /** The provider's id of the request, such as the message and request ids. It is stored only as a hash. */
  requestId: string;
  sessionId: string;
  model: string;
  occurredAt: string;
  tokens: UsageTokens;
  /** The part of `tokens.cacheCreation` that the provider keeps for one hour. */
  cacheWriteLong: number;
}

/** Where the scanner stopped in one log file. */
export interface OutsideUsageFile {
  provider: OutsideUsageProvider;
  accountRef: string;
  fileKey: string;
  size: number;
  mtimeMs: number;
  readOffset: number;
  state: string;
}

export interface OutsideUsageBatch {
  file: OutsideUsageFile;
  entries: readonly OutsideUsageEntry[];
}

const TOKEN_KEYS = ["uncachedInput", "cachedInput", "cacheCreation", "output"] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The stored key of a provider session. The bind of an OpenBot session deletes the records with this key. */
export function outsideSessionKey(provider: string, externalSessionId: string): string {
  return sha256(`${provider}\0${externalSessionId}`);
}

/**
 * Owns the usage that the Claude and Codex CLIs log for sessions OpenBot did not run, and the read position of
 * each log file. It stores numbers, model names, times and hashes; never a path, prompt or working folder. A
 * session in `openbot_provider_sessions` is OpenBot usage, which `AgentUsage` already counts. Never imports the
 * facade.
 */
export class OutsideUsage {
  readonly #core: DatabaseCore;
  constructor(core: DatabaseCore) {
    this.#core = core;
  }

  /** The read positions of the files of one provider account. */
  files(provider: OutsideUsageProvider, accountRef: string): Map<string, OutsideUsageFile> {
    const rows = databaseRows(
      this.#core.connection
        .prepare("SELECT * FROM outside_usage_files WHERE provider = ? AND account_ref = ?")
        .all(provider, accountRef),
    );
    return new Map(
      rows.map((row) => {
        const file: OutsideUsageFile = {
          provider,
          accountRef,
          fileKey: requiredStringColumn(row, "file_key"),
          size: Number(row.size),
          mtimeMs: Number(row.mtime_ms),
          readOffset: Number(row.read_offset),
          state: requiredStringColumn(row, "state_json"),
        };
        return [file.fileKey, file];
      }),
    );
  }

  /**
   * Stores the entries read from one file and its new read position in one transaction. Entries of OpenBot
   * sessions are dropped here, in the same transaction that a bind writes, so a bind before or after the read
   * keeps the session out. A request that two lines or two files record keeps the largest value of each count.
   */
  ingest(batch: OutsideUsageBatch): number {
    const { file } = batch;
    return this.#core.dispatch(`outside-usage:${randomUUID()}`, [], (db) => {
      const owned = db.prepare(
        "SELECT 1 FROM openbot_provider_sessions WHERE provider = ? AND external_session_id = ?",
      );
      const ownedSessions = new Map<string, boolean>();
      const isOwned = (sessionId: string): boolean => {
        let value = ownedSessions.get(sessionId);
        if (value === undefined) {
          value = owned.get(file.provider, sessionId) !== undefined;
          ownedSessions.set(sessionId, value);
        }
        return value;
      };
      const existing = db.prepare("SELECT tokens_json FROM outside_usage_records WHERE record_key = ?");
      const write = db.prepare(
        `INSERT INTO outside_usage_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(record_key) DO UPDATE SET
           tokens_json = excluded.tokens_json,
           estimated_cost_usd = excluded.estimated_cost_usd,
           rate_basis = excluded.rate_basis,
           recorded_at = excluded.recorded_at`,
      );
      const now = new Date().toISOString();
      let stored = 0;
      for (const entry of batch.entries) {
        if (isOwned(entry.sessionId)) continue;
        const recordKey = sha256(`${file.provider}\0${entry.requestId}`);
        const previous = databaseRow(existing.get(recordKey));
        const tokens = previous
          ? mergeTokens(storedTokens(requiredStringColumn(previous, "tokens_json")), entry)
          : { ...entry.tokens, cacheWriteLong: entry.cacheWriteLong };
        const estimate = estimateRequestCost(file.provider, entry.model, tokens, tokens.cacheWriteLong);
        write.run(
          recordKey,
          file.provider,
          file.accountRef,
          outsideSessionKey(file.provider, entry.sessionId),
          entry.model,
          entry.occurredAt,
          JSON.stringify(tokens),
          estimate.cost,
          estimate.basis,
          now,
        );
        stored++;
      }
      db.prepare(
        `INSERT INTO outside_usage_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, account_ref, file_key) DO UPDATE SET
           size = excluded.size,
           mtime_ms = excluded.mtime_ms,
           read_offset = excluded.read_offset,
           state_json = excluded.state_json,
           scanned_at = excluded.scanned_at`,
      ).run(file.provider, file.accountRef, file.fileKey, file.size, file.mtimeMs, file.readOffset, file.state, now);
      return stored;
    });
  }

  read(raw: OutsideUsageInput, scannedAt: string | null): OutsideUsageReport {
    const input = parseOutsideUsageInput(raw);
    const rangeStart = new Date(Date.parse(input.startDate) - 86400000).toISOString();
    const rangeEnd = new Date(Date.parse(input.endDate) + 2 * 86400000).toISOString();
    const records = databaseRows(
      this.#core.connection
        .prepare("SELECT * FROM outside_usage_records WHERE occurred_at >= ? AND occurred_at < ?")
        .all(rangeStart, rangeEnd),
    );
    const totals = bucket();
    const days = new Map<string, Bucket>();
    for (
      let date = new Date(input.startDate);
      date.getTime() <= Date.parse(input.endDate);
      date.setUTCDate(date.getUTCDate() + 1)
    )
      days.set(date.toISOString().slice(0, 10), bucket());
    const models = new Map<string, { provider: string; model: string; bucket: Bucket }>();
    const providerDays = new Map<string, AnalyticsProviderDay>();
    let updatedAt: string | null = null;
    for (const row of records) {
      const occurred = requiredStringColumn(row, "occurred_at");
      const date = analyticsDate(new Date(occurred), input.timeZone);
      const day = days.get(date);
      if (!day) continue;
      const recorded = requiredStringColumn(row, "recorded_at");
      if (!updatedAt || recorded > updatedAt) updatedAt = recorded;
      const provider = requiredStringColumn(row, "provider");
      const model = requiredStringColumn(row, "model");
      const key = JSON.stringify([provider, model]);
      let entry = models.get(key);
      if (!entry) {
        entry = { provider, model, bucket: bucket() };
        models.set(key, entry);
      }
      const cellKey = JSON.stringify([date, provider]);
      let cell = providerDays.get(cellKey);
      if (!cell) {
        cell = { date, provider, processedTokens: 0, estimatedCostUsd: null };
        providerDays.set(cellKey, cell);
      }
      const tokens = decodeUsageTokens(JSON.parse(requiredStringColumn(row, "tokens_json")));
      const session = JSON.stringify([provider, requiredStringColumn(row, "session_key")]);
      for (const target of [totals, day, entry.bucket]) add(target, row, tokens, session);
      for (const tokenKey of TOKEN_KEYS) cell.processedTokens += tokens[tokenKey] ?? 0;
      if (typeof row.estimated_cost_usd === "number")
        cell.estimatedCostUsd = (cell.estimatedCostUsd ?? 0) + row.estimated_cost_usd;
    }
    const summary = finish(totals);
    return {
      ...input,
      scannedAt,
      updatedAt,
      totals: summary,
      daily: [...days].map(([date, item]) => ({ date, ...finish(item) })),
      models: [...models.values()]
        .map(({ provider, model, bucket: item }) => ({
          provider,
          model,
          ...finish(item),
          share: summary.processedTokens ? item.values.processedTokens / summary.processedTokens : 0,
        }))
        .sort((a, b) => b.processedTokens - a.processedTokens),
      providerDaily: [...providerDays.values()].sort(
        (a, b) => a.date.localeCompare(b.date) || a.provider.localeCompare(b.provider),
      ),
      sources: this.#sources(),
    };
  }

  #sources(): OutsideUsageSource[] {
    return databaseRows(
      this.#core.connection
        .prepare("SELECT provider, COUNT(*) AS files FROM outside_usage_files GROUP BY provider ORDER BY provider")
        .all(),
    ).map((row) => ({ provider: requiredStringColumn(row, "provider"), files: Number(row.files) }));
  }
}

interface StoredTokens extends UsageTokens {
  cacheWriteLong: number;
}

function storedTokens(json: string): StoredTokens {
  const value = JSON.parse(json);
  const long = databaseRow(value)?.cacheWriteLong;
  return { ...decodeUsageTokens(value), cacheWriteLong: typeof long === "number" ? long : 0 };
}

function mergeTokens(previous: StoredTokens, entry: OutsideUsageEntry): StoredTokens {
  const merged: StoredTokens = { ...previous, cacheWriteLong: Math.max(previous.cacheWriteLong, entry.cacheWriteLong) };
  for (const key of TOKEN_KEYS) {
    const before = previous[key];
    const next = entry.tokens[key];
    merged[key] = before === null ? next : next === null ? before : Math.max(before, next);
  }
  return merged;
}

interface Bucket {
  values: AnalyticsTotals;
  sessions: Set<string>;
}
function bucket(): Bucket {
  return { values: emptyAnalyticsTotals(), sessions: new Set() };
}
function add(target: Bucket, row: DynamicRecord, tokens: UsageTokens, session: string): void {
  target.sessions.add(session);
  // Each record is one provider request, so the report counts requests where OpenBot counts turns.
  target.values.turns++;
  for (const key of TOKEN_KEYS) {
    const value = tokens[key];
    if (value === null) continue;
    target.values[key] = (target.values[key] ?? 0) + value;
    target.values.processedTokens += value;
  }
  if (TOKEN_KEYS.some((key) => tokens[key] === null)) target.values.incompleteRecords++;
  if (typeof row.estimated_cost_usd === "number")
    target.values.estimatedCostUsd = (target.values.estimatedCostUsd ?? 0) + row.estimated_cost_usd;
  else target.values.unpricedRecords++;
}
function finish(item: Bucket): AnalyticsTotals {
  return { ...item.values, sessions: item.sessions.size };
}

/** Called inside a provider session bind or a thread replay: OpenBot ran this session, so it is not outside. */
export function claimProviderSession(
  db: DatabaseSync,
  provider: string,
  externalSessionId: string,
  createdAt: string,
): void {
  db.prepare("INSERT OR IGNORE INTO openbot_provider_sessions VALUES (?, ?, ?)").run(
    provider,
    externalSessionId,
    createdAt,
  );
  db.prepare("DELETE FROM outside_usage_records WHERE session_key = ?").run(
    outsideSessionKey(provider, externalSessionId),
  );
}
