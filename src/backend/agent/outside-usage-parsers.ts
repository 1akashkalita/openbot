import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import type { OutsideUsageEntry, OutsideUsageProvider } from "../database/outside-usage";

/**
 * What the reader keeps between two reads of one log file. `head` is a hash of the first bytes, so a file that a
 * CLI wrote again from the start is read again. The Codex fields carry the session, its model and the kind of
 * usage line the file uses, because one line does not carry all of them.
 */
export interface OutsideUsageFileState {
  head: string;
  sessionId: string | null;
  model: string | null;
  /** OpenBot started this Codex session, so `AgentUsage` already counts it. */
  skip: boolean;
  /** The file has `token_usage_record` lines, which also come as `token_count` events. */
  records: boolean;
  /** The last `token_count` totals, because Codex sends the same event again with no new request. */
  lastCount: string | null;
}

export function initialFileState(head: string): OutsideUsageFileState {
  return { head, sessionId: null, model: null, skip: false, records: false, lastCount: null };
}

export function decodeFileState(json: string): OutsideUsageFileState | null {
  try {
    const value = JSON.parse(json);
    if (!isDynamicRecord(value) || typeof value.head !== "string") return null;
    const text = (field: unknown) => (typeof field === "string" ? field : null);
    return {
      head: value.head,
      sessionId: text(value.sessionId),
      model: text(value.model),
      skip: value.skip === true,
      records: value.records === true,
      lastCount: text(value.lastCount),
    };
  } catch {
    return null;
  }
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function text(value: unknown, max = 256): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function time(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

/** Parses a line only after a cheap text check, so most lines with prompts and tool output are never parsed. */
function parse(line: string): DynamicRecord | null {
  try {
    const value = JSON.parse(line);
    return isDynamicRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function claudeEntry(line: string): OutsideUsageEntry | null {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return null;
  const value = parse(line);
  if (value?.type !== "assistant" || !isDynamicRecord(value.message)) return null;
  const message = value.message;
  const usage = message.usage;
  const model = text(message.model);
  const messageId = text(message.id);
  const sessionId = text(value.sessionId);
  const occurredAt = time(value.timestamp);
  // `<synthetic>` marks a message that the CLI made itself, such as an API error. No request ran.
  if (!isDynamicRecord(usage) || !model || model.startsWith("<") || !messageId || !sessionId || !occurredAt)
    return null;
  const cacheCreation = isDynamicRecord(usage.cache_creation) ? usage.cache_creation : null;
  return {
    requestId: `${messageId}\0${text(value.requestId) ?? ""}`,
    sessionId,
    model,
    occurredAt,
    tokens: {
      uncachedInput: count(usage.input_tokens),
      cachedInput: count(usage.cache_read_input_tokens) ?? 0,
      cacheCreation: count(usage.cache_creation_input_tokens) ?? 0,
      output: count(usage.output_tokens),
    },
    cacheWriteLong: count(cacheCreation?.ephemeral_1h_input_tokens) ?? 0,
  };
}

function codexTokens(usage: unknown): OutsideUsageEntry["tokens"] | null {
  if (!isDynamicRecord(usage)) return null;
  const input = count(usage.input_tokens);
  const cached = count(usage.cached_input_tokens) ?? 0;
  return {
    uncachedInput: input !== null && cached <= input ? input - cached : null,
    cachedInput: cached,
    cacheCreation: count(usage.cache_write_input_tokens) ?? 0,
    output: count(usage.output_tokens),
  };
}

function codexEntry(line: string, state: OutsideUsageFileState): OutsideUsageEntry | null {
  if (line.includes('"session_meta"')) {
    const value = parse(line);
    if (value?.type === "session_meta" && isDynamicRecord(value.payload)) {
      // Codex writes the name of the client that started the session. OpenBot's app-server client is "openbot".
      if (value.payload.originator === "openbot") state.skip = true;
      state.sessionId = text(value.payload.id) ?? state.sessionId;
    }
    return null;
  }
  if (line.includes('"turn_context"')) {
    const value = parse(line);
    if (value?.type === "turn_context" && isDynamicRecord(value.payload))
      state.model = text(value.payload.model) ?? state.model;
    return null;
  }
  const record = line.includes('"token_usage_record"');
  if (!record && !line.includes('"token_count"')) return null;
  const value = parse(line);
  const payload = isDynamicRecord(value?.payload) ? value.payload : null;
  const occurredAt = time(value?.timestamp);
  if (!payload || !occurredAt) return null;
  if (record && value?.type === "token_usage_record") {
    state.records = true;
    const responseId = text(payload.response_id);
    const sessionId = text(payload.thread_id) ?? state.sessionId;
    const tokens = codexTokens(payload.usage);
    if (state.skip || !responseId || !sessionId || !tokens) return null;
    return { requestId: responseId, sessionId, model: state.model ?? "unknown", occurredAt, tokens, cacheWriteLong: 0 };
  }
  // A file with request records repeats each of them as a `token_count` event.
  if (value?.type !== "event_msg" || payload.type !== "token_count" || state.records) return null;
  const info = isDynamicRecord(payload.info) ? payload.info : null;
  if (!info) return null;
  const total = JSON.stringify(info.total_token_usage ?? null);
  if (total === state.lastCount) return null;
  state.lastCount = total;
  const tokens = codexTokens(info.last_token_usage);
  if (state.skip || !state.sessionId || !tokens) return null;
  // The time and the session totals name the request, so a copy of the line in a forked session is the same one.
  return {
    requestId: `count\0${occurredAt}\0${total}`,
    sessionId: state.sessionId,
    model: state.model ?? "unknown",
    occurredAt,
    tokens,
    cacheWriteLong: 0,
  };
}

/**
 * Reads the usage lines of a part of a log file that ends at a line break. It copies only numbers, ids, model
 * names and times; prompts, output, paths and working folders stay in the file. A request that several lines
 * record, such as one Claude line per content block, is one entry with the largest value of each count.
 */
export function parseUsageLines(
  provider: OutsideUsageProvider,
  chunk: string,
  state: OutsideUsageFileState,
): OutsideUsageEntry[] {
  const entries = new Map<string, OutsideUsageEntry>();
  for (const line of chunk.split("\n")) {
    if (!line) continue;
    const entry = provider === "claude" ? claudeEntry(line) : codexEntry(line, state);
    if (!entry) continue;
    const previous = entries.get(entry.requestId);
    entries.set(entry.requestId, previous ? mergeEntries(previous, entry) : entry);
  }
  return [...entries.values()];
}

function mergeEntries(previous: OutsideUsageEntry, next: OutsideUsageEntry): OutsideUsageEntry {
  const tokens = { ...previous.tokens };
  for (const key of ["uncachedInput", "cachedInput", "cacheCreation", "output"] as const) {
    const before = previous.tokens[key];
    const after = next.tokens[key];
    tokens[key] = before === null ? after : after === null ? before : Math.max(before, after);
  }
  return { ...previous, tokens, cacheWriteLong: Math.max(previous.cacheWriteLong, next.cacheWriteLong) };
}
