import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { signTaskifyRequestHeaders, taskifyRequestMessage } from "./taskifyRequestAuth";

const URL_ = "https://taskify.solife.me/api/voice/extract";

function verifies(headers: Record<string, string>, method: string, url: string, body: string): boolean {
  const message = taskifyRequestMessage(method, new URL(url), Number(headers["X-Taskify-Timestamp"]), body);
  return schnorr.verify(
    hexToBytes(headers["X-Taskify-Sig"]),
    sha256(new TextEncoder().encode(message)),
    hexToBytes(headers["X-Taskify-Npub"]),
  );
}

describe("signTaskifyRequestHeaders", () => {
  it("matches the Worker's version-2 test vector", () => {
    const message = taskifyRequestMessage("post", new URL(URL_), 1_790_000_000, JSON.stringify({ a: 1 }));
    expect(bytesToHex(sha256(new TextEncoder().encode(message)))).toBe(
      "c0a46a916c09e41e1657f3fd34913825aeaaece8de15596f4fb7a850f6d42e50",
    );
  });

  it("signs the method, host, route, and exact body with the account key", async () => {
    const privateKey = schnorr.utils.randomSecretKey();
    const body = JSON.stringify({ transcript: "call the dentist" });
    const headers = await signTaskifyRequestHeaders(bytesToHex(privateKey), { method: "POST", url: URL_, body });
    expect(headers["X-Taskify-Auth"]).toBe("v2");
    expect(headers["X-Taskify-Npub"]).toBe(bytesToHex(schnorr.getPublicKey(privateKey)));
    expect(verifies(headers, "POST", URL_, body)).toBe(true);
    expect(verifies(headers, "POST", URL_, "tampered")).toBe(false);
    expect(verifies(headers, "POST", "https://taskify.solife.me/api/voice/finalize", body)).toBe(false);
  });
});
