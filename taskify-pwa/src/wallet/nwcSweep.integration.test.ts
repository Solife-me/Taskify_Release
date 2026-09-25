/**
 * End-to-end sweep against real nutshell mints (FakeWallet lightning backend).
 * Skipped unless CASHU_TEST_MINT_A and CASHU_TEST_MINT_B are set, e.g.
 *
 *   CASHU_TEST_MINT_A=http://127.0.0.1:3391 CASHU_TEST_MINT_B=http://127.0.0.1:3392 \
 *     npx vitest run src/wallet/nwcSweep.integration.test.ts
 *
 * Mint A is the ecash source (run it with MINT_INPUT_FEE_PPK > 0 to cover NUT-02 fees).
 * Mint B stands in for the NWC wallet: its mint quotes are the invoices we pay.
 * FakeWallet pays any invoice for a flat 1 sat lightning fee (FAKEWALLET_LN_FEE), so
 * nearly the whole fee reserve returns as NUT-08 change — exercising change handling
 * on every pass.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const memory = vi.hoisted(() => {
  // Node test environment (jsdom's Uint8Array realm breaks cashu-ts); kvStorage only needs this.
  const data = new Map<string, string>();
  (globalThis as any).localStorage = {
    get length() {
      return data.size;
    },
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
  return {
    stores: new Map<string, Map<string, string>>(),
    flushes: 0,
    failWrites: false,
  };
});

vi.mock("../storage/idbKeyValue", () => {
  const store = (name: string) => {
    let s = memory.stores.get(name);
    if (!s) {
      s = new Map();
      memory.stores.set(name, s);
    }
    return s;
  };
  let pendingFailure = false;
  return {
    idbKeyValue: {
      async initStore() {},
      getItem: (name: string, key: string) => store(name).get(key) ?? null,
      setItem: (name: string, key: string, value: string) => {
        if (memory.failWrites) pendingFailure = true;
        else store(name).set(key, value);
      },
      removeItem: (name: string, key: string) => {
        store(name).delete(key);
      },
      async flushStore() {
        memory.flushes += 1;
        if (pendingFailure) {
          pendingFailure = false;
          throw new Error("IndexedDB write failed");
        }
      },
      async flushAll() {},
    },
  };
});

import { getEncodedToken, Mint, Wallet, type Proof } from "@cashu/cashu-ts";
import { CashuManager } from "./CashuManager";
import { runSweep, type SweepDestination, type SweepJournal, type SweepJournalStore } from "./nwcSweep";
import { amountToSat, mintSweepSource } from "./nwcSweepAdapters";
import { listPendingMelts } from "./storage";

const MINT_A = process.env.CASHU_TEST_MINT_A ?? "";
/** nutshell's FakeWallet reports a 1 sat fee for every outgoing payment. */
const FAKEWALLET_LN_FEE = 1;
const MINT_B = process.env.CASHU_TEST_MINT_B ?? "";

class MemoryJournal implements SweepJournalStore {
  saved: SweepJournal | null = null;
  load() {
    return this.saved ? (JSON.parse(JSON.stringify(this.saved)) as SweepJournal) : null;
  }
  save(journal: SweepJournal) {
    this.saved = JSON.parse(JSON.stringify(journal)) as SweepJournal;
  }
}

/** Mint B's bolt11 mint quotes play the NWC wallet's make_invoice. */
function mintBDestination() {
  const issued: Array<{ invoice: string; amountSat: number; quote: string }> = [];
  const destination: SweepDestination = {
    async makeInvoice(amountSat) {
      const res = await fetch(`${MINT_B}/v1/mint/quote/bolt11`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: amountSat, unit: "sat" }),
      });
      if (!res.ok) throw new Error(`mint B quote failed: ${res.status}`);
      const body = (await res.json()) as { request: string; quote: string };
      issued.push({ invoice: body.request, amountSat, quote: body.quote });
      return { invoice: body.request, paymentHash: null };
    },
  };
  return { destination, issued };
}

async function fundManager(manager: CashuManager, amounts: number[]) {
  for (const amount of amounts) {
    const quote = await manager.createMintInvoice(amount);
    const quoteId = (quote as any).quote as string;
    for (let i = 0; i < 20; i += 1) {
      const state = await manager.checkMintQuote(quoteId);
      if (String((state as any).state).toUpperCase() === "PAID") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await manager.claimMint(quoteId, amount);
  }
}

async function unspentSat(mintUrl: string, proofs: Proof[]): Promise<number> {
  if (!proofs.length) return 0;
  const wallet = new Wallet(new Mint(mintUrl), { unit: "sat" });
  await wallet.loadMint();
  const grouped = await wallet.groupProofsByState(proofs);
  return grouped.unspent.reduce((sum, p) => sum + amountToSat(p.amount), 0);
}

async function newManager(): Promise<CashuManager> {
  const manager = new CashuManager(MINT_A);
  await manager.init();
  return manager;
}

describe.skipIf(!MINT_A || !MINT_B)("sweep against real nutshell mints", () => {
  beforeEach(() => {
    memory.stores.clear();
    memory.flushes = 0;
    memory.failWrites = false;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("sweeps the full balance, paying input fees and recovering change on every pass", async () => {
    const manager = await newManager();
    await fundManager(manager, [2100, 1500, 1337]);
    const start = manager.balance;
    expect(start).toBe(4937);

    const { destination, issued } = mintBDestination();
    const store = new MemoryJournal();
    const journal = await runSweep([mintSweepSource(manager as any)], destination, store, {
      sleep: async () => {},
    });

    const record = journal.sources[0];
    expect(journal.status).toBe("completed");
    const paidInvoices = record.attempts.filter((a) => a.state === "paid");
    const sent = paidInvoices.reduce((sum, a) => sum + a.amountSat, 0);
    expect(sent).toBe(record.sentSat);
    expect(issued.length).toBeGreaterThanOrEqual(paidInvoices.length);

    // Mint's own view: what's left unspent is exactly what the wallet stores.
    const remaining = await unspentSat(MINT_A, manager.proofs);
    expect(remaining).toBe(manager.balance);
    expect(sent + record.feesSat + remaining).toBe(start);
    // Only NUT-02 input fees and FakeWallet's 1 sat lightning fee are lost.
    expect(record.feesSat).toBeLessThanOrEqual(paidInvoices.length * 5);
    expect(listPendingMelts(MINT_A)).toHaveLength(0);
    // Durable-save before each melt reached the mint.
    expect(memory.flushes).toBeGreaterThanOrEqual(paidInvoices.length);
  }, 60_000);

  test("excludes proofs spent elsewhere (e.g. from another device on the same seed)", async () => {
    const manager = await newManager();
    await fundManager(manager, [1000, 700]);
    const stored = manager.proofs;
    const start = manager.balance;

    // Spend a subset out-of-band with an independent wallet.
    const victim = stored.slice(0, 2);
    const victimSat = victim.reduce((s, p) => s + amountToSat(p.amount), 0);
    const other = new Wallet(new Mint(MINT_A), { unit: "sat" });
    await other.loadMint();
    await other.receive(getEncodedToken({ mint: MINT_A, proofs: victim, unit: "sat" }));

    const plan = await manager.planSweep();
    expect(plan.excludedSat).toBe(victimSat);
    expect(plan.spendableSat).toBe(start - victimSat);

    const { destination } = mintBDestination();
    const journal = await runSweep([mintSweepSource(manager as any)], destination, new MemoryJournal(), {
      sleep: async () => {},
    });
    const record = journal.sources[0];
    expect(journal.status).toBe("completed");
    const remaining = await unspentSat(MINT_A, manager.proofs);
    expect(record.sentSat + record.feesSat + remaining).toBe(start - victimSat);
  }, 60_000);

  test("lost melt response is recovered from the mint and change is kept", async () => {
    const manager = await newManager();
    await fundManager(manager, [3000]);
    const start = manager.balance;

    const wallet = (manager as any).wallet as Wallet & { completeMelt: (...args: any[]) => Promise<any> };
    const realComplete = wallet.completeMelt.bind(wallet);
    let dropped = 0;
    vi.spyOn(wallet, "completeMelt").mockImplementation(async (...args: any[]) => {
      await realComplete(...args);
      if (dropped === 0) {
        dropped += 1;
        throw new Error("NetworkError: connection reset after melt");
      }
      return realComplete(...args);
    });

    const { destination } = mintBDestination();
    const journal = await runSweep([mintSweepSource(manager as any)], destination, new MemoryJournal(), {
      sleep: async () => {},
      maxPasses: 1,
    });
    const record = journal.sources[0];
    expect(dropped).toBe(1);
    expect(record.attempts.filter((a) => a.state === "paid")).toHaveLength(1);

    const remaining = await unspentSat(MINT_A, manager.proofs);
    expect(remaining).toBe(manager.balance);
    // The whole fee reserve came back as change even though the response was lost.
    expect(record.sentSat + record.feesSat + remaining).toBe(start);
    expect(remaining).toBeGreaterThan(0);
    expect(listPendingMelts(MINT_A)).toHaveLength(0);
  }, 60_000);

  test("melt outcome unknown at crash time is settled on the next launch without losing change", async () => {
    const manager = await newManager();
    await fundManager(manager, [4000]);
    const start = manager.balance;

    // Melt reaches the mint, the response is lost, and the mint can't be re-checked
    // (e.g. the tab is closed or the network drops right after sending).
    const wallet = (manager as any).wallet as Wallet & { completeMelt: (...args: any[]) => Promise<any> };
    const realComplete = wallet.completeMelt.bind(wallet);
    vi.spyOn(wallet, "completeMelt").mockImplementation(async (...args: any[]) => {
      await realComplete(...args);
      throw new Error("NetworkError: connection reset after melt");
    });
    vi.spyOn(manager as any, "checkMeltQuoteSafe").mockResolvedValue(null);

    const { destination } = mintBDestination();
    const store = new MemoryJournal();
    const first = await runSweep([mintSweepSource(manager as any)], destination, store, { sleep: async () => {} });
    expect(first.sources[0].status).toBe("awaiting_settlement");
    expect(listPendingMelts(MINT_A)).toHaveLength(1);
    vi.restoreAllMocks();

    // Next launch: init() recovers the pending melt from storage, rebuilding change.
    const restarted = await newManager();
    expect(listPendingMelts(MINT_A)).toHaveLength(0);
    const journal = await runSweep([mintSweepSource(restarted as any)], destination, store, {
      sleep: async () => {},
      journal: store.load(),
    });

    expect(journal.status).toBe("completed");
    const record = journal.sources[0];
    const remaining = await unspentSat(MINT_A, restarted.proofs);
    expect(remaining).toBe(restarted.balance);
    expect(record.sentSat + record.feesSat + remaining).toBe(start);
    // Only NUT-02 input fees and FakeWallet's 1 sat lightning fee may be lost.
    expect(record.feesSat).toBeLessThanOrEqual(record.attempts.filter((a) => a.state === "paid").length * 5);
  }, 60_000);

  test("a failed durable save stops the melt before the mint sees it", async () => {
    const manager = await newManager();
    await fundManager(manager, [800]);
    const start = manager.balance;

    const { destination } = mintBDestination();
    memory.failWrites = true;
    const journal = await runSweep([mintSweepSource(manager as any)], destination, new MemoryJournal(), {
      sleep: async () => {},
    });
    memory.failWrites = false;

    expect(journal.sources[0].status).toBe("failed");
    expect(journal.sources[0].sentSat).toBe(0);
    expect(await unspentSat(MINT_A, manager.proofs)).toBe(start);
  }, 60_000);

  test("resumes a sweep after the app restarts mid-run", async () => {
    const manager = await newManager();
    await fundManager(manager, [2048, 512]);
    const start = manager.balance;
    const { destination } = mintBDestination();
    const store = new MemoryJournal();

    // First run stops after one pass (like the tab closing between passes).
    await runSweep([mintSweepSource(manager as any)], destination, store, { sleep: async () => {}, maxPasses: 1 });

    // "Restart": a fresh manager loads proofs from storage and recovers pending melts.
    const restarted = await newManager();
    const journal = await runSweep([mintSweepSource(restarted as any)], destination, store, {
      sleep: async () => {},
      journal: store.load(),
    });
    // The first run already finished the source, so the resume leaves it alone.
    expect(journal.status).toBe("completed");
    const remaining = await unspentSat(MINT_A, restarted.proofs);
    expect(remaining).toBe(restarted.balance);
    expect(journal.sources[0].sentSat + journal.sources[0].feesSat + remaining).toBe(start);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Stored (unredeemed) tokens swept straight from their own proofs
// ---------------------------------------------------------------------------

import * as CashuLib from "@cashu/cashu-ts";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  resolveOutstandingTokenSweeps,
  tokenSweepSource,
  type StoredTokenRef,
  type TokenSweepLedger,
  type TokenSweepRecord,
  type TokenSweepRecordStore,
} from "./nwcSweepAdapters";

class MemoryTokenRecords implements TokenSweepRecordStore {
  records = new Map<string, TokenSweepRecord>();
  failPut = false;
  get(id: string) {
    const r = this.records.get(id);
    return r ? (JSON.parse(JSON.stringify(r)) as TokenSweepRecord) : null;
  }
  list() {
    return [...this.records.values()].map((r) => JSON.parse(JSON.stringify(r)) as TokenSweepRecord);
  }
  put(record: TokenSweepRecord) {
    if (this.failPut) throw new Error("Could not save sweep progress to this device's storage");
    this.records.set(record.quoteId, JSON.parse(JSON.stringify(record)));
  }
  remove(id: string) {
    this.records.delete(id);
  }
}

class MemoryLedger implements TokenSweepLedger {
  tokens = new Map<string, { mint: string; token: string; amount: number }>();
  async addChangeToken(mint: string, token: string, amountSat: number) {
    this.tokens.set(`change-${this.tokens.size}-${Date.now()}`, { mint, token, amount: amountSat });
  }
  async removeToken(id: string) {
    this.tokens.delete(id);
  }
  add(id: string, mint: string, token: string, amount: number): StoredTokenRef {
    this.tokens.set(id, { mint, token, amount });
    return { id, mint, token };
  }
  changeTokens() {
    return [...this.tokens.entries()].filter(([id]) => id.startsWith("change-")).map(([, t]) => t);
  }
}

/** A separate "sender" wallet mints ecash and hands us a token, like a DM or nutzap would. */
async function receiveTokenFromSender(amount: number, p2pkPubkey?: string): Promise<{ token: string; proofs: Proof[] }> {
  const sender = new Wallet(new Mint(MINT_A), { unit: "sat" });
  await sender.loadMint();
  const quote = await sender.createMintQuoteBolt11(amount);
  for (let i = 0; i < 20; i += 1) {
    const q = await sender.checkMintQuoteBolt11(quote.quote);
    if (String(q.state).toUpperCase() === "PAID") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const minted = await sender.mintProofsBolt11(amount, quote.quote);
  let proofs = minted as Proof[];
  if (p2pkPubkey) {
    const locked = await sender.send(amount - 20, minted, { includeFees: true } as any, {
      send: { type: "p2pk", options: { pubkey: p2pkPubkey } },
    } as any);
    proofs = locked.send as Proof[];
  }
  return { token: getEncodedToken({ mint: MINT_A, proofs, unit: "sat" }), proofs };
}

async function tokenMint(manager: CashuManager) {
  const conn = manager as any;
  return {
    mintUrl: MINT_A,
    unit: "sat",
    decodeTokenWithKeysets: async (t: string) => conn.decodeTokenWithKeysets(t),
    checkProofStates: (p: Proof[]) => conn.checkProofStates(p),
    inputFeeForProofs: async (p: Proof[]) => conn.inputFeeForProofs(p),
    createMeltQuote: (i: string) => conn.createMeltQuote(i),
    meltForeignProofs: (q: any, p: Proof[], persist: any) => conn.meltForeignProofs(q, p, persist),
    rebuildMeltChange: (id: string, preview: any) => conn.rebuildMeltChange(id, preview),
    checkMeltQuoteState: (q: any) => conn.checkMeltQuoteState(q),
  };
}

describe.skipIf(!MINT_A || !MINT_B)("sweeping stored tokens against real nutshell mints", () => {
  beforeEach(() => {
    memory.stores.clear();
    memory.failWrites = false;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("sweeps a token without claiming it into the wallet and keeps change as a new token", async () => {
    const manager = await newManager();
    const { token, proofs } = await receiveTokenFromSender(3000);
    const ledger = new MemoryLedger();
    const entry = ledger.add("t1", MINT_A, token, 3000);
    const records = new MemoryTokenRecords();
    const { destination } = mintBDestination();

    const journal = await runSweep(
      [tokenSweepSource(entry, await tokenMint(manager), ledger, records)],
      destination,
      new MemoryJournal(),
      { sleep: async () => {}, maxPasses: 1 },
    );

    const record = journal.sources[0];
    expect(journal.status).toBe("completed");
    expect(manager.balance).toBe(0); // never touched the ecash wallet
    expect(ledger.tokens.has("t1")).toBe(false);
    expect(await unspentSat(MINT_A, proofs)).toBe(0);
    const change = ledger.changeTokens();
    const changeSat = change.reduce((s, t) => s + t.amount, 0);
    // Change tokens are real, unspent and portable.
    for (const t of change) {
      const decoded = await (manager as any).decodeTokenWithKeysets(t.token);
      expect(await unspentSat(MINT_A, decoded.proofs)).toBe(t.amount);
    }
    expect(record.sentSat + record.feesSat + changeSat).toBe(3000);
    expect(records.list()).toHaveLength(0);
  }, 60_000);

  test("sweeps a token locked to the user's key (P2PK)", async () => {
    const privkey = bytesToHex(CashuLib.createRandomSecretKey() as Uint8Array);
    const pubkey = bytesToHex(CashuLib.getPubKeyFromPrivKey(Buffer.from(privkey, "hex")) as Uint8Array);
    const manager = new CashuManager(MINT_A, { getP2PKPrivkey: (pk: string) => (pk.endsWith(pubkey.slice(2)) ? privkey : null) });
    await manager.init();
    const { token, proofs } = await receiveTokenFromSender(1500, pubkey);
    const tokenSat = proofs.reduce((s, p) => s + amountToSat(p.amount), 0);
    const ledger = new MemoryLedger();
    const entry = ledger.add("locked", MINT_A, token, tokenSat);
    const { destination } = mintBDestination();

    const journal = await runSweep(
      [tokenSweepSource(entry, await tokenMint(manager), ledger, new MemoryTokenRecords())],
      destination,
      new MemoryJournal(),
      { sleep: async () => {}, maxPasses: 1 },
    );
    expect(journal.sources[0].status).toBe("swept");
    expect(await unspentSat(MINT_A, proofs)).toBe(0);
    const changeSat = ledger.changeTokens().reduce((s, t) => s + t.amount, 0);
    expect(journal.sources[0].sentSat + journal.sources[0].feesSat + changeSat).toBe(tokenSat);
  }, 60_000);

  test("a token the sender already reclaimed is reported, not melted", async () => {
    const manager = await newManager();
    const { token, proofs } = await receiveTokenFromSender(900);
    const reclaimer = new Wallet(new Mint(MINT_A), { unit: "sat" });
    await reclaimer.loadMint();
    await reclaimer.receive(getEncodedToken({ mint: MINT_A, proofs, unit: "sat" }));

    const ledger = new MemoryLedger();
    const entry = ledger.add("gone", MINT_A, token, 900);
    const { destination, issued } = mintBDestination();
    const journal = await runSweep(
      [tokenSweepSource(entry, await tokenMint(manager), ledger, new MemoryTokenRecords())],
      destination,
      new MemoryJournal(),
      { sleep: async () => {} },
    );
    expect(journal.sources[0].status).toBe("dust");
    expect(journal.sources[0].excludedSat).toBe(900);
    expect(issued).toHaveLength(0);
    expect(ledger.tokens.has("gone")).toBe(true); // left for the user to review
  }, 60_000);

  test("crash after the melt is recovered on the next launch, change included", async () => {
    const manager = await newManager();
    const { token, proofs } = await receiveTokenFromSender(2500);
    const ledger = new MemoryLedger();
    const entry = ledger.add("t2", MINT_A, token, 2500);
    const records = new MemoryTokenRecords();

    const wallet = (manager as any).wallet as Wallet & { completeMelt: (...args: any[]) => Promise<any> };
    const realComplete = wallet.completeMelt.bind(wallet);
    vi.spyOn(wallet, "completeMelt").mockImplementation(async (...args: any[]) => {
      await realComplete(...args);
      throw new Error("NetworkError: tab closed");
    });
    vi.spyOn(manager as any, "checkMeltQuoteSafe").mockResolvedValue(null);

    const { destination } = mintBDestination();
    const first = await runSweep(
      [tokenSweepSource(entry, await tokenMint(manager), ledger, records)],
      destination,
      new MemoryJournal(),
      { sleep: async () => {}, maxPasses: 1 },
    );
    expect(first.sources[0].status).toBe("awaiting_settlement");
    expect(records.list()).toHaveLength(1);
    expect(ledger.tokens.has("t2")).toBe(true);
    vi.restoreAllMocks();

    const restarted = await newManager();
    const unresolved = await resolveOutstandingTokenSweeps(records, async () => tokenMint(restarted), ledger);
    expect(unresolved).toBe(0);
    expect(records.list()).toHaveLength(0);
    expect(ledger.tokens.has("t2")).toBe(false);
    expect(await unspentSat(MINT_A, proofs)).toBe(0);
    const paid = first.sources[0].attempts.find((a) => a.state === "melting")!;
    const changeSat = ledger.changeTokens().reduce((s, t) => s + t.amount, 0);
    const inputFee = await restarted.inputFeeForProofs(proofs);
    // Nothing lost but the input fee and FakeWallet's lightning fee: the rest of the
    // fee reserve came back as change even though the melt response was lost.
    expect(paid.amountSat + changeSat + inputFee + FAKEWALLET_LN_FEE).toBe(2500);
  }, 60_000);

  test("failing to save the sweep record stops the melt and leaves the token intact", async () => {
    const manager = await newManager();
    const { token, proofs } = await receiveTokenFromSender(1200);
    const ledger = new MemoryLedger();
    const entry = ledger.add("t3", MINT_A, token, 1200);
    const records = new MemoryTokenRecords();
    records.failPut = true;
    const { destination } = mintBDestination();

    const journal = await runSweep(
      [tokenSweepSource(entry, await tokenMint(manager), ledger, records)],
      destination,
      new MemoryJournal(),
      { sleep: async () => {} },
    );
    expect(journal.sources[0].status).toBe("failed");
    expect(await unspentSat(MINT_A, proofs)).toBe(1200);
    expect(ledger.tokens.has("t3")).toBe(true);
  }, 60_000);
});
