// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test } from 'vitest';
import { useNostrSubscriptions } from './useNostrSubscriptions';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const author = 'a'.repeat(64);
const invited = (id: string) => ({
  id, readOnly: true, eventKey: 'k', viewAddress: `30311:${author}:${id}`, inviteRelays: ['wss://invite.test'],
});

test('the invite subscription restarts only when the invited events change', async () => {
  let subscriptions = 0;
  const pool = { subscribeMany() { subscriptions += 1; return { close() {} }; } };
  let props: any = {
    enabled: true, clockRef: { current: new Map() }, defaultRelays: ['wss://default.test'],
    events: [invited('e1')], handleEvent: () => {}, inboxRelays: [], pool,
  };
  function Harness(p: any) { useNostrSubscriptions({ calendarViews: p }); return null; }
  const root = createRoot(document.createElement('div'));
  const render = async (next: any = {}) => {
    props = { ...props, ...next };
    await act(async () => root.render(<Harness {...props} />));
  };
  try {
    await render();
    expect(subscriptions).toBe(1);
    // Editing an unrelated calendar event, new callback and array identities: no new REQ.
    await render({
      events: [invited('e1'), { id: 'own', title: 'Mine' }],
      handleEvent: () => {},
      defaultRelays: ['wss://default.test'],
    });
    expect(subscriptions).toBe(1);
    await render({ events: [invited('e1'), invited('e2')] });
    expect(subscriptions).toBe(2);
  } finally {
    await act(async () => root.unmount());
  }
});
