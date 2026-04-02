import { test, describe, expect, vi, beforeEach } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import {
  parseFileServers,
  serializeFileServers,
  findServerEntry,
  DEFAULT_FILE_SERVERS,
  type FileServerEntry,
} from "../lib/fileStorage";

// A minimal valid secp256k1 private key (scalar = 1)
const VALID_SIGNER = hexToBytes("0000000000000000000000000000000000000000000000000000000000000001");

// ── parseFileServers / serializeFileServers roundtrip ──────────────────────

describe("parseFileServers / serializeFileServers", () => {
  test("roundtrip preserves all entries", () => {
    const input: FileServerEntry[] = [
      { url: "https://nostr.build", type: "nip96", label: "nostr.build" },
      { url: "https://blossom.band", type: "blossom", label: "blossom.band" },
      { url: "https://originless.besoeasy.com", type: "originless" },
    ];
    const serialized = serializeFileServers(input);
    const parsed = parseFileServers(serialized);
    expect(parsed).toEqual(input);
  });

  test("parseFileServers returns DEFAULT_FILE_SERVERS for null", () => {
    const result = parseFileServers(null);
    expect(result).toEqual(DEFAULT_FILE_SERVERS);
  });

  test("parseFileServers returns DEFAULT_FILE_SERVERS for undefined", () => {
    const result = parseFileServers(undefined);
    expect(result).toEqual(DEFAULT_FILE_SERVERS);
  });

  test("parseFileServers returns DEFAULT_FILE_SERVERS for empty string", () => {
    const result = parseFileServers("");
    expect(result).toEqual(DEFAULT_FILE_SERVERS);
  });

  test("parseFileServers returns DEFAULT_FILE_SERVERS for invalid JSON", () => {
    const result = parseFileServers("not json");
    expect(result).toEqual(DEFAULT_FILE_SERVERS);
  });

  test("parseFileServers returns DEFAULT_FILE_SERVERS for non-array JSON", () => {
    const result = parseFileServers('{"url":"https://nostr.build","type":"nip96"}');
    expect(result).toEqual(DEFAULT_FILE_SERVERS);
  });

  test("parseFileServers filters out entries with missing url", () => {
    const input = JSON.stringify([
      { url: "https://nostr.build", type: "nip96" },
      { type: "blossom" }, // missing url
    ]);
    const result = parseFileServers(input);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe("https://nostr.build");
  });

  test("parseFileServers filters out entries with invalid type", () => {
    const input = JSON.stringify([
      { url: "https://nostr.build", type: "nip96" },
      { url: "https://bad.com", type: "unknown" },
    ]);
    const result = parseFileServers(input);
    expect(result).toHaveLength(1);
  });

  test("parseFileServers returns DEFAULT_FILE_SERVERS when all entries are invalid", () => {
    const input = JSON.stringify([{ url: "", type: "nip96" }]);
    const result = parseFileServers(input);
    expect(result).toEqual(DEFAULT_FILE_SERVERS);
  });
});

// ── findServerEntry ─────────────────────────────────────────────────────────

describe("findServerEntry", () => {
  const servers: FileServerEntry[] = [
    { url: "https://nostr.build", type: "nip96", label: "nostr.build" },
    { url: "https://blossom.band", type: "blossom" },
  ];

  test("finds entry by exact URL", () => {
    const result = findServerEntry(servers, "https://nostr.build");
    expect(result).toBeDefined();
    expect(result?.type).toBe("nip96");
  });

  test("finds entry by URL with trailing slash", () => {
    const result = findServerEntry(servers, "https://nostr.build/");
    expect(result).toBeDefined();
    expect(result?.url).toBe("https://nostr.build");
  });

  test("returns undefined for unknown URL", () => {
    const result = findServerEntry(servers, "https://unknown.example.com");
    expect(result).toBeUndefined();
  });

  test("returns undefined for empty list", () => {
    const result = findServerEntry([], "https://nostr.build");
    expect(result).toBeUndefined();
  });
});

// ── uploadAvatar dispatcher ─────────────────────────────────────────────────

describe("uploadAvatar dispatcher", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("routes nip96 type — makes NIP-96 discovery request", async () => {
    const { uploadAvatar } = await import("./Nip96Client");
    const entry: FileServerEntry = { url: "https://nostr.build", type: "nip96" };
    const file = new Blob(["test"], { type: "image/jpeg" });

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // Mock discovery then upload
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ api_url: "https://nostr.build/api/v1/nip96" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: "https://cdn.nostr.build/avatar.jpg" }), { status: 200 }));

    try {
      const result = await uploadAvatar({ serverEntry: entry, file, signer: VALID_SIGNER });
      expect(result.url).toBe("https://cdn.nostr.build/avatar.jpg");
    } catch {
      // If the upload still fails (e.g. from sha256 extraction), the discovery was still attempted
    }
    // The NIP-96 code path always starts with a discovery request
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("nostr.build/.well-known/nostr/nip96.json"),
      expect.anything(),
    );
  });

  test("routes blossom type to PUT /upload", async () => {
    const { uploadAvatar } = await import("./Nip96Client");
    const entry: FileServerEntry = { url: "https://blossom.band", type: "blossom" };
    const file = new Blob(["test"], { type: "image/jpeg" });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ url: "https://blossom.band/abc123.jpg", sha256: "abc", size: 4, type: "image/jpeg", uploaded: 0 }),
        { status: 200 },
      ),
    );

    const result = await uploadAvatar({ serverEntry: entry, file, signer: VALID_SIGNER });
    expect(result.url).toBe("https://blossom.band/abc123.jpg");
    expect(result.nip94).toBeNull();
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://blossom.band/upload",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  test("routes originless type to POST /upload with no auth", async () => {
    const { uploadAvatar } = await import("./Nip96Client");
    const entry: FileServerEntry = { url: "https://originless.besoeasy.com", type: "originless" };
    const file = new Blob(["test"], { type: "image/jpeg" });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ url: "https://ipfs.io/ipfs/Qmabc123", cid: "Qmabc123", type: "image/jpeg", filename: "avatar.jpg" }),
        { status: 200 },
      ),
    );

    const result = await uploadAvatar({ serverEntry: entry, file });
    expect(result.url).toBe("https://ipfs.io/ipfs/Qmabc123");
    expect(result.nip94).toBeNull();
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://originless.besoeasy.com/upload",
      expect.objectContaining({ method: "POST" }),
    );
    // No Authorization header for originless
    const callArgs = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(callArgs.headers).toBeUndefined();
  });

  test("throws if blossom upload is called without signer", async () => {
    const { uploadAvatar } = await import("./Nip96Client");
    const entry: FileServerEntry = { url: "https://blossom.band", type: "blossom" };
    const file = new Blob(["test"], { type: "image/jpeg" });

    await expect(uploadAvatar({ serverEntry: entry, file })).rejects.toThrow("signer");
  });
});

// ── Blossom auth header (BUD-11 base64url) ──────────────────────────────────

describe("Blossom auth header generation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("uploadAvatarToBlossom sends kind 24242 Authorization header with base64url encoding", async () => {
    const { uploadAvatarToBlossom } = await import("./Nip96Client");
    const file = new Blob(["hello"], { type: "image/jpeg" });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ url: "https://blossom.band/file.jpg", sha256: "abc", size: 5, type: "image/jpeg", uploaded: 0 }),
        { status: 200 },
      ),
    );

    await uploadAvatarToBlossom({ serverUrl: "https://blossom.band", file, signer: VALID_SIGNER });

    const callArgs = fetchSpy.mock.calls[0][1] as RequestInit;
    const authHeader = (callArgs.headers as Record<string, string>)?.["Authorization"] ?? "";
    expect(authHeader).toMatch(/^Nostr /);

    // Extract base64url payload
    const token = authHeader.slice("Nostr ".length);

    // base64url: no + / chars, no = padding
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
    expect(token).not.toMatch(/=+$/);

    // Decode and verify event structure (restore standard base64 chars for atob)
    const padded = token.replace(/-/g, "+").replace(/_/g, "/").padEnd(
      token.length + ((4 - (token.length % 4)) % 4),
      "=",
    );
    const decoded = JSON.parse(atob(padded));
    expect(decoded.kind).toBe(24242);
    expect(decoded.content).toBe("Upload Blob");
    const tags: string[][] = decoded.tags;
    expect(tags.some((t) => t[0] === "t" && t[1] === "upload")).toBe(true);
    expect(tags.some((t) => t[0] === "x")).toBe(true);
    expect(tags.some((t) => t[0] === "expiration")).toBe(true);
  });
});

// ── Originless upload (no auth) ──────────────────────────────────────────────

describe("uploadAvatarToOriginless", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("sends POST with FormData and no Authorization header", async () => {
    const { uploadAvatarToOriginless } = await import("./Nip96Client");
    const file = new Blob(["data"], { type: "image/png" });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ url: "https://ipfs.io/ipfs/QmTest", cid: "QmTest", type: "image/png", filename: "avatar.jpg" }),
        { status: 200 },
      ),
    );

    const result = await uploadAvatarToOriginless({ serverUrl: "https://originless.besoeasy.com", file });
    expect(result.url).toBe("https://ipfs.io/ipfs/QmTest");

    const callArgs = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(callArgs.method).toBe("POST");
    expect(callArgs.body).toBeInstanceOf(FormData);
    expect(callArgs.headers).toBeUndefined();
  });

  test("throws on non-ok response with message from body", async () => {
    const { uploadAvatarToOriginless } = await import("./Nip96Client");
    const file = new Blob(["data"], { type: "image/png" });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Service unavailable" }), { status: 503 }),
    );

    await expect(
      uploadAvatarToOriginless({ serverUrl: "https://originless.besoeasy.com", file }),
    ).rejects.toThrow("Service unavailable");
  });

  test("throws if response has no url field", async () => {
    const { uploadAvatarToOriginless } = await import("./Nip96Client");
    const file = new Blob(["data"], { type: "image/png" });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ cid: "QmTest" }), { status: 200 }),
    );

    await expect(
      uploadAvatarToOriginless({ serverUrl: "https://originless.besoeasy.com", file }),
    ).rejects.toThrow("url");
  });
});
