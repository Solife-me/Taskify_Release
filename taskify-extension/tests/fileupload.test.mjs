/**
 * The file upload: the three server kinds, NIP-98 and BUD-11 authorization, and the URL the
 * server answers with.
 *
 * `fetch` is replaced with a stand-in, so the request shape is checked without a network.
 */
import { generateSecretKey, verifyEvent } from "nostr-tools";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name} ${detail}`); }
}

const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  calls.push({ url: target, method: options.method ?? "GET", headers: options.headers ?? {}, body: options.body });
  if (target === "https://files.test/.well-known/nostr/nip96.json") {
    return new Response(JSON.stringify({ api_url: "https://files.test/nip96-upload" }), { status: 200 });
  }
  if (target === "https://files.test/nip96-upload") {
    return new Response(JSON.stringify({ url: "https://files.test/stored/nip96.bin" }), { status: 200 });
  }
  if (target === "https://blossom.test/upload") {
    return new Response(JSON.stringify({ url: "https://blossom.test/stored/blossom.bin" }), { status: 200 });
  }
  if (target === "https://originless.test/up") {
    return new Response(JSON.stringify({ cid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" }), { status: 200 });
  }
  return new Response("nope", { status: 404 });
};

const secretKeyHex = bytesToHex(generateSecretKey());
const data = new TextEncoder().encode("the encrypted payload");

// Imported after the stand-in is installed, so the module uses it.
const { DEFAULT_FILE_SERVERS, uploadEncryptedFile } = await import("../src/lib/fileUpload.ts");

console.log("the managed Blossom server is the default");
{
  check("managed Blossom is first", DEFAULT_FILE_SERVERS[0]?.url === "https://blossom.solife.me", JSON.stringify(DEFAULT_FILE_SERVERS[0]));
  check("the default uses Blossom auth", DEFAULT_FILE_SERVERS[0]?.type === "blossom", DEFAULT_FILE_SERVERS[0]?.type);
}

console.log("a NIP-96 upload");
{
  const url = await uploadEncryptedFile({
    server: { url: "https://files.test", type: "nip96", label: "files" },
    data,
    filename: "page.md",
    mimeType: "text/markdown",
    secretKeyHex,
  });
  check("it returns the url the server gave", url === "https://files.test/stored/nip96.bin", url);
  const upload = calls.find((c) => c.url === "https://files.test/nip96-upload");
  check("it posted to the discovered endpoint", !!upload);
  check("it posted", upload?.method === "POST", upload?.method);
  const auth = String(upload?.headers?.Authorization ?? upload?.headers?.authorization ?? "");
  check("it is authorized with a Nostr event", auth.startsWith("Nostr "), auth.slice(0, 30));
  const decoded = JSON.parse(new TextDecoder().decode(Buffer.from(auth.slice(6), "base64")));
  check("the auth event is a kind 27235 request", decoded.kind === 27235, String(decoded.kind));
  check("the auth event names the upload url", decoded.tags.some((t) => t[0] === "u" && t[1] === "https://files.test/nip96-upload"));
  check("the auth event names the method", decoded.tags.some((t) => t[0] === "method" && t[1] === "POST"));
  check("the auth event carries a payload hash", decoded.tags.some((t) => t[0] === "payload"));
  check("the body was sent", !!upload?.body);
}

console.log("a Blossom upload");
{
  const url = await uploadEncryptedFile({
    server: { url: "https://blossom.test", type: "blossom", label: "blossom" },
    data,
    filename: "page.md",
    mimeType: "text/markdown",
    secretKeyHex,
  });
  check("it returns the url the server gave", url === "https://blossom.test/stored/blossom.bin", url);
  const upload = calls.find((c) => c.url === "https://blossom.test/upload");
  check("it put to /upload", upload?.method === "PUT", upload?.method);
  check("it sends opaque ciphertext", upload?.headers?.["Content-Type"] === "application/octet-stream", upload?.headers?.["Content-Type"]);
  const hash = bytesToHex(sha256(data));
  check("it names the ciphertext hash", upload?.headers?.["X-SHA-256"] === hash, upload?.headers?.["X-SHA-256"]);
  const auth = String(upload?.headers?.Authorization ?? "");
  check("it is authorized with a Nostr event", auth.startsWith("Nostr "));
  const decoded = JSON.parse(Buffer.from(auth.slice(6), "base64url").toString("utf8"));
  check("the auth event signature verifies", verifyEvent(decoded));
  check("the auth event is BUD-11", decoded.kind === 24242, String(decoded.kind));
  check("the auth event authorizes upload", decoded.tags.some((t) => t[0] === "t" && t[1] === "upload"));
  check("the auth event names the hash", decoded.tags.some((t) => t[0] === "x" && t[1] === hash));
  check("the auth event expires", decoded.tags.some((t) => t[0] === "expiration" && Number(t[1]) > decoded.created_at));
  check("the auth event names the server", decoded.tags.some((t) => t[0] === "server" && t[1] === "blossom.test"));
}

console.log("an Originless upload");
{
  const url = await uploadEncryptedFile({
    server: { url: "https://originless.test", type: "originless", label: "originless" },
    data,
    filename: "page.md",
    mimeType: "text/markdown",
    secretKeyHex,
  });
  check("it returns a gateway url for the cid", url.startsWith("https://dweb.link/ipfs/"), url);
  const upload = calls.find((c) => c.url === "https://originless.test/up");
  check("it posted to /up", upload?.method === "POST", upload?.method);
}

console.log("a server that refuses is reported");
{
  let message = "";
  try {
    await uploadEncryptedFile({
      server: { url: "https://broken.test", type: "nip96" },
      data,
      filename: "x.md",
      mimeType: "text/markdown",
      secretKeyHex,
    });
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  check("it throws", message.length > 0);
  check("the error mentions the server", /broken\.test|refused/i.test(message), message);
}

globalThis.fetch = realFetch;
console.log(failures === 0 ? "\nAll file upload tests passed." : `\n${failures} file upload test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
