import {
  type AgentAnalyticsInput,
  type AnalyticsDay,
  AnalyticsInputError,
  type AnalyticsModel,
  type AnalyticsProviderDay,
  type AnalyticsTotals,
  analyticsQuery,
  decodeAnalyticsDate,
  decodeAnalyticsProviderDays,
  decodeAnalyticsTimestamp,
  decodeAnalyticsTotals,
  parseAnalyticsRange,
} from "./ipc-agent-analytics";
import { isDynamicRecord, isString } from "./runtime-values";

export type OutsideUsageInput = Omit<AgentAnalyticsInput, "agentId">;

/** A provider whose CLI logs the host reads, and how many log files it has read. */
export interface OutsideUsageSource {
  provider: string;
  files: number;
}

/**
 * The usage that the Claude and Codex CLIs on the host logged for sessions OpenBot did not run. It is a separate
 * report: OpenBot totals never include it. `turns` counts provider requests, and the message counts stay zero.
 */
export interface OutsideUsageReport {
  startDate: string;
  endDate: string;
  timeZone: string;
  /** When the host last read the logs, or null before its first read. */
  scannedAt: string | null;
  updatedAt: string | null;
  totals: AnalyticsTotals;
  daily: AnalyticsDay[];
  models: AnalyticsModel[];
  providerDaily: AnalyticsProviderDay[];
  sources: OutsideUsageSource[];
}

export function parseOutsideUsageInput(value: unknown): OutsideUsageInput {
  return parseAnalyticsRange(value);
}

export function outsideUsageQuery(input: OutsideUsageInput): string {
  return analyticsQuery(input);
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : decodeAnalyticsTimestamp(value);
}

export function decodeOutsideUsageReport(value: unknown): OutsideUsageReport {
  const input = parseAnalyticsRange(value);
  if (
    !isDynamicRecord(value) ||
    !Array.isArray(value.daily) ||
    !Array.isArray(value.models) ||
    !Array.isArray(value.sources)
  )
    throw new AnalyticsInputError("Invalid outside usage.");
  return {
    ...input,
    scannedAt: nullableTimestamp(value.scannedAt),
    updatedAt: nullableTimestamp(value.updatedAt),
    totals: decodeAnalyticsTotals(value.totals),
    daily: value.daily.map((day) => {
      if (!isDynamicRecord(day)) throw new Error("Invalid daily outside usage.");
      return { ...decodeAnalyticsTotals(day), date: decodeAnalyticsDate(day.date) };
    }),
    models: value.models.map((model) => {
      if (
        !isDynamicRecord(model) ||
        !isString(model.provider) ||
        !isString(model.model) ||
        model.model.length > 256 ||
        model.provider.length > 100 ||
        typeof model.share !== "number" ||
        !(model.share >= 0 && model.share <= 1)
      )
        throw new Error("Invalid outside usage model.");
      return { ...decodeAnalyticsTotals(model), provider: model.provider, model: model.model, share: model.share };
    }),
    providerDaily: decodeAnalyticsProviderDays(value.providerDaily),
    sources: value.sources.map((source) => {
      if (
        !isDynamicRecord(source) ||
        !isString(source.provider) ||
        source.provider.length > 100 ||
        typeof source.files !== "number" ||
        !Number.isSafeInteger(source.files) ||
        source.files < 0
      )
        throw new Error("Invalid outside usage source.");
      return { provider: source.provider, files: source.files };
    }),
  };
}

export function decodeOptionalOutsideUsageReport(value: unknown): OutsideUsageReport | null {
  return value === null ? null : decodeOutsideUsageReport(value);
}

export function assertOutsideUsageScope(result: OutsideUsageReport, input: OutsideUsageInput): OutsideUsageReport {
  if (result.startDate !== input.startDate || result.endDate !== input.endDate || result.timeZone !== input.timeZone)
    throw new Error("Outside usage response does not match the request.");
  return result;
}
