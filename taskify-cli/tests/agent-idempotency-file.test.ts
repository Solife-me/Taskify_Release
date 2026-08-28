import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createFileAgentIdempotencyStore,
  getAgentIdempotencyStore,
} from "../src/shared/agentIdempotency.ts";

test("file idempotency store survives separate instances", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "taskify-idempotency-"));
  try {
    const file = path.join(dir, "idempotency.json");
    await createFileAgentIdempotencyStore(file).set("profile:add-42", "task-42");
    assert.equal(await createFileAgentIdempotencyStore(file).get("profile:add-42"), "task-42");
    assert.doesNotMatch(readFileSync(file, "utf-8"), /nsec|walletSeed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file idempotency store expires old entries", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "taskify-idempotency-"));
  try {
    const file = path.join(dir, "idempotency.json");
    const store = createFileAgentIdempotencyStore(file, { now: () => 1_000, ttlMs: 100 });
    await store.set("key", "task-1");
    const later = createFileAgentIdempotencyStore(file, { now: () => 1_101, ttlMs: 100 });
    assert.equal(await later.get("key"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file idempotency store atomically reserves one task id", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "taskify-idempotency-"));
  try {
    const file = path.join(dir, "idempotency.json");
    const firstStore = createFileAgentIdempotencyStore(file);
    const secondStore = createFileAgentIdempotencyStore(file);
    const [first, second] = await Promise.all([
      firstStore.reserve("profile:board:add-42", "task-first"),
      secondStore.reserve("profile:board:add-42", "task-second"),
    ]);

    assert.equal(first.taskId, second.taskId);
    assert.equal([first.created, second.created].filter(Boolean).length, 1);
    assert.equal(await firstStore.get("profile:board:add-42"), first.taskId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("in-memory compatibility store atomically reserves one task id", async () => {
  const store = getAgentIdempotencyStore();
  const key = `compat:${crypto.randomUUID()}`;
  const [first, second] = await Promise.all([
    store.reserve(key, "task-first"),
    store.reserve(key, "task-second"),
  ]);

  assert.equal(first.taskId, second.taskId);
  assert.equal([first.created, second.created].filter(Boolean).length, 1);
});
