import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { DEFAULT_PROVIDER_ACCOUNT_ID } from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { Duration, Effect, Schema, type Scope } from "effect";
import type { OutsideUsage, OutsideUsageFile, OutsideUsageProvider } from "../database/outside-usage";
import { decodeFileState, initialFileState, parseUsageLines } from "./outside-usage-parsers";

const logger = createOpenBotLogger("outside-usage");

/** The first read waits until the start has finished, and later reads run in the background. */
const FIRST_SCAN_DELAY = Duration.seconds(30);
const SCAN_INTERVAL = Duration.minutes(15);
/** A report starts a read when the last one is older than this. */
const REPORT_SCAN_AGE_MS = 60_000;
const FILE_CONCURRENCY = 4;
const CHUNK_BYTES = 8 * 1024 * 1024;
const HEAD_BYTES = 64;

class OutsideUsageReadFailed extends Schema.TaggedError<OutsideUsageReadFailed>()("OutsideUsageReadFailed", {
  cause: Schema.Defect(),
}) {}

/** A folder of CLI logs. `home` is the CLI's own folder; file keys are relative to it, so they hold no user path. */
export interface OutsideUsageRoot {
  provider: OutsideUsageProvider;
  accountRef: string;
  home: string;
  folders: readonly string[];
}

/**
 * The log folders of the CLIs' own sign-ins. The folders of OpenBot's added provider accounts are not here: only
 * OpenBot agents use them, so `AgentUsage` already counts their usage.
 */
export function defaultOutsideUsageRoots(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home = homedir(),
): OutsideUsageRoot[] {
  return [
    {
      provider: "claude",
      accountRef: DEFAULT_PROVIDER_ACCOUNT_ID,
      home: env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
      folders: ["projects"],
    },
    {
      provider: "codex",
      accountRef: DEFAULT_PROVIDER_ACCOUNT_ID,
      home: env.CODEX_HOME || join(home, ".codex"),
      // Codex moves a session file to `archived_sessions` when the user archives it. The record keys of its
      // requests do not change, so the moved file adds nothing.
      folders: ["sessions", "archived_sessions"],
    },
  ];
}

export interface OutsideUsageScannerOptions {
  usage: () => OutsideUsage;
  scope: () => Scope.Scope;
  roots?: () => readonly OutsideUsageRoot[];
}

export interface OutsideUsageScanSummary {
  files: number;
  readFiles: number;
  entries: number;
  failures: number;
}

/**
 * Reads the usage that the Claude and Codex CLIs log on this computer, for sessions OpenBot did not run. It reads
 * only the new lines of each file, and only the numbers of each usage line. A missing folder is no usage.
 */
export class OutsideUsageScanner {
  readonly #options: OutsideUsageScannerOptions;
  #scanning = false;
  #looping = false;
  #scannedAt: string | null = null;
  #lastStart = 0;

  constructor(options: OutsideUsageScannerOptions) {
    this.#options = options;
  }

  /** When the last read finished, or null before the first one. */
  scannedAt(): string | null {
    return this.#scannedAt;
  }

  /** Starts the periodic read in the owner's scope. Closing the scope stops it. */
  start(): void {
    if (this.#looping) return;
    this.#looping = true;
    const loop = Effect.sleep(FIRST_SCAN_DELAY).pipe(
      Effect.andThen(Effect.forever(this.scan().pipe(Effect.andThen(Effect.sleep(SCAN_INTERVAL))))),
      Effect.ensuring(Effect.sync(() => (this.#looping = false))),
    );
    Effect.runFork(loop.pipe(Effect.forkIn(this.#options.scope())));
  }

  /** Starts a read for a report when the last one is old. The report does not wait for it. */
  scanSoon(): void {
    if (this.#scanning || Date.now() - this.#lastStart < REPORT_SCAN_AGE_MS) return;
    Effect.runFork(this.scan().pipe(Effect.forkIn(this.#options.scope())));
  }

  readonly scan = Effect.fn("OutsideUsageScanner.scan")(function* (this: OutsideUsageScanner) {
    const summary: OutsideUsageScanSummary = { files: 0, readFiles: 0, entries: 0, failures: 0 };
    if (this.#scanning) return summary;
    this.#scanning = true;
    this.#lastStart = Date.now();
    yield* Effect.gen({ self: this }, function* () {
      for (const root of (this.#options.roots ?? defaultOutsideUsageRoots)()) {
        const known = yield* Effect.try({
          try: () => this.#options.usage().files(root.provider, root.accountRef),
          catch: (cause) => new OutsideUsageReadFailed({ cause }),
        });
        const files = (yield* Effect.forEach(root.folders, (folder) => logFiles(root.home, folder))).flat();
        summary.files += files.length;
        yield* Effect.forEach(
          files,
          (file) =>
            this.#readFile(root, file, known.get(fileKey(root.home, file))).pipe(
              Effect.tap((entries) =>
                Effect.sync(() => {
                  if (entries === null) return;
                  summary.readFiles++;
                  summary.entries += entries;
                }),
              ),
              Effect.catch((failure) =>
                Effect.sync(() => {
                  summary.failures++;
                  logger.warn("Could not read a provider usage log.", {
                    provider: root.provider,
                    code: errorCode(failure.cause),
                  });
                }),
              ),
            ),
          { concurrency: FILE_CONCURRENCY, discard: true },
        );
      }
      this.#scannedAt = new Date().toISOString();
      if (summary.readFiles > 0) logger.info("Read provider usage logs.", { ...summary });
    }).pipe(
      Effect.catch((failure) =>
        Effect.sync(() => logger.warn("Could not read provider usage logs.", { code: errorCode(failure.cause) })),
      ),
      Effect.ensuring(Effect.sync(() => (this.#scanning = false))),
    );
    return summary;
  }).bind(this);

  /** Reads the new lines of one file. Returns the number of entries stored, or null when the file did not change. */
  #readFile(root: OutsideUsageRoot, path: string, known: OutsideUsageFile | undefined) {
    const usage = this.#options.usage;
    return Effect.tryPromise({
      try: async () => {
        const info = await stat(path);
        const size = info.size;
        const mtimeMs = Math.trunc(info.mtimeMs);
        if (known && known.size === size && known.mtimeMs === mtimeMs) return null;
        const handle = await open(path, "r");
        try {
          const headBuffer = Buffer.alloc(Math.min(HEAD_BYTES, size));
          await handle.read(headBuffer, 0, headBuffer.length, 0);
          const head = createHash("sha256").update(headBuffer).digest("hex");
          let state = known ? decodeFileState(known.state) : null;
          let offset = known?.readOffset ?? 0;
          // A smaller file or new first bytes means the CLI wrote the file again: read it from the start.
          if (!known || !state || size < known.size || state.head !== head || offset > size) {
            state = initialFileState(head);
            offset = 0;
          }
          const file: OutsideUsageFile = {
            provider: root.provider,
            accountRef: root.accountRef,
            fileKey: fileKey(root.home, path),
            size,
            mtimeMs,
            readOffset: offset,
            state: JSON.stringify(state),
          };
          let stored = 0;
          let savedSize: number | null = null;
          let carry = Buffer.alloc(0);
          while (offset + carry.length < size) {
            const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, size - offset - carry.length));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset + carry.length);
            if (bytesRead === 0) break;
            const data = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
            const end = data.lastIndexOf(0x0a);
            if (end < 0) {
              carry = data;
              continue;
            }
            const entries = parseUsageLines(root.provider, data.subarray(0, end).toString("utf8"), state);
            offset += end + 1;
            carry = data.subarray(end + 1);
            // A part read stores its position with the size it reached, so the next read goes on from there.
            savedSize = offset + carry.length >= size ? size : offset;
            stored += usage().ingest({
              file: { ...file, size: savedSize, readOffset: offset, state: JSON.stringify(state) },
              entries,
            });
          }
          // An unfinished last line stays unread until the CLI writes its line break.
          if (savedSize !== size)
            usage().ingest({ file: { ...file, readOffset: offset, state: JSON.stringify(state) }, entries: [] });
          return stored;
        } finally {
          await handle.close();
        }
      },
      catch: (cause) => new OutsideUsageReadFailed({ cause }),
    });
  }
}

/** The `.jsonl` files under one folder of a CLI home. A missing folder has none. */
function logFiles(home: string, folder: string) {
  return Effect.tryPromise({
    try: async () => {
      const directory = join(home, folder);
      const names = await readdir(directory, { recursive: true }).catch((error: unknown) => {
        if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return [];
        throw error;
      });
      return names.filter((name) => name.endsWith(".jsonl")).map((name) => join(directory, name));
    },
    catch: (cause) => new OutsideUsageReadFailed({ cause }),
  });
}

/** A hash of the path inside the CLI home, so the database holds no folder or project name. */
function fileKey(home: string, path: string): string {
  return createHash("sha256").update(relative(home, path).split(sep).join("/")).digest("hex");
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unknown";
}
