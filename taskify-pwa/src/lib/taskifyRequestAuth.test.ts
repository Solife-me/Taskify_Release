import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { signTaskifyRequestHeaders } from "./taskifyRequestAuth";

describe("signTaskifyRequestHeaders", () => {
  it("binds a Schnorr signature to the exact body and account public key", async () => {
    const privateKey = schnorr.utils.randomSecretKey();
    const body = JSON.stringify({ transcript: "call the dentist" });
    const headers = await signTaskifyRequestHeaders(bytesToHex(privateKey), body);
    const hash = sha256(
      new TextEncoder().encode(`${headers["X-Taskify-Timestamp"]}.${body}`),
    );

    expect(headers["X-Taskify-Npub"]).toBe(bytesToHex(schnorr.getPublicKey(privateKey)));
    expect(schnorr.verify(
      hexToBytes(headers["X-Taskify-Sig"]),
      hash,
      hexToBytes(headers["X-Taskify-Npub"]),
    )).toBe(true);
  });

  it("does not verify after the body is changed", async () => {
    const privateKey = schnorr.utils.randomSecretKey();
    const headers = await signTaskifyRequestHeaders(bytesToHex(privateKey), "original");
    const tamperedHash = sha256(
      new TextEncoder().encode(`${headers["X-Taskify-Timestamp"]}.tampered`),
    );
    expect(schnorr.verify(
      hexToBytes(headers["X-Taskify-Sig"]),
      tamperedHash,
      hexToBytes(headers["X-Taskify-Npub"]),
    )).toBe(false);
  });
});
