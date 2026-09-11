import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverRelayHistory } from '../src/history.ts';

function fixture(events: any[], cap = Infinity) {
  const requested: any[] = [];
  let released = 0;
  return {
    requested, get released() { return released; },
    async subscribe(filters: any[], options: any) {
      const filter = filters[0]; requested.push(filter);
      assert.equal(options.skipSince, true);
      assert.equal(options.relayUrls.length, 1);
      setTimeout(() => {
        events.filter(e => e.created_at <= filter.until && e.created_at >= filter.since)
          .sort((a, b) => b.created_at - a.created_at).slice(0, Math.min(filter.limit, cap))
          .forEach(e => options.onEvent(e));
        options.onEose();
      }, 0);
      return { filters, release() { released++; } };
    },
  };
}

test('recovers older records beyond a relay cap and includes same-second page boundaries', async () => {
  const events = Array.from({ length: 13 }, (_, i) => ({ id: String(i), created_at: 100 - Math.floor(i / 2) }));
  const session = fixture(events, 3);
  const delivered: string[] = [];
  await recoverRelayHistory(session as any, { kinds: [30301] }, 'wss://relay.test', async e => { delivered.push(e.id); }, { pageSize: 5 });
  assert.deepEqual(new Set(delivered), new Set(events.map(e => e.id)));
  assert.equal(delivered.length, events.length);
  assert.equal(session.released, session.requested.length);
});

test('does not call an interrupted page complete', async () => {
  let released = false;
  const session = { async subscribe() { return { filters: [], release() { released = true; } }; } };
  await assert.rejects(recoverRelayHistory(session as any, {}, 'wss://relay.test', async () => {}, { timeoutMs: 5 }), /timed out/);
  assert.equal(released, true);
});

test('does not silently skip a saturated single timestamp', async () => {
  const session = fixture(Array.from({ length: 9 }, (_, i) => ({ id: String(i), created_at: 100 })));
  await assert.rejects(recoverRelayHistory(session as any, {}, 'wss://relay.test', async () => {}, { pageSize: 2, maxPageSize: 4 }), /timestamp/);
});

test('cancels a pending page and releases a late subscription exactly once', async () => {
  const controller = new AbortController();
  let ready!: (managed: any) => void;
  let released = 0;
  const session = { subscribe: () => new Promise<any>(resolve => { ready = resolve; }) };
  const result = recoverRelayHistory(session, {}, 'wss://relay.test', async () => {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(result, /cancelled/);
  ready({ filters: [], release() { released++; } });
  await Promise.resolve();
  assert.equal(released, 1);
});
