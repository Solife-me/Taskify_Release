// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { useDmSubscription } from './useDmSubscription';

const wrap = (id: string) => ({ id, pubkey: 'a'.repeat(64), created_at: 500, kind: 1059, tags: [], content: '', sig: '' });

vi.mock('../../nostr/NostrSession', () => ({ NostrSession: { init: vi.fn() } }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test('receiving another DM preserves history beyond 400 messages and deduplicates sender copies by rumor', async () => {
  let messages: any[] = Array.from({ length: 400 }, (_, i) => ({ id: String(i), eventId: String(i), createdAt: i }));
  let hook: ReturnType<typeof useDmSubscription>;
  const props: any = {
    dmProcessedEventsRef: { current: new Set() }, dmDeletedEventsRef: { current: new Set() },
    dmTempDeletedEventsRef: { current: new Map() }, dmBlockedPeersRef: { current: new Set() },
    ensureNostrIdentity: () => ({ pubkey: 'a'.repeat(64), secret: 'secret' }),
    decryptNostrPaymentMessage: async () => ({ content: 'Message from iOS', createdAt: 500, rumorId: 'same-rumor', senderPubkey: 'a'.repeat(64) }),
    resolvePeerPubkey: () => '', messageItemsRef: { current: [] }, parseIncomingPaymentMessage: () => null,
    setDmMessages: (update: any) => { messages = update(messages); },
  };
  function Harness() { hook = useDmSubscription(props); return null; }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Harness />));
  try {
    await hook!.handleDmEvent(wrap('wrap-1'));
    expect(messages).toHaveLength(401);
    expect(messages[0].eventId).toBe('0');
    await hook!.handleDmEvent(wrap('wrap-2'));
    expect(messages).toHaveLength(401);
  } finally { await act(async () => root.unmount()); }
});

test('wallet consumers can still handle an incoming payment attachment while chat leaves it inert', async () => {
  const handlePaymentRequestEvent = vi.fn(async () => {});
  let hook: ReturnType<typeof useDmSubscription>;
  let messages: any[] = [];
  const props: any = {
    dmProcessedEventsRef: { current: new Set() }, dmDeletedEventsRef: { current: new Set() },
    dmTempDeletedEventsRef: { current: new Map() }, dmBlockedPeersRef: { current: new Set() },
    ensureNostrIdentity: () => ({ pubkey: 'a'.repeat(64), secret: 'secret' }),
    decryptNostrPaymentMessage: async () => ({
      content: 'cashuAexample',
      createdAt: 500,
      rumorId: 'payment-rumor',
      senderPubkey: 'b'.repeat(64),
    }),
    resolvePeerPubkey: () => '', messageItemsRef: { current: [] },
    parseIncomingPaymentMessage: () => ({ amount: 21 }),
    handlePaymentRequestEventRef: { current: handlePaymentRequestEvent },
    setDmMessages: (update: any) => { messages = update(messages); },
  };
  function Harness() { hook = useDmSubscription(props); return null; }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Harness />));
  try {
    const event = wrap('payment-wrap');
    await hook!.handleDmEvent(event);
    expect(handlePaymentRequestEvent).toHaveBeenCalledWith(event, { updateClock: true });
    expect(messages[0]?.attachment).toMatchObject({ type: 'payment', amountSat: 21 });
  } finally { await act(async () => root.unmount()); }
});

test('startup discovers iOS inbox relays and recovers old sent DMs despite a recent local cursor', async () => {
  const { NostrSession } = await import('../../nostr/NostrSession');
  const { finalizeEvent, getPublicKey } = await import('nostr-tools');
  const secret = new Uint8Array(32).fill(5);
  const pubkey = getPublicKey(secret);
  const preference = finalizeEvent({ kind: 10050, created_at: 100, content: '', tags: [['relay', 'wss://ios.test']] }, secret);
  const oldMessage = { id: 'ios-sender-copy', kind: 1059, pubkey: 'b'.repeat(64), tags: [['p', pubkey]], created_at: 100 };
  const calls: any[] = [];
  const closeRef = { current: null as null | (() => void) };
  const persist = vi.fn();
  let messages: any[] = [];
  const session = {
    fetchEvents: async () => [preference],
    subscribe: async (filters: any[], options: any) => {
      calls.push({ filters, options });
      const timer = setTimeout(() => {
        const filter = filters[0];
        if (options.relayUrls.includes('wss://ios.test') && filter.kinds.includes(1059) && (filter.until ?? Infinity) >= 100) options.onEvent(oldMessage);
        options.onEose?.();
      }, 0);
      return { filters, release: () => clearTimeout(timer) };
    },
  };
  vi.mocked(NostrSession.init).mockResolvedValue(session as any);
  let hook: ReturnType<typeof useDmSubscription>;
  const props: any = {
    defaultNostrRelays: ['wss://pwa.test'], dmLastSyncRef: { current: Date.now() },
    dmSubscriptionCloseRef: closeRef, persistDmSyncMeta: persist,
    stopDmSubscription: () => closeRef.current?.(),
    dmProcessedEventsRef: { current: new Set() }, dmDeletedEventsRef: { current: new Set() },
    dmTempDeletedEventsRef: { current: new Map() }, dmBlockedPeersRef: { current: new Set() },
    ensureNostrIdentity: () => ({ pubkey, secret: 'secret' }),
    decryptNostrPaymentMessage: async () => ({ content: 'Sent on iOS months ago', createdAt: 100, rumorId: 'rumor', senderPubkey: pubkey }),
    resolvePeerPubkey: () => '', messageItemsRef: { current: [] }, parseIncomingPaymentMessage: () => null,
    setDmMessages: (update: any) => { messages = update(messages); },
  };
  function Harness() { hook = useDmSubscription(props); return null; }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Harness />));
  try {
    await hook!.startDmSubscription();
    expect(calls[0].options.relayUrls).toEqual(['wss://ios.test', 'wss://pwa.test']);
    // First sync: history recovery (the paged REQs, which carry `until`) reads from the start;
    // the live subscription only needs recent traffic.
    const recoveryCalls = calls.filter(call => call.filters[0].until !== undefined);
    const liveCalls = calls.filter(call => call.filters[0].until === undefined);
    expect(recoveryCalls.length).toBeGreaterThan(0);
    expect(recoveryCalls.every(call => call.filters[0].since === 0)).toBe(true);
    expect(liveCalls).toHaveLength(1);
    expect(liveCalls[0].filters[0].since).toBeGreaterThan(Math.floor(Date.now() / 1000) - 4 * 86400);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ isIncoming: false, content: 'Sent on iOS months ago' });
    expect(persist).toHaveBeenCalledOnce();

    // Next sync (e.g. a resume): recovery reads only from the last complete pass, less the
    // gift-wrap lookback, instead of paging back through everything.
    calls.length = 0;
    await hook!.startDmSubscription();
    const nextRecovery = calls.filter(call => call.filters[0].until !== undefined);
    expect(nextRecovery.length).toBeGreaterThan(0);
    expect(nextRecovery.every(call => call.filters[0].since > 0)).toBe(true);
  } finally { closeRef.current?.(); await act(async () => root.unmount()); }
});

function renderSubscription(props: any) {
  let hook: ReturnType<typeof useDmSubscription>;
  function Harness() { hook = useDmSubscription(props); return null; }
  const root = createRoot(document.createElement('div'));
  return {
    mount: () => act(async () => root.render(<Harness />)),
    hook: () => hook!,
    unmount: () => act(async () => root.unmount()),
  };
}

const baseProps = (overrides: any) => ({
  dmProcessedEventsRef: { current: new Set() }, dmDeletedEventsRef: { current: new Set() },
  dmTempDeletedEventsRef: { current: new Map() }, dmBlockedPeersRef: { current: new Set() },
  ensureNostrIdentity: () => ({ pubkey: 'a'.repeat(64), secret: 'secret' }),
  resolvePeerPubkey: () => '', messageItemsRef: { current: [] }, parseIncomingPaymentMessage: () => null,
  setDmMessages: () => {},
  ...overrides,
});

test('a share is handed to the inbox however old it is, before the message counts as handled', async () => {
  const envelope = { v: 1, kind: 'taskify-share', item: { type: 'task', title: 'Buy milk' } };
  const fourDaysAgo = Math.floor(Date.now() / 1000) - 4 * 86_400;
  const processed = new Set<string>();
  const onIncomingShare = vi.fn(async () => { expect(processed.has('share-wrap')).toBe(false); });
  const view = renderSubscription(baseProps({
    dmProcessedEventsRef: { current: processed },
    decryptNostrPaymentMessage: async () => ({
      content: JSON.stringify(envelope), createdAt: fourDaysAgo, rumorId: 'r', senderPubkey: 'b'.repeat(64), recipientPubkeys: ['a'.repeat(64)],
    }),
    onIncomingShareRef: { current: onIncomingShare },
  }));
  await view.mount();
  try {
    await view.hook().handleDmEvent({ ...wrap('share-wrap'), created_at: fourDaysAgo });
    expect(onIncomingShare).toHaveBeenCalledWith({
      eventId: 'share-wrap',
      envelope: expect.objectContaining({ item: expect.objectContaining({ type: 'task', title: 'Buy milk' }) }),
      senderPubkey: 'b'.repeat(64),
      recipientPubkeys: ['a'.repeat(64)],
    });
    expect(processed.has('share-wrap')).toBe(true);
  } finally { await view.unmount(); }
});

test('after a reload, a message already opened on this device is not decrypted again', async () => {
  const { PersistedIdSet } = await import('../seenEvents');
  let stored: string | null = null;
  const storage = { load: () => stored, save: (value: string) => { stored = value; } };
  const decrypt = vi.fn(async () => ({ content: 'hello', createdAt: 500, rumorId: 'r1', senderPubkey: 'b'.repeat(64) }));

  const first = renderSubscription(baseProps({
    dmProcessedEventsRef: { current: new PersistedIdSet(storage, { schedule: (run) => run() }) },
    decryptNostrPaymentMessage: decrypt,
  }));
  await first.mount();
  await first.hook().handleDmEvent(wrap('wrap-x'));
  await first.unmount();
  expect(decrypt).toHaveBeenCalledTimes(1);

  const second = renderSubscription(baseProps({
    dmProcessedEventsRef: { current: new PersistedIdSet(storage) },
    decryptNostrPaymentMessage: decrypt,
  }));
  await second.mount();
  await second.hook().handleDmEvent(wrap('wrap-x'));
  await second.unmount();
  expect(decrypt).toHaveBeenCalledTimes(1);
});
