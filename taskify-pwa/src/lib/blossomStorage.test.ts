import { beforeEach, describe, expect, test, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { blossomTermsFingerprint, createBlossomStorageOrder, listBlossomStorageBlobs } from "./blossomStorage";
import { localBlobReferences, matchBlobToLocalReferences, sha256FromAttachmentURL } from "./blossomInventoryMatch";
import type { CalendarEvent, Task } from "taskify-core";
import type { WalletDmMessage } from "../chat/hooks/useDmState";

const SIGNER = "0000000000000000000000000000000000000000000000000000000000000001";
const HASH = "a".repeat(64);

function decodeNip98(authorization: string): any {
  const token = authorization.replace(/^Nostr\s+/, "");
  return JSON.parse(atob(token));
}

describe("Blossom storage API", () => {
  beforeEach(() => vi.restoreAllMocks());

  test("signs the exact order URL and body bytes with NIP-98", async () => {
    const order = {
      id: "order-1",
      planId: "plan-500",
      planName: "500 MB",
      interval: "month",
      priceUsdCents: 500,
      bytes: 500_000_000,
      amountSats: 72,
      paymentHash: HASH,
      invoice: "lnbc1invoice",
      invoiceExpiresAt: 1_900_000_000,
      paidThrough: null,
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(order), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    await createBlossomStorageOrder({
      serverUrl: "https://blossom.example",
      signer: SIGNER,
      requestId: "request-1",
      offer: { planId: "plan-500", interval: "month", priceUsdCents: 500, bytes: 500_000_000 },
    });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://blossom.example/api/storage/v1/orders");
    expect(init?.method).toBe("POST");
    const auth = decodeNip98((init?.headers as Record<string, string>).Authorization);
    expect(auth.kind).toBe(27235);
    expect(auth.tags).toContainEqual(["u", "https://blossom.example/api/storage/v1/orders"]);
    expect(auth.tags).toContainEqual(["method", "POST"]);
    const bodyBytes = init?.body as Uint8Array;
    const payload = auth.tags.find((tag: string[]) => tag[0] === "payload");
    expect(payload?.[1]).toBe(bytesToHex(sha256(bodyBytes)));
  });

  test("includes the unchanged inventory cursor and signed query in the NIP-98 u tag", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ blobs: [], nextCursor: null }), { status: 200 }),
    );

    await listBlossomStorageBlobs({
      serverUrl: "https://blossom.example/",
      signer: SIGNER,
      cursor: "cursor/+?=",
      limit: 50,
    });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://blossom.example/api/storage/v1/blobs?limit=50&cursor=cursor%2F%2B%3F%3D");
    const auth = decodeNip98((init?.headers as Record<string, string>).Authorization);
    expect(auth.tags).toContainEqual(["u", url]);
    expect(auth.tags).toContainEqual(["method", "GET"]);
    expect(auth.tags.some((tag: string[]) => tag[0] === "payload")).toBe(false);
  });
});

describe("Blossom attachment inventory matching", () => {
  test("extracts the ciphertext hash from opaque Blossom URLs", () => {
    expect(sha256FromAttachmentURL(`https://blossom.example/${HASH}.bin`)).toBe(HASH);
    expect(sha256FromAttachmentURL("https://blossom.example/not-a-hash.bin")).toBeNull();
  });

  test("requires both the server and ciphertext hash to match", () => {
    const task = {
      id: "task-1",
      boardId: "board-1",
      title: "Upload the signed lease",
      dueISO: "2026-11-20",
      documents: [{
        id: "doc-1",
        name: "Lease.pdf",
        mimeType: "application/pdf",
        kind: "pdf",
        dataUrl: "",
        createdAt: "2026-11-20T00:00:00.000Z",
        remoteUrl: `https://blossom.example/${HASH}.bin`,
        encrypted: true,
        ciphertextSha256: HASH,
        storageServer: "https://blossom.example",
      }],
    } as Task;
    const refs = localBlobReferences([task]);
    const blob = { sha256: HASH, url: `https://blossom.example/${HASH}` };

    expect(matchBlobToLocalReferences(blob, "https://blossom.example", refs)).toHaveLength(1);
    expect(matchBlobToLocalReferences(blob, "https://other.example", refs)).toHaveLength(0);
    expect(matchBlobToLocalReferences({ ...blob, sha256: "b".repeat(64) }, "https://blossom.example", refs)).toHaveLength(0);
  });
});

test("changing purchased capacity does not invalidate consent to the same inactivity rules", () => {
  const summary = {
    protected: { limitBytes: 100, usedBytes: 50 },
    total: { limitBytes: 500, usedBytes: 100 },
    protectionSeconds: 365,
    standardRules: [{ type: "*", expiration: 60 }],
    offers: [],
    paidStorage: [],
    permanentExtraBytes: 0,
  };
  expect(blossomTermsFingerprint({ ...summary, protected: { limitBytes: 500, usedBytes: 50 } }))
    .toBe(blossomTermsFingerprint(summary));
  expect(blossomTermsFingerprint({ ...summary, standardRules: [{ type: "*", expiration: 120 }] }))
    .not.toBe(blossomTermsFingerprint(summary));
});

test("finds filenames from decrypted calendar and chat references", () => {
  const url = `https://blossom.example/files/${HASH}.jpg`;
  const event = { id: "meeting", title: "Meeting", boardId: "board", image: url } as CalendarEvent;
  const message = { id: "message", attachment: { type: "file", url, filename: "Photo.jpg" } } as WalletDmMessage;
  const refs = localBlobReferences([], [event], [message]);
  const matches = matchBlobToLocalReferences({ sha256: HASH }, "https://blossom.example/files", refs);
  expect(matches.map(({ source, filename }) => [source, filename]))
    .toEqual([["event", "Image"], ["chat", "Photo.jpg"]]);
  expect(matchBlobToLocalReferences({ sha256: HASH }, "https://blossom.example/other", refs)).toEqual([]);
});
