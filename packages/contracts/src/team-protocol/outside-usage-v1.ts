// Frozen optional outside-usage-v1 wire contract.
//
// What it grants, recorded here because freezing it makes it permanent: any signed-in member of a
// server reads the token and cost totals that the Claude and Codex CLIs on the host logged for
// sessions OpenBot did not run. The report holds counts, costs, dates, provider names, model names
// and the number of log files per provider; never a path, prompt, project or session id. The range
// rules are the ones of `/v1/analytics`: at most 367 days and an IANA time zone. Bounds and meaning
// do not follow IPC changes; widening any of it needs a second capability string.
import {
  type AdminDecoder,
  adminRoute,
  count,
  fields,
  list,
  nullable,
  type OptionalRouteCodec,
  string,
} from "./admin-wire";

export const OUTSIDE_USAGE_CAPABILITY = "outside-usage-v1";

export const OUTSIDE_USAGE_ROUTES = {
  read: "/v1/analytics/outside",
} as const;

const DAY_LIMIT = 367;
const MODEL_LIMIT = 1_000;
const PROVIDER_DAY_LIMIT = DAY_LIMIT * 10;
const SOURCE_LIMIT = 10;

const amount: AdminDecoder = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid usage amount.");
  return value;
};
const share: AdminDecoder = (value) => {
  if (typeof value !== "number" || !(value >= 0 && value <= 1)) throw new Error("Invalid usage share.");
  return value;
};
const date = string(10);
const time = string(64);
const provider = string(100);

const totals = {
  uncachedInput: nullable(count),
  cachedInput: nullable(count),
  cacheCreation: nullable(count),
  output: nullable(count),
  processedTokens: count,
  estimatedCostUsd: nullable(amount),
  sessions: count,
  userMessages: count,
  assistantMessages: count,
  turns: count,
  missingUsageTurns: count,
  unpricedRecords: count,
  incompleteRecords: count,
};

const range = { startDate: date, endDate: date, timeZone: string(100) };

export const OUTSIDE_USAGE_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    OUTSIDE_USAGE_ROUTES.read,
    adminRoute(
      fields(range),
      fields({
        ...range,
        scannedAt: nullable(time),
        updatedAt: nullable(time),
        totals: fields(totals),
        daily: list(fields({ ...totals, date }), DAY_LIMIT),
        models: list(fields({ ...totals, provider, model: string(256), share }), MODEL_LIMIT),
        providerDaily: list(
          fields({ date, provider, processedTokens: count, estimatedCostUsd: nullable(amount) }),
          PROVIDER_DAY_LIMIT,
        ),
        sources: list(fields({ provider, files: count }), SOURCE_LIMIT),
      }),
    ),
  ],
]);
