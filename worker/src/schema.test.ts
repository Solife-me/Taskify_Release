import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.ts";

/**
 * The schema is the migrations' job (worker/migrations, applied before every deploy). The Worker
 * itself only reads and writes rows: schema statements at runtime would hide a migration that was
 * never applied, and cost D1 queries on the first request of every isolate and on every cron run.
 */
function recordingD1() {
  const statements: string[] = [];
  const statement = (sql: string) => {
    statements.push(sql.replace(/\s+/g, " ").trim());
    const prepared = {
      bind: () => prepared,
      run: async () => ({ success: true, meta: { changes: 0 } }),
      first: async () => null,
      all: async () => ({ results: [] }),
    };
    return prepared;
  };
  return {
    statements,
    db: { prepare: statement, batch: async (list: unknown[]) => list.map(() => ({ results: [] })) },
  };
}

const allowAll = () => ({ limit: async () => ({ success: true }) });
const schemaStatement = /^(CREATE|DROP|ALTER|PRAGMA)\b/i;

test("the Worker runs no schema statements: requests and the cron only touch rows", async () => {
  const { db, statements } = recordingD1();
  const env = {
    TASKIFY_DB: db,
    ASSETS: { fetch: async () => new Response("asset") },
    PUSH_RATE_LIMITER: allowAll(),
    VOICE_RATE_LIMITER: allowAll(),
    WATCH_NOSTR_RATE_LIMITER: allowAll(),
    PREVIEW_RATE_LIMITER: allowAll(),
    NIP05_RATE_LIMITER: allowAll(),
  } as any;

  // A route that uses the database, refused for its body before any row is touched.
  const response = await worker.fetch(
    new Request("https://taskify.solife.me/api/reminders", { method: "PUT", body: "{}", headers: { "Content-Type": "application/json" } }),
    env,
  );
  assert.equal(response.status, 400);
  await worker.scheduled({ scheduledTime: Date.now(), cron: "*/1 * * * *" } as any, env, undefined as any);

  assert.deepEqual(statements.filter((sql) => schemaStatement.test(sql)), []);
  assert.ok(statements.length > 0, "the cron still reads due reminders");
});
