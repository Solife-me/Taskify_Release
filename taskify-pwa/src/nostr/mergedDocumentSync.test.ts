import { describe, expect, test, vi } from "vitest";
import { MergedDocumentSync, type MergedDocumentDeps, type SyncEvent, type SyncState } from "./mergedDocumentSync";

/** A toy document: a set of read chapters. Merge = base-aware union with deletions. */
type Doc = { read: string[] };
const sanitize = (raw: unknown): Doc => ({ read: Array.isArray((raw as Doc)?.read) ? [...(raw as Doc).read].sort() : [] });
function merge(base: Doc | null, local: Doc, incoming: Doc): Doc {
  const set = new Set([...local.read, ...incoming.read]);
  if (base) {
    // Removed on either side since the base: stays removed.
    for (const item of base.read) {
      if (!local.read.includes(item) || !incoming.read.includes(item)) set.delete(item);
    }
  }
  return { read: [...set].sort() };
}
const config = { dTag: "bible", kind: 30078, payloadKey: "doc", sanitize, merge, syncKey: (d: Doc) => d.read.join(","), extraTags: [["client", "taskify"]] };

/** A relay holding the latest copy, shared by simulated devices. */
function relay() {
  let latest: SyncEvent | null = null;
  let n = 0;
  return {
    get latest() { return latest; },
    publish: async (template: { kind: number; content: string; tags: string[][]; created_at: number }) => {
      latest = { ...template, id: `ev${++n}` };
      return { eventId: latest.id!, createdAt: template.created_at };
    },
    fetchLatest: async () => latest,
  };
}

function device(shared: ReturnType<typeof relay>, initial: Doc, clock: { now: number }) {
  let local = initial;
  let stored: { state: SyncState | null; base: unknown } = { state: null, base: null };
  const timers: Array<() => void> = [];
  const deps: MergedDocumentDeps<Doc> = {
    storage: {
      loadState: () => stored.state,
      saveState: (state) => { stored = { ...stored, state }; },
      loadBase: () => stored.base,
      saveBase: (base) => { stored = { ...stored, base }; },
    },
    getLocal: () => local,
    updateLocal: (update) => { local = update(local); },
    encrypt: async (payload) => JSON.stringify(payload),
    decrypt: async (content) => JSON.parse(content),
    publish: shared.publish,
    fetchLatest: shared.fetchLatest,
    nowSeconds: () => clock.now,
    setTimer: (run) => { timers.push(run); return timers.length; },
    clearTimer: () => {},
    onPublishError: vi.fn(),
  };
  const sync = new MergedDocumentSync(config, deps);
  sync.setIdentity("me");
  return {
    sync,
    deps,
    get local() { return local; },
    edit: (next: Doc) => { local = next; sync.noteLocalChange(); },
    /** Runs pending debounced publishes. */
    flush: async () => { for (const run of timers.splice(0)) run(); await new Promise((r) => setTimeout(r, 0)); },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("merged document sync", () => {
  test("first use: after pulling nothing, the device publishes what it has, marked as never synced", async () => {
    const shared = relay();
    const a = device(shared, { read: ["gen1"] }, { now: 100 });
    await a.sync.pull();
    a.sync.noteLocalChange();
    await settle();
    const payload = JSON.parse(shared.latest!.content);
    expect(payload).toMatchObject({ version: 1, baseTimestamp: 0, doc: { read: ["gen1"] } });
    expect(shared.latest!.tags).toEqual([["d", "bible"], ["client", "taskify"]]);
  });

  test("a second device merges with what it already had instead of losing it", async () => {
    const shared = relay();
    const clock = { now: 100 };
    const a = device(shared, { read: ["gen1"] }, clock);
    await a.sync.pull();
    a.sync.noteLocalChange();
    await settle();
    const b = device(shared, { read: ["exo1"] }, clock);
    await b.sync.pull();
    expect(b.local.read).toEqual(["exo1", "gen1"]);
  });

  test("edits on two devices since the last sync both survive; a removal on one side stays removed", async () => {
    const shared = relay();
    const clock = { now: 100 };
    const a = device(shared, { read: ["gen1", "gen2"] }, clock);
    await a.sync.pull();
    a.sync.noteLocalChange();
    await settle();
    const b = device(shared, { read: [] }, clock);
    await b.sync.pull(); // both now at base {gen1, gen2}
    b.sync.noteLocalChange();

    clock.now = 200;
    a.edit({ read: ["gen1", "gen2", "gen3"] }); // a adds gen3
    await a.flush();
    clock.now = 300;
    b.edit({ read: ["gen1"] }); // b removed gen2 meanwhile, then sees a's copy
    await b.sync.applyEvent(shared.latest!);
    expect(b.local.read).toEqual(["gen1", "gen3"]);
  });

  test("its own echo and older copies are ignored", async () => {
    const shared = relay();
    const a = device(shared, { read: ["gen1"] }, { now: 100 });
    await a.sync.pull();
    a.sync.noteLocalChange();
    await settle();
    const echo = shared.latest!;
    a.edit({ read: ["gen1", "gen2"] });
    await a.sync.applyEvent(echo);
    expect(a.local.read).toEqual(["gen1", "gen2"]);
    await a.sync.applyEvent({ ...echo, id: "older", created_at: 50, content: JSON.stringify({ version: 1, timestamp: 50, doc: { read: [] } }) });
    expect(a.local.read).toEqual(["gen1", "gen2"]);
  });

  test("an unreadable copy, another d tag or another version changes nothing", async () => {
    const shared = relay();
    const a = device(shared, { read: ["gen1"] }, { now: 100 });
    await a.sync.applyEvent({ id: "x", kind: 30078, created_at: 500, tags: [["d", "bible"]], content: "not json" });
    await a.sync.applyEvent({ id: "y", kind: 30078, created_at: 500, tags: [["d", "other"]], content: JSON.stringify({ version: 1, timestamp: 500, doc: { read: [] } }) });
    await a.sync.applyEvent({ id: "z", kind: 30078, created_at: 500, tags: [["d", "bible"]], content: JSON.stringify({ version: 2, timestamp: 500, doc: { read: [] } }) });
    expect(a.local.read).toEqual(["gen1"]);
    expect(a.sync.state.lastTimestamp).toBe(0);
  });

  test("changes publish after the pause, once, and never overlap", async () => {
    const shared = relay();
    const a = device(shared, { read: [] }, { now: 100 });
    await a.sync.pull();
    a.sync.noteLocalChange(); // first publish
    await settle();
    const publish = vi.spyOn(a.deps, "publish");
    a.edit({ read: ["gen1"] });
    a.edit({ read: ["gen1", "gen2"] });
    expect(publish).not.toHaveBeenCalled();
    await a.flush();
    expect(JSON.parse(shared.latest!.content).doc.read).toEqual(["gen1", "gen2"]);
  });

  test("nothing publishes before the first pull finishes", async () => {
    const shared = relay();
    const a = device(shared, { read: ["gen1"] }, { now: 100 });
    a.sync.noteLocalChange();
    await settle();
    expect(shared.latest).toBeNull();
  });

  test("switching keys starts over: the old base is not merged into the new account", async () => {
    const shared = relay();
    const a = device(shared, { read: ["gen1"] }, { now: 100 });
    await a.sync.pull();
    a.sync.noteLocalChange();
    await settle();
    a.sync.setIdentity("someone-else");
    expect(a.sync.state).toEqual({ lastEventId: null, lastTimestamp: 0, pubkey: "someone-else" });
  });
});
