import test from "node:test";
import assert from "node:assert/strict";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { RuntimeNostrSession } from "../dist/index.js";

test("fetchEvents keeps only events with valid signatures, and a forged copy cannot shadow the real one", async () => {
  const handlers: Record<string, Array<(arg: unknown) => void>> = {};
  const ndk = {
    subscribe() {
      return { on(event: string, handler: (arg: unknown) => void) { (handlers[event] ||= []).push(handler); }, stop() {} };
    },
  };
  const session = Object.create(RuntimeNostrSession.prototype);
  session.ndk = ndk;
  session.buildRelaySet = async () => undefined;

  const genuine = finalizeEvent({ kind: 10050, content: "", tags: [["relay", "wss://real.example"]], created_at: 1_790_000_000 }, generateSecretKey());
  const forgedCopy = { ...genuine, sig: "00".repeat(64) };
  const forgedOther = { ...finalizeEvent({ kind: 10050, content: "", tags: [["relay", "wss://attacker.example"]], created_at: 1_790_000_001 }, generateSecretKey()), pubkey: genuine.pubkey };

  const pending = session.fetchEvents([{ kinds: [10050] }], undefined, 1_000, 10, 10);
  await new Promise((resolve) => setTimeout(resolve, 0)); // the subscription opens after the relay set resolves
  const fire = (raw: unknown) => (handlers.event || []).forEach((handler) => handler({ rawEvent: () => raw }));
  fire(forgedCopy);
  fire(forgedOther);
  fire(genuine);
  (handlers.eose || []).forEach((handler) => handler(undefined));
  const events = await pending;
  assert.deepEqual(events.map((event: { id: string }) => event.id), [genuine.id]);
});
