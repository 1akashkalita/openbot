// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

// Failure modes: an upgrade loses or changes a thread or a provider session; a session OpenBot ran is not copied,
// so its CLI log counts as outside usage; a partial migration survives a failure; a retry fails on the tables that
// the failed run left; a newer or incomplete history is changed.
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function databaseAt(version: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TEMP TRIGGER stop_at_version BEFORE INSERT ON schema_migrations WHEN new.version > ${version}
    BEGIN SELECT RAISE(ABORT, 'fixture stop'); END;`);
  expect(() => migrateOpenBotDatabase(db)).toThrow(`migration to version ${version + 1} failed`);
  db.exec("DROP TRIGGER stop_at_version");
  return db;
}

// Two threads with Claude and Codex sessions, as OpenBot stores them. They are inactive: an older migration makes
// every active session inactive, and that change is not this migration's.
function seedSessions(db: DatabaseSync): void {
  db.exec(`INSERT INTO projection_threads VALUES
      ('openbot-thread-chief', 'chief', 'Chief', NULL, '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z', 1),
      ('openbot-thread-writer', 'writer', 'Writer', NULL, '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z', 1);
    INSERT INTO projection_provider_sessions
      (id, thread_id, provider, external_session_id, model, effort, state, created_at, updated_at, resume_cursor,
        last_event_sequence)
    VALUES
      ('session-1', 'openbot-thread-chief', 'claude', 'claude-session-1', 'claude-sonnet-4-5', 'medium', 'inactive',
        '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z', NULL, 1),
      ('session-2', 'openbot-thread-chief', 'codex', 'codex-session-1', 'gpt-5.1', 'medium', 'inactive',
        '2026-10-01T10:00:00.000Z', '2026-10-01T11:00:00.000Z', 'cursor-1', 2),
      ('session-3', 'openbot-thread-writer', 'claude', 'claude-session-2', 'claude-opus-4-1', 'high', 'inactive',
        '2026-10-02T10:00:00.000Z', '2026-10-02T10:00:00.000Z', NULL, 3);`);
}

function contents(db: DatabaseSync) {
  return {
    threads: db.prepare("SELECT * FROM projection_threads ORDER BY thread_id").all(),
    sessions: db.prepare("SELECT * FROM projection_provider_sessions ORDER BY id").all(),
  };
}

function outsideTables(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE name IN ('outside_usage_records', 'outside_usage_files', 'openbot_provider_sessions') ORDER BY name`,
    )
    .all()
    .map((row) => row.name);
}

function expectCopiedSessions(db: DatabaseSync): void {
  const applied_at = db.prepare("SELECT applied_at FROM schema_migrations WHERE version = 44").get()?.applied_at;
  expect(typeof applied_at).toBe("string");
  expect(db.prepare("SELECT * FROM openbot_provider_sessions ORDER BY provider, external_session_id").all()).toEqual([
    { provider: "claude", external_session_id: "claude-session-1", created_at: applied_at },
    { provider: "claude", external_session_id: "claude-session-2", created_at: applied_at },
    { provider: "codex", external_session_id: "codex-session-1", created_at: applied_at },
  ]);
  expect(db.prepare("SELECT COUNT(*) AS count FROM outside_usage_records").get()).toEqual({ count: 0 });
  expect(db.prepare("SELECT COUNT(*) AS count FROM outside_usage_files").get()).toEqual({ count: 0 });
}

function expectHealthy(db: DatabaseSync): void {
  expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 44 });
  expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
}

const OUTSIDE_TABLES = ["openbot_provider_sessions", "outside_usage_files", "outside_usage_records"];

describe("outside usage migration", () => {
  // The thread and provider session tables keep these columns from the v8 baseline on, so the oldest and the
  // newest released schema bound them.
  it.each([8, 43])("upgrades v%i, keeps every thread and session, and copies the sessions", (version) => {
    const db = databaseAt(version);
    seedSessions(db);
    const before = contents(db);
    migrateOpenBotDatabase(db);
    expect(contents(db)).toEqual(before);
    expect(outsideTables(db)).toEqual(OUTSIDE_TABLES);
    expectCopiedSessions(db);
    expectHealthy(db);
  });

  it("rolls back the tables, the copy and the marker after a failure, then retries", () => {
    const db = databaseAt(43);
    seedSessions(db);
    const before = contents(db);
    db.exec(`CREATE TEMP TRIGGER fail_marker BEFORE INSERT ON schema_migrations WHEN new.version = 44
      BEGIN SELECT RAISE(ABORT, 'late failure'); END;`);
    expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 44 failed");
    expect(outsideTables(db)).toEqual([]);
    expect(contents(db)).toEqual(before);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 44").all()).toEqual([]);
    db.exec("DROP TRIGGER fail_marker");
    migrateOpenBotDatabase(db);
    expect(contents(db)).toEqual(before);
    expectCopiedSessions(db);
    expectHealthy(db);
  });

  it("rolls back when the session copy fails, then retries", () => {
    const db = databaseAt(43);
    seedSessions(db);
    const before = contents(db);
    // IF NOT EXISTS keeps the squatting table, so the copy into it fails after the other tables exist.
    db.exec("CREATE TABLE openbot_provider_sessions (conflict TEXT)");
    expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 44 failed");
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 44").all()).toEqual([]);
    expect(outsideTables(db)).toEqual(["openbot_provider_sessions"]);
    expect(contents(db)).toEqual(before);
    db.exec("DROP TABLE openbot_provider_sessions");
    migrateOpenBotDatabase(db);
    expect(contents(db)).toEqual(before);
    expectCopiedSessions(db);
    expectHealthy(db);
  });

  it("rejects newer and incomplete migration histories before it adds the tables", () => {
    const db = databaseAt(43);
    seedSessions(db);
    const before = contents(db);
    db.exec("INSERT INTO schema_migrations VALUES(45, 'now')");
    expect(() => migrateOpenBotDatabase(db)).toThrow("newer than this application supports");
    db.exec("DELETE FROM schema_migrations WHERE version = 45; DELETE FROM schema_migrations WHERE version = 20");
    expect(() => migrateOpenBotDatabase(db)).toThrow("missing version 20");
    expect(contents(db)).toEqual(before);
    expect(outsideTables(db)).toEqual([]);
  });
});
