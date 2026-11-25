/**
 * The account key: parsing it, and keeping it encrypted at rest.
 */
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { parseSecretKey } from "../src/lib/identity.ts";

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name} ${detail}`); }
}

console.log("a hex secret key is accepted");
{
  const secret = generateSecretKey();
  const hex = bytesToHex(secret);
  const parsed = parseSecretKey(hex);
  check("it parses", parsed !== null);
  check("the key is kept as hex", parsed?.secretKeyHex === hex, parsed?.secretKeyHex);
  check("the pubkey matches", parsed?.pubkey === getPublicKey(secret));
}

console.log("an nsec is accepted");
{
  const secret = generateSecretKey();
  const nsec = nip19.nsecEncode(secret);
  const parsed = parseSecretKey(nsec);
  check("it parses", parsed !== null);
  check("it becomes hex", parsed?.secretKeyHex === bytesToHex(secret));
  check("the pubkey matches", parsed?.pubkey === getPublicKey(secret));
}

console.log("uppercase hex is accepted");
{
  const secret = generateSecretKey();
  const parsed = parseSecretKey(bytesToHex(secret).toUpperCase());
  check("it parses", parsed !== null);
  check("it is lowercased", parsed?.secretKeyHex === bytesToHex(secret));
}

console.log("nonsense is refused");
{
  check("empty", parseSecretKey("") === null);
  check("whitespace", parseSecretKey("   ") === null);
  check("a word", parseSecretKey("not a key") === null);
  check("a short hex", parseSecretKey("abcd") === null);
  check("a long non-hex", parseSecretKey("z".repeat(64)) === null);
  check("an npub (the public key)", parseSecretKey(nip19.npubEncode(bytesToHex(generateSecretKey()))) === null);
  check("a non-hex nsec", parseSecretKey("nsec1bogus") === null);
}

console.log(failures === 0 ? "\nAll identity tests passed." : `\n${failures} identity test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
