import { afterEach, expect, test, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, nip04 } from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils.js";

const state = vi.hoisted(() => ({ instances: [] as any[], walletKey: new Uint8Array(32) }));
vi.mock("taskify-runtime-nostr", async importOriginal => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    RuntimeNostrSession: class {
      auth: any;
      options: any;
      constructor(_relays: string[], deps: any) {
        this.auth = deps.createAuthManager({});
        state.instances.push(this);
      }
      async init() {}
      async shutdown() {}
      async prepareEvent(template: any, key: Uint8Array) { return finalizeEvent(template, key); }
      async subscribe(_filters: any, options: any) {
        this.options = options;
        return { release() {} };
      }
      async publishRaw(request: any) {
        const content = await nip04.encrypt(state.walletKey, request.pubkey,
          JSON.stringify({ result_type: "get_balance", result: { balance: 42 } }));
        await this.options.onEvent(finalizeEvent({ kind: 23195, created_at: request.created_at,
          tags: [["e", request.id], ["p", request.pubkey]], content }, state.walletKey));
      }
    },
  };
});
import { NwcClient, parseNwcUri } from "./nwc";

let client: NwcClient | undefined;
afterEach(() => { client?.close(); state.instances.length = 0; });
test("NWC reuses its connection and authenticates with the client key", async () => {
  const clientKey = generateSecretKey();
  state.walletKey = new Uint8Array(generateSecretKey());
  const connection = parseNwcUri(`nostr+walletconnect://${getPublicKey(state.walletKey)}?relay=wss%3A%2F%2Fwallet.example&secret=${bytesToHex(clientKey)}`);
  client = new NwcClient(connection);
  expect(await client.request("get_balance", {})).toEqual({ balance: 42 });
  expect(await client.request("get_balance", {})).toEqual({ balance: 42 });
  expect(state.instances).toHaveLength(1);
  const auth = await state.instances[0].auth.buildAuthEvent("wss://wallet.example", "challenge");
  expect(auth.pubkey).toBe(getPublicKey(clientKey));
  expect(auth.kind).toBe(22242);
});
