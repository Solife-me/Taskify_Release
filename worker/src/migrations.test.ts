import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const directory = new URL("../migrations/", import.meta.url);
const migrations = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();

function tables(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

test("the migrations leave none of the retired calendar integrations' data behind", () => {
  // Production's D1 still had these: the CalDAV and first Google Calendar integrations predate
  // the migrations directory, so no migration created or dropped them. They hold account emails,
  // OAuth tokens, a password hash and calendar events.
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE caldav_accounts (npub TEXT PRIMARY KEY, password_salt TEXT, password_hash TEXT, enabled INTEGER, board_ids TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE caldav_events (uid TEXT PRIMARY KEY, npub TEXT, board_id TEXT, summary TEXT, description TEXT, start_iso TEXT, due_iso TEXT, recurrence TEXT, reminders TEXT, raw_ical TEXT, updated_at INTEGER);
    CREATE TABLE google_calendar_accounts (client_id TEXT PRIMARY KEY, connected INTEGER, account_email TEXT, calendar_id TEXT, time_zone TEXT, access_token TEXT, refresh_token TEXT, token_expires_at INTEGER, inbound_board_id TEXT, outbound_board_ids TEXT, last_sync_iso TEXT, sync_token TEXT, updated_at INTEGER);
    CREATE TABLE google_calendar_sessions (state TEXT PRIMARY KEY, client_id TEXT, created_at INTEGER);
    CREATE TABLE google_calendar_state (id INTEGER PRIMARY KEY, connected INTEGER, account_email TEXT, calendar_id TEXT, inbound_board_id TEXT, outbound_board_ids TEXT, last_sync_iso TEXT, sync_token TEXT, updated_at INTEGER);
    INSERT INTO caldav_accounts VALUES ('npub1', 'salt', 'hash', 1, '[]', 1, 1);
    INSERT INTO google_calendar_state VALUES (1, 1, 'someone@example.com', 'primary', NULL, '[]', NULL, NULL, 1);
  `);
  for (const name of migrations) db.exec(readFileSync(new URL(name, directory), "utf8"));
  db.exec("INSERT INTO devices (device_id, platform, endpoint, endpoint_hash, subscription_auth, subscription_p256dh, updated_at) VALUES ('d', 'ios', 'https://web.push.apple.com/x', 'h', 'a', 'p', 1)");

  const remaining = tables(db).filter((name) => /^(caldav_|google_calendar_|gcal_)/.test(name));
  assert.deepEqual(remaining, []);
  assert.ok(tables(db).includes("reminders"), "reminders are kept");
  assert.equal((db.prepare("SELECT count(*) AS n FROM devices").get() as { n: number }).n, 1);
});

test("every migration can run again on a database that already has it", () => {
  // Production applied only 0001 through wrangler; later tables were made by ensureSchema, so the
  // first `migrations apply` runs migrations whose tables already exist.
  const db = new DatabaseSync(":memory:");
  for (const name of migrations) db.exec(readFileSync(new URL(name, directory), "utf8"));
  for (const name of migrations) {
    assert.doesNotThrow(() => db.exec(readFileSync(new URL(name, directory), "utf8")), name);
  }
});
