import { expect, test, vi } from "vitest";

import {
  claimSolifeCustomAddress,
  fetchSolifeAccount,
  updateSolifeLightningAddressMint,
} from "./solife.ts";

const SECRET_KEY = "0".repeat(63) + "1";
const BASE_URL = "https://solife.test";
const CONFIG = {
  domain: "solife.me",
  publicUrl: "https://solife.me",
  mintUrl: "https://mint.solife.me",
  customAddressPriceSats: 1000,
  authKind: 27235,
};

type FetchRecord = {
  url: string;
  init: RequestInit;
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestBody(init: RequestInit): any {
  return typeof init.body === "string" ? JSON.parse(init.body) : undefined;
}

function pathOf(record: FetchRecord): string {
  return new URL(record.url).pathname;
}

function makeSolifeFetcher(handler: (record: FetchRecord) => unknown): { fetcher: typeof fetch; records: FetchRecord[] } {
  const records: FetchRecord[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const record = { url: String(input), init };
    records.push(record);
    return jsonResponse(handler(record));
  }) as unknown as typeof fetch;
  return { fetcher, records };
}

function withAuth(handler: (record: FetchRecord) => unknown) {
  return (record: FetchRecord) => {
    const path = pathOf(record);
    if (path === "/api/config") return CONFIG;
    if (path === "/api/auth/challenge") {
      return {
        challenge: "abc123",
        message: "Sign in to solife.me: abc123",
        kind: 27235,
      };
    }
    if (path === "/api/auth/verify") return {};
    return handler(record);
  };
}

test("claimSolifeCustomAddress supports invoice purchase responses", async () => {
  const { fetcher, records } = makeSolifeFetcher(
    withAuth((record) => {
      expect(pathOf(record)).toBe("/api/addresses");
      expect(record.init.method).toBe("POST");
      expect(record.init.credentials).toBe("include");
      expect(requestBody(record.init)).toEqual({
        handle: "alice",
        relays: ["wss://relay.solife.me"],
        mintUrl: "https://mint.custom",
      });
      return {
        purchaseId: "purchase_1",
        handle: "alice",
        address: "Alice@Solife.Me",
        priceSats: "1000",
        bolt11: "lnbc10u1...",
        status: "invoice_issued",
        expiresAt: "1800",
      };
    }),
  );

  const result = await claimSolifeCustomAddress(
    SECRET_KEY,
    {
      handle: "alice",
      relays: ["wss://relay.solife.me"],
      mintUrl: "https://mint.custom",
    },
    { baseUrl: BASE_URL, fetcher },
  );

  expect(result.claim.kind).toBe("purchase");
  if (result.claim.kind === "purchase") {
    expect(result.claim.purchase).toMatchObject({
      purchaseId: "purchase_1",
      address: "alice@solife.me",
      priceSats: 1000,
      status: "invoice_issued",
      expiresAt: 1800,
    });
  }

  expect(records.find((record) => pathOf(record) === "/api/config")?.init.credentials).toBeUndefined();
  expect(records.find((record) => pathOf(record) === "/api/auth/challenge")?.init.credentials).toBe("include");
  expect(records.find((record) => pathOf(record) === "/api/auth/verify")?.init.credentials).toBe("include");
});

test("fetchSolifeAccount normalizes new account fields", async () => {
  const { fetcher } = makeSolifeFetcher(
    withAuth((record) => {
      expect(pathOf(record)).toBe("/api/me");
      expect(record.init.credentials).toBe("include");
      return {
        pubkey: "pubkey",
        npub: "npub1...",
        lightningAddress: "npub1...@solife.me",
        relays: "not-an-array",
        addresses: [],
      };
    }),
  );

  const result = await fetchSolifeAccount(SECRET_KEY, { baseUrl: BASE_URL, fetcher });

  expect(result.account.relays).toEqual([]);
  expect(result.account.addressPurchases).toEqual([]);
  expect(result.account.lightningAddressMintUrl).toBe(CONFIG.mintUrl);
  expect(result.account.lightningAddressMintOverride).toBe(false);
});

test("updateSolifeLightningAddressMint patches the selected custom address", async () => {
  const { fetcher, records } = makeSolifeFetcher(
    withAuth((record) => {
      expect(pathOf(record)).toBe("/api/addresses/alice");
      expect(record.init.method).toBe("PATCH");
      expect(record.init.credentials).toBe("include");
      expect(requestBody(record.init)).toEqual({ mintUrl: "" });
      return {
        handle: "alice",
        address: "alice@solife.me",
        pubkey: "pubkey",
        relays: [],
        mintUrl: CONFIG.mintUrl,
        mintOverride: false,
      };
    }),
  );

  const result = await updateSolifeLightningAddressMint(
    SECRET_KEY,
    { handle: "Alice", mintUrl: null },
    { baseUrl: BASE_URL, fetcher },
  );

  expect(result).toMatchObject({
    mintUrl: CONFIG.mintUrl,
    mintOverride: false,
    address: { handle: "alice", address: "alice@solife.me" },
  });
  expect(records.map(pathOf)).toEqual([
    "/api/config",
    "/api/auth/challenge",
    "/api/auth/verify",
    "/api/addresses/alice",
  ]);
});
