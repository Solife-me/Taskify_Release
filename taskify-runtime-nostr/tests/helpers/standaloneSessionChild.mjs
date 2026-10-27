// Run by standalone-session.test.ts: use a standalone session against the relay at argv[2] and
// end in the way argv[3] names. The process must then exit by itself.
import { generateSecretKey } from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils.js";
import { withStandaloneSession } from "../../dist/index.js";

const [relayUrl, mode] = process.argv.slice(2);
try {
  await withStandaloneSession({ relays: [relayUrl], secretKeyHex: bytesToHex(generateSecretKey()) }, async (session) => {
    if (mode === "error") throw new Error("work failed");
    if (mode === "timeout") {
      await session.fetchVerified({ kinds: [0], limit: 1 }, { timeoutMs: 1 });
      return;
    }
    await session.publish({ kind: 30078, content: "x", tags: [["d", "child"]] });
    await session.fetchVerified({ kinds: [30078] }, { timeoutMs: 5_000 });
  });
} catch (error) {
  if (mode !== "error") throw error;
}
process.stdout.write(`closed ${mode}\n`);
