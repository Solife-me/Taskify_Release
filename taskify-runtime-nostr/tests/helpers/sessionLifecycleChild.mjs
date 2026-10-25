// Run by session-shutdown.test.ts: connect to the relays named in argv, publish to each, shut down.
// The process must then exit by itself: nothing a shut-down session owns may keep it alive.
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { RelayAuthManager, RelayHealthTracker, RelayInfoCache, RuntimeNostrSession } from "../../dist/index.js";

const relayUrls = process.argv.slice(2);
const runtime = new RuntimeNostrSession(relayUrls, {
  relayInfoCache: new RelayInfoCache(),
  relayHealth: new RelayHealthTracker(),
  createAuthManager: (ndk) => new RelayAuthManager(ndk, { loadSecretKeyHex: () => null, allowEphemeralKey: true }),
  createWalletClient: () => undefined,
  enableOutboxModel: false,
});
await runtime.init(relayUrls);
const event = runtime.createEvent();
event.kind = 30301;
event.created_at = Math.floor(Date.now() / 1000);
event.content = "encrypted";
event.tags = [["d", "task-1"], ["b", "board"]];
await runtime.publishSigned(event, NDKPrivateKeySigner.generate(), relayUrls);
await runtime.shutdown();
process.stdout.write("shut down\n");
