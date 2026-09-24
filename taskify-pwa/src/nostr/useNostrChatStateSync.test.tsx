// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { decryptNostrSyncPayload, encryptNostrSyncPayload } from "../nostrAppState";
import { chatStateSyncBus } from "./chatStateSyncBus";
import { useNostrChatStateSync } from "./useNostrChatStateSync";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const secret = new Uint8Array(32).fill(7);
const pubkey = getPublicKey(secret);
const skHex = bytesToHex(secret);

function setup(initial: { localInboxResponses?: Record<string, any>; pendingInboxEventIds?: string[] } = {}) {
  const published: any[] = [];
  let deliver: ((event: any) => void) | null = null;
  const pool = {
    setRelays: () => {},
    subscribe: (_relays: string[], _filters: unknown[], onEvent: (event: any) => void) => {
      deliver = onEvent;
      return () => { deliver = null; };
    },
  };
  const nostrPublishRef = {
    current: vi.fn(async (_relays: string[], template: any, options: any) => {
      const event = finalizeEvent({ ...template, pubkey }, options.sk);
      published.push(event);
      return { event, createdAt: event.created_at };
    }),
  };
  const applyRemoteInboxResponses = vi.fn();
  let props = {
    enabled: true,
    defaultRelays: ["wss://relay.test"],
    nostrPK: pubkey,
    nostrPublishRef: nostrPublishRef as any,
    nostrSK: secret,
    pool,
    tagValue: (event: any, name: string) => event.tags.find((tag: string[]) => tag[0] === name)?.[1],
    localInboxResponses: initial.localInboxResponses ?? {},
    pendingInboxEventIds: initial.pendingInboxEventIds ?? [],
    applyRemoteInboxResponses,
  };
  function Harness(next: typeof props) {
    useNostrChatStateSync(next);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  return {
    published,
    applyRemoteInboxResponses,
    render: async (overrides: Partial<typeof props> = {}) => {
      props = { ...props, ...overrides };
      await act(async () => root.render(<Harness {...props} />));
    },
    deliver: async (event: any) => {
      await act(async () => { await deliver?.(event); });
    },
    unmount: async () => act(async () => root.unmount()),
  };
}

async function remoteEvent(payload: Record<string, unknown>, createdAt: number) {
  const content = await encryptNostrSyncPayload({ version: 1, timestamp: createdAt, ...payload }, skHex, pubkey);
  return finalizeEvent({ kind: 30078, created_at: createdAt, content, tags: [["d", "taskify-chat-state"]] }, secret);
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

test("many read markers in a burst publish one replaceable event", async () => {
  const device = setup();
  await device.render();
  try {
    for (let i = 1; i <= 50; i += 1) {
      chatStateSyncBus.reportLocalReadThrough({ [`peer${i % 5}`]: 1_790_000_000 + i });
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(device.published).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(device.published).toHaveLength(1);
    const payload: any = await decryptNostrSyncPayload(device.published[0].content, skHex, pubkey);
    expect(payload.readThrough).toEqual({
      peer0: 1_790_000_050, peer1: 1_790_000_046, peer2: 1_790_000_047, peer3: 1_790_000_048, peer4: 1_790_000_049,
    });

    // Nothing new: an older marker must not publish again.
    chatStateSyncBus.reportLocalReadThrough({ peer0: 1_790_000_001 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(device.published).toHaveLength(1);
  } finally {
    await device.unmount();
  }
});

test("another device's markers and responses are applied without publishing them back", async () => {
  const device = setup({ pendingInboxEventIds: ["wrap-1"] });
  await device.render();
  const received: Record<string, number>[] = [];
  const stop = chatStateSyncBus.onRemoteReadThrough((readThrough) => received.push(readThrough));
  try {
    await device.deliver(await remoteEvent({
      readThrough: { peer1: 1_790_000_100 },
      inboxResponses: { "wrap-1": { status: "deleted", at: 1_790_000_050 } },
    }, 1_790_000_200));
    expect(received).toEqual([{ peer1: 1_790_000_100 }]);
    expect(device.applyRemoteInboxResponses).toHaveBeenCalledWith({ "wrap-1": { status: "deleted", at: 1_790_000_050 } });

    // The item now reads as answered locally, with the other device's timestamp.
    await device.render({ localInboxResponses: { "wrap-1": { status: "deleted", at: 1_790_000_050 } }, pendingInboxEventIds: [] });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(device.published).toHaveLength(0);
  } finally {
    stop();
    await device.unmount();
  }
});

test("a response made here is published, and the relay echo is ignored", async () => {
  const device = setup();
  await device.render();
  try {
    await device.render({ localInboxResponses: { "wrap-9": { status: "accepted", at: 1_790_000_010 } } });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(device.published).toHaveLength(1);
    await device.deliver(device.published[0]);
    expect(device.applyRemoteInboxResponses).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(device.published).toHaveLength(1);
  } finally {
    await device.unmount();
  }
});

test("a shared item that arrives after another device answered it is answered on arrival", async () => {
  const device = setup();
  await device.render();
  try {
    await device.deliver(await remoteEvent({
      readThrough: {},
      inboxResponses: { "wrap-late": { status: "accepted", at: 1_790_000_050 } },
    }, 1_790_000_200));
    device.applyRemoteInboxResponses.mockClear();
    await device.render({ pendingInboxEventIds: ["wrap-late"] });
    expect(device.applyRemoteInboxResponses).toHaveBeenCalledWith({ "wrap-late": { status: "accepted", at: 1_790_000_050 } });
  } finally {
    await device.unmount();
  }
});
