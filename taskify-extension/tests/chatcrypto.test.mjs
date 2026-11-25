/**
 * The chat crypto: the attachment encryption and the NIP-17 wrap, checked against Taskify's own
 * shared implementation so the panel is wire-compatible with the app and the agent.
 */
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { hexToBytes } from "@noble/hashes/utils.js";
import { buildNip17GiftWraps, createNip17Rumor } from "taskify-core";
import { nip44 } from "nostr-tools";
import { nip17Crypto, newNip17WrapKey } from "taskify-runtime-nostr";
import { attachmentTags, decryptAttachment, encryptAttachment, nip17Account } from "../src/lib/chatCrypto.ts";

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name} ${detail}`); }
}

console.log("an attachment survives the round trip");
{
  const original = new TextEncoder().encode("# The page\n\nSome text the agent should read.");
  const { ciphertext, meta } = await encryptAttachment({
    data: original,
    mimeType: "text/markdown",
    filename: "page.md",
  });
  check("the ciphertext is not the plaintext", !new TextDecoder().decode(ciphertext).includes("The page"));
  check("the ciphertext is longer than the plaintext", ciphertext.length > original.length);
  check("the key is 32 bytes", meta.keyHex.length === 64, meta.keyHex.length);
  check("the nonce is 16 bytes", meta.nonceHex.length === 32, meta.nonceHex.length);
  check("the size is recorded", meta.size === original.length);
  check("the algorithm is aes-gcm", meta.algorithm === "aes-gcm");

  const decrypted = await decryptAttachment({ ciphertext, keyHex: meta.keyHex, nonceHex: meta.nonceHex });
  check("it decrypts back to the original", new TextDecoder().decode(decrypted) === new TextDecoder().decode(original));
}

console.log("two attachments of the same content use different keys");
{
  const data = new TextEncoder().encode("the same text");
  const first = await encryptAttachment({ data, mimeType: "text/plain", filename: "a.txt" });
  const second = await encryptAttachment({ data, mimeType: "text/plain", filename: "a.txt" });
  check("the keys differ", first.meta.keyHex !== second.meta.keyHex);
  check("the nonces differ", first.meta.nonceHex !== second.meta.nonceHex);
  check("the ciphertexts differ", new Uint8Array(first.ciphertext).join() !== new Uint8Array(second.ciphertext).join());
}

console.log("the tags carry what a reader needs");
{
  const { meta } = await encryptAttachment({ data: new Uint8Array([1, 2, 3]), mimeType: "text/markdown", filename: "p.md" });
  const tags = attachmentTags(meta);
  const value = (name) => tags.find((tag) => tag[0] === name)?.[1];
  check("the file type is there", value("file-type") === "text/markdown");
  check("the algorithm is there", value("encryption-algorithm") === "aes-gcm");
  check("the key is there", value("decryption-key") === meta.keyHex);
  check("the nonce is there", value("decryption-nonce") === meta.nonceHex);
  check("the name is there", value("filename") === "p.md");
  check("the size is there", value("size") === "3");
}

console.log("a gift wrap is sealed to its recipient");
{
  const secretKeyHex = "3".repeat(63) + "1";
  const account = nip17Account(secretKeyHex, getPublicKey(hexToBytes(secretKeyHex)));
  const recipientSecret = generateSecretKey();
  const recipientPubkey = getPublicKey(recipientSecret);
  const senderPubkey = getPublicKey(hexToBytes(secretKeyHex));

  const rumor = createNip17Rumor(
    { sender: senderPubkey, recipients: [recipientPubkey], content: "hello", createdAt: Math.floor(Date.now() / 1000) },
    nip17Crypto,
  );
  const wraps = await buildNip17GiftWraps(rumor, account, {
    newWrapKey: newNip17WrapKey,
    signWrap: async (template, key) => (await key.sign(template)),
    timestamp: () => Math.floor(Date.now() / 1000),
  });
  check("there is a wrap for the recipient and one for the sender", wraps.length === 2, String(wraps.length));
  check("each wrap verifies", wraps.every((entry) => nip17Crypto.verifyEvent(entry.wrap)));
  check("each wrap names its recipient", wraps.every((entry) => entry.wrap.tags.some((tag) => tag[0] === "p" && tag[1] === entry.recipient)));
  check("the wraps have different ids", wraps[0].wrap.id !== wraps[1].wrap.id);

  // The recipient opens the wrap meant for it.
  const { openNip17GiftWrap } = await import("taskify-core");
  const recipientAccount = {
    pubkey: recipientPubkey,
    nip44Decrypt: async (peer, ciphertext) =>
      nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(recipientSecret, peer)),
  };
  const mine = wraps.find((entry) => entry.recipient === recipientPubkey);
  const opened = await openNip17GiftWrap(mine.wrap, recipientAccount, nip17Crypto);
  check("the recipient can open it", opened !== null);
  check("the message comes through", opened?.rumor.content === "hello", opened?.rumor.content);
  check("the sender is named", opened?.senderPubkey === senderPubkey);
}

console.log(failures === 0 ? "\nAll chat crypto tests passed." : `\n${failures} chat crypto test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
