// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { bytesToHex } from '@noble/hashes/utils.js';
import { generateSecretKey, getPublicKey, nip59 } from 'nostr-tools';
import { expect, test } from 'vitest';
import { useNostrPoolState } from './useNostrPoolState';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function renderPoolState() {
  let hook: ReturnType<typeof useNostrPoolState>;
  const props: any = {
    walletDebugEnabled: false, paymentRequestsEnabled: false, fileStorageServer: '', sendTokenStr: '',
    nutTokenCopied: false, setNutTokenCopied: () => {}, setLockSendToPubkey: () => {},
    setSendLockPubkeyInput: () => {}, setSendLockError: () => {}, textEncoderRef: { current: null },
    spentIncomingPaymentsRef: { current: new Map() }, spentIncomingTokenFingerprintsRef: { current: new Set() },
    dmSubscriptionCloseRef: { current: null }, open: false, receiveMode: null, sendMode: null,
  };
  function Harness() { hook = useNostrPoolState(props); return null; }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Harness />));
  return { hook: () => hook!, unmount: () => act(async () => root.unmount()) };
}

function wrapFor(senderSecret: Uint8Array, recipient: string, tags: string[][]) {
  const rumor = nip59.createRumor({ kind: 14, content: '{"id":"req-1","mint":"https://mint.test","unit":"sat","proofs":[]}', tags }, senderSecret);
  return nip59.createWrap(nip59.createSeal(rumor, senderSecret, recipient), recipient);
}

test('a NUT-18 payment rumor without p tags is accepted as addressed to this account', async () => {
  const { hook, unmount } = await renderPoolState();
  try {
    const mySecret = generateSecretKey();
    const me = getPublicKey(mySecret);
    const payer = generateSecretKey();
    const decrypted = await hook().decryptNostrPaymentMessage(wrapFor(payer, me, []) as any, me, bytesToHex(mySecret));
    expect(decrypted?.senderPubkey).toBe(getPublicKey(payer));
    expect(decrypted?.recipientPubkey).toBe(me);
    expect(decrypted?.recipientPubkeys).toEqual([me]);
  } finally { await unmount(); }
});

test('a self-addressed rumor without p tags is still dropped, and tagged rumors are unchanged', async () => {
  const { hook, unmount } = await renderPoolState();
  try {
    const mySecret = generateSecretKey();
    const me = getPublicKey(mySecret);
    expect(await hook().decryptNostrPaymentMessage(wrapFor(mySecret, me, []) as any, me, bytesToHex(mySecret))).toBeNull();
    const friend = generateSecretKey();
    const tagged = await hook().decryptNostrPaymentMessage(wrapFor(friend, me, [['p', me]]) as any, me, bytesToHex(mySecret));
    expect(tagged?.recipientPubkeys).toEqual([me]);
  } finally { await unmount(); }
});
