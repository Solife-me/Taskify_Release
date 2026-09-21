import { describe, expect, test } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  journalHasUnsettledMelts,
  preimageMatchesPaymentHash,
  runSweep,
  summarizeSweepJournal,
  SweepSafetyError,
  type SweepDestination,
  type SweepJournal,
  type SweepJournalStore,
  type SweepMeltResult,
  type SweepPlan,
  type SweepQuote,
  type SweepSource,
} from "./nwcSweep";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function randomHex(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

function splitPowersOfTwo(amount: number): number[] {
  const out: number[] = [];
  let bit = 1;
  let rest = amount;
  while (rest > 0) {
    if (rest & 1) out.push(bit);
    rest >>= 1;
    bit <<= 1;
  }
  return out;
}

type FakeInvoice = { invoice: string; amountSat: number; paymentHash: string; preimage: string; settled: boolean };

/** Lightning network + NWC wallet. The mint "pays" invoices by calling settle(). */
class FakeNwcWallet implements SweepDestination {
  invoices = new Map<string, FakeInvoice>();
  receivedSat = 0;
  makeInvoiceCalls = 0;
  /** Returns an invoice for a different amount than requested (buggy wallet). */
  amountSkew = 0;
  omitPaymentHash = false;
  supportsLookup = true;
  failMakeInvoice: Error | null = null;

  async makeInvoice(amountSat: number): Promise<{ invoice: string; paymentHash: string | null }> {
    this.makeInvoiceCalls += 1;
    if (this.failMakeInvoice) throw this.failMakeInvoice;
    const preimage = randomHex();
    const paymentHash = bytesToHex(sha256(Buffer.from(preimage, "hex")));
    const invoiceAmount = amountSat + this.amountSkew;
    const invoice = `lnfake${invoiceAmount}n1${paymentHash.slice(0, 20)}${randomHex(4)}`;
    this.invoices.set(invoice, { invoice, amountSat: invoiceAmount, paymentHash, preimage, settled: false });
    return { invoice, paymentHash: this.omitPaymentHash ? null : paymentHash };
  }

  settle(invoice: string): { preimage: string; amountSat: number } {
    const entry = this.invoices.get(invoice);
    if (!entry) throw new Error("unknown invoice");
    if (entry.settled) throw new Error("invoice already paid");
    entry.settled = true;
    this.receivedSat += entry.amountSat;
    return { preimage: entry.preimage, amountSat: entry.amountSat };
  }

  amountOf(invoice: string): number {
    const entry = this.invoices.get(invoice);
    if (!entry) throw new Error("unknown invoice");
    return entry.amountSat;
  }

  get lookupInvoice() {
    if (!this.supportsLookup) return undefined;
    return async (ref: { paymentHash?: string | null; invoice: string }) => {
      const entry = this.invoices.get(ref.invoice);
      return entry ? { settled: entry.settled, preimage: entry.settled ? entry.preimage : null } : null;
    };
  }
}

type Proof = { id: string; amount: number; state: "UNSPENT" | "SPENT" | "PENDING" };

type MintQuote = {
  quoteId: string;
  invoice: string;
  amountSat: number;
  feeReserveSat: number;
  state: "UNPAID" | "PENDING" | "PAID";
  preimage?: string;
  change?: number;
  spentInputs?: Proof[];
};

type FakeMintOptions = {
  proofs: number[];
  /** NUT-02 input fee in parts-per-thousand per proof. */
  inputFeePpk?: number;
  feeReserve?: (amountSat: number) => number;
  /** Lightning fee the mint actually pays (<= reserve). */
  actualFee?: (amountSat: number, reserve: number) => number;
};

/**
 * A mint that enforces NUT-05 balance rules, returns NUT-08 change, charges NUT-02
 * input fees, and lets tests inject network failures and pending payments.
 */
class FakeMintSource implements SweepSource {
  readonly id: string;
  readonly label: string;
  proofs: Proof[];
  quotes = new Map<string, MintQuote>();
  lightningFeesPaidSat = 0;
  inputFeesPaidSat = 0;
  meltCalls = 0;
  quoteCalls = 0;

  inputFeePpk: number;
  feeReserve: (amountSat: number) => number;
  actualFee: (amountSat: number, reserve: number) => number;

  // Fault injection
  failNextQuote: Error | null = null;
  /** Melt request never reaches the mint; the wallet sees a network error. */
  failMeltBeforeSubmit = false;
  /** Mint pays the invoice but the response is lost. */
  loseMeltResponse = false;
  /** Mint leaves the lightning payment in flight. */
  meltGoesPending = false;
  /** checkMeltQuote can't reach the mint. */
  checkUnavailable = false;
  /** Mint rejects the melt (e.g. lightning route failure) and returns inputs. */
  meltFailsUnpaid = false;
  /** Quote the wrong amount. */
  quoteAmountSkew = 0;

  private readonly nwc: FakeNwcWallet;

  constructor(nwc: FakeNwcWallet, id: string, options: FakeMintOptions) {
    this.nwc = nwc;
    this.id = id;
    this.label = id.replace(/^https?:\/\//, "");
    this.proofs = options.proofs.map((amount) => ({ id: randomHex(8), amount, state: "UNSPENT" as const }));
    this.inputFeePpk = options.inputFeePpk ?? 0;
    this.feeReserve = options.feeReserve ?? ((amount) => Math.max(2, Math.ceil(amount * 0.01)));
    this.actualFee = options.actualFee ?? (() => 0);
  }

  get unspentSat(): number {
    return this.proofs.filter((p) => p.state === "UNSPENT").reduce((sum, p) => sum + p.amount, 0);
  }

  get walletSat(): number {
    // What the wallet still owns: unspent proofs plus proofs reserved by an in-flight melt.
    return this.proofs.filter((p) => p.state !== "SPENT").reduce((sum, p) => sum + p.amount, 0);
  }

  inputFeeFor(count: number): number {
    return Math.floor((count * this.inputFeePpk + 999) / 1000);
  }

  markSpent(amount: number) {
    const proof = this.proofs.find((p) => p.state === "UNSPENT" && p.amount === amount);
    if (!proof) throw new Error(`no unspent ${amount} proof`);
    proof.state = "SPENT";
  }

  async plan(): Promise<SweepPlan> {
    const spendable = this.proofs.filter((p) => p.state === "UNSPENT");
    const excluded = this.proofs.filter((p) => p.state !== "UNSPENT");
    return {
      spendableSat: spendable.reduce((sum, p) => sum + p.amount, 0),
      inputFeeSat: this.inputFeeFor(spendable.length),
      excludedSat: excluded.reduce((sum, p) => sum + p.amount, 0),
      handle: spendable.map((p) => p.id),
    };
  }

  async createMeltQuote(invoice: string): Promise<SweepQuote> {
    this.quoteCalls += 1;
    if (this.failNextQuote) {
      const err = this.failNextQuote;
      this.failNextQuote = null;
      throw err;
    }
    const amountSat = this.nwc.amountOf(invoice) + this.quoteAmountSkew;
    const quote: MintQuote = {
      quoteId: `q_${randomHex(6)}`,
      invoice,
      amountSat,
      feeReserveSat: this.feeReserve(amountSat),
      state: "UNPAID",
    };
    this.quotes.set(quote.quoteId, quote);
    return { quoteId: quote.quoteId, amountSat: quote.amountSat, feeReserveSat: quote.feeReserveSat };
  }

  private result(quote: MintQuote): SweepMeltResult {
    return { state: quote.state, preimage: quote.preimage ?? null, changeSat: quote.change };
  }

  async melt(sweepQuote: SweepQuote, plan: SweepPlan): Promise<SweepMeltResult> {
    this.meltCalls += 1;
    if (this.failMeltBeforeSubmit) {
      this.failMeltBeforeSubmit = false;
      throw new Error("NetworkError: request not sent");
    }
    const quote = this.quotes.get(sweepQuote.quoteId);
    if (!quote) throw new Error("unknown quote");
    if (quote.state !== "UNPAID") throw new Error("quote already used");

    const ids = new Set(plan.handle as string[]);
    const inputs = this.proofs.filter((p) => ids.has(p.id));
    if (inputs.length !== ids.size || inputs.some((p) => p.state !== "UNSPENT")) {
      throw new Error("Token already spent");
    }
    const inputSat = inputs.reduce((sum, p) => sum + p.amount, 0);
    const inputFee = this.inputFeeFor(inputs.length);
    if (inputSat < quote.amountSat + quote.feeReserveSat + inputFee) {
      throw new Error("not enough inputs provided for melt");
    }

    if (this.meltFailsUnpaid) {
      this.meltFailsUnpaid = false;
      throw new Error("Lightning payment failed");
    }

    // Inputs are locked while the lightning payment is in flight.
    for (const p of inputs) p.state = "PENDING";
    quote.spentInputs = inputs;

    if (this.meltGoesPending) {
      quote.state = "PENDING";
      return this.result(quote);
    }
    this.finishPayment(quote);
    if (this.loseMeltResponse) {
      this.loseMeltResponse = false;
      throw new Error("NetworkError: connection reset");
    }
    return this.result(quote);
  }

  /** Completes an in-flight lightning payment. */
  finishPayment(quote: MintQuote) {
    const inputs = quote.spentInputs ?? [];
    const inputSat = inputs.reduce((sum, p) => sum + p.amount, 0);
    const inputFee = this.inputFeeFor(inputs.length);
    const lnFee = Math.min(quote.feeReserveSat, this.actualFee(quote.amountSat, quote.feeReserveSat));
    const { preimage } = this.nwc.settle(quote.invoice);
    for (const p of inputs) p.state = "SPENT";
    const change = inputSat - quote.amountSat - lnFee - inputFee;
    for (const amount of splitPowersOfTwo(change)) {
      this.proofs.push({ id: randomHex(8), amount, state: "UNSPENT" });
    }
    this.lightningFeesPaidSat += lnFee;
    this.inputFeesPaidSat += inputFee;
    quote.state = "PAID";
    quote.preimage = preimage;
    quote.change = change;
  }

  /** Lightning payment in flight fails; mint releases the inputs. */
  failPendingPayment(quote: MintQuote) {
    for (const p of quote.spentInputs ?? []) p.state = "UNSPENT";
    quote.state = "UNPAID";
  }

  pendingQuotes(): MintQuote[] {
    return [...this.quotes.values()].filter((q) => q.state === "PENDING");
  }

  async checkMeltQuote(quoteId: string): Promise<SweepMeltResult | null> {
    if (this.checkUnavailable) return null;
    const quote = this.quotes.get(quoteId);
    return quote ? this.result(quote) : null;
  }
}

class MemoryJournalStore implements SweepJournalStore {
  saved: SweepJournal | null = null;
  saves = 0;
  load() {
    return this.saved ? (JSON.parse(JSON.stringify(this.saved)) as SweepJournal) : null;
  }
  save(journal: SweepJournal) {
    this.saves += 1;
    // Round-trip through JSON the way real storage would.
    this.saved = JSON.parse(JSON.stringify(journal)) as SweepJournal;
  }
}

const fastOptions = { sleep: async () => {}, lookupDelayMs: 0 };

/** Every sat that started in the mint is either still owned, in the NWC wallet, or a fee. */
function expectConservation(start: number, mint: FakeMintSource, nwc: FakeNwcWallet, journal?: SweepJournal) {
  expect(mint.walletSat + nwc.receivedSat + mint.lightningFeesPaidSat + mint.inputFeesPaidSat).toBe(start);
  if (journal) {
    const record = journal.sources.find((s) => s.sourceId === mint.id)!;
    expect(record.sentSat).toBe(nwc.receivedSat);
  }
}

function makeRng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("preimage verification", () => {
  test("accepts a matching preimage and rejects others", () => {
    const preimage = randomHex();
    const hash = bytesToHex(sha256(Buffer.from(preimage, "hex")));
    expect(preimageMatchesPaymentHash(preimage, hash)).toBe(true);
    expect(preimageMatchesPaymentHash(preimage.toUpperCase(), hash)).toBe(true);
    expect(preimageMatchesPaymentHash(randomHex(), hash)).toBe(false);
    expect(preimageMatchesPaymentHash("not-hex", hash)).toBe(false);
    expect(preimageMatchesPaymentHash(preimage, "")).toBe(false);
  });
});

describe("runSweep: happy paths", () => {
  test("sweeps a single mint, leaving only the last pass's returned fee reserve", async () => {
    const nwc = new FakeNwcWallet();
    const mint = new FakeMintSource(nwc, "https://mint.a", { proofs: splitPowersOfTwo(10_000) });
    const store = new MemoryJournalStore();

    const journal = await runSweep([mint], nwc, store, fastOptions);

    const record = journal.sources[0];
    expect(journal.status).toBe("completed");
    expect(record.status).toBe("swept");
    expectConservation(10_000, mint, nwc, journal);
    // Zero actual lightning fee: everything but the final reserve (<= 2 sats) arrives.
    expect(nwc.receivedSat).toBeGreaterThanOrEqual(10_000 - 2);
    expect(record.remainingSat).toBe(mint.unspentSat);
    expect(record.attempts.filter((a) => a.state === "paid").every((a) => a.verification === "preimage")).toBe(true);
    expect(store.saved?.status).toBe("completed");
  });

  test("fits the invoice to the mint's real fee reserve instead of the initial guess", async () => {
    const nwc = new FakeNwcWallet();
    // Reserve much larger than the 1% guess forces the amount search to shrink the invoice.
    const mint = new FakeMintSource(nwc, "https://mint.a", {
      proofs: splitPowersOfTwo(5_000),
      feeReserve: (amount) => Math.max(20, Math.ceil(amount * 0.03)),
      actualFee: (_amount, reserve) => reserve,
    });
    const journal = await runSweep([mint], nwc, new MemoryJournalStore(), {
      ...fastOptions,
      maxFeeReserveRatio: 0.05,
    });

    expect(journal.sources[0].status).not.toBe("failed");
    expectConservation(5_000, mint, nwc, journal);
    const first = journal.sources[0].attempts.find((a) => a.state === "paid")!;
    expect(first.amountSat + first.feeReserveSat!).toBeLessThanOrEqual(5_000);
    // Tight fit: no more than one sat of unused budget on the first melt.
    expect(5_000 - first.amountSat - first.feeReserveSat!).toBeLessThanOrEqual(1);
  });

  test("accounts for NUT-02 input fees when spending every proof", async () => {
    const nwc = new FakeNwcWallet();
    // 40 proofs at 1000 ppk = 40 sats of input fee.
    const proofs = Array.from({ length: 40 }, () => 64);
    const mint = new FakeMintSource(nwc, "https://mint.fees", { proofs, inputFeePpk: 1000 });
    const journal = await runSweep([mint], nwc, new MemoryJournalStore(), fastOptions);

    expect(journal.status).toBe("completed");
    expectConservation(40 * 64, mint, nwc, journal);
    expect(mint.inputFeesPaidSat).toBeGreaterThanOrEqual(40);
    const first = journal.sources[0].attempts.find((a) => a.state === "paid")!;
    expect(first.inputFeeSat).toBe(40);
  });

  test("sweeps several mints independently", async () => {
    const nwc = new FakeNwcWallet();
    const a = new FakeMintSource(nwc, "https://mint.a", { proofs: splitPowersOfTwo(1_234) });
    const b = new FakeMintSource(nwc, "https://mint.b", { proofs: splitPowersOfTwo(98_765), inputFeePpk: 100 });
    const c = new FakeMintSource(nwc, "https://mint.c", { proofs: [] });

    const journal = await runSweep([a, b, c], nwc, new MemoryJournalStore(), fastOptions);

    expect(journal.status).toBe("completed");
    expect(journal.sources.map((s) => s.status)).toEqual(["swept", "swept", "dust"]);
    const total = a.walletSat + b.walletSat + c.walletSat + nwc.receivedSat +
      a.lightningFeesPaidSat + b.lightningFeesPaidSat + a.inputFeesPaidSat + b.inputFeesPaidSat;
    expect(total).toBe(1_234 + 98_765);
    expect(summarizeSweepJournal(journal).sentSat).toBe(nwc.receivedSat);
  });

  test("reports balances too small to cover fees as dust without creating invoices", async () => {
    const nwc = new FakeNwcWallet();
    const mint = new FakeMintSource(nwc, "https://mint.a", { proofs: [1], inputFeePpk: 1000 });
    const journal = await runSweep([mint], nwc, new MemoryJournalStore(), fastOptions);
    expect(journal.sources[0].status).toBe("dust");
    expect(journal.status).toBe("completed");
    expect(nwc.makeInvoiceCalls).toBe(0);
    expect(mint.walletSat).toBe(1);
  });

  test("respects minSweepSat", async () => {
    const nwc = new FakeNwcWallet();
    const mint = new FakeMintSource(nwc, "https://mint.a", { proofs: [8, 4] });
    const journal = await runSweep([mint], nwc, new MemoryJournalStore(), { ...fastOptions, minSweepSat: 21 });
    expect(journal.sources[0].status).toBe("dust");
    expect(mint.meltCalls).toBe(0);
  });
});

describe("runSweep: spent and pending proofs", () => {
  test("never feeds proofs the mint reports spent into a melt", async () => {
    const nwc = new FakeNwcWallet();
    const mint = new FakeMintSource(nwc, "https://mint.a", { proofs: [512, 256, 128, 64] });
    mint.markSpent(256); // e.g. spent from another device restored from the same seed
    const journal = await runSweep([mint], nwc, new MemoryJournalStore(), fastOptions);

    expect(journal.status).toBe("completed");
    expect(journal.sources[0].startSpendableSat).toBe(704);
    // The spent 256 is gone at the mint; everything else is accounted for.
    expect(mint.walletSat + nwc.receivedSat + mint.lightningFeesPaidSat).toBe(704);
  });
});

describe("runSweep: failures never lose funds", () => {
  test("melt that never reached the mint leaves proofs untouched and marks the source failed", async () => {
    const nwc = new FakeNwcWallet();
    const mint = new FakeMintSource(nwc, "https://mint.a", { proofs: splitPowersOfTwo(3_000) });
    mint.failMeltBeforeSubmit = true;
    const journal = await runSweep([mint], nwc, new MemoryJournalStore(), fastOptions);

    expect(journal.status).toBe("incomplete");
    expect(journal.sources[0].status).toBe("failed");
    expect(mint.unspentSat).toBe(3_000);
    expect(nwc.receivedSat).toBe(0);
    expect(journalHasUnsettledMelts(journal)).toBe(false);

    // A retry with a healthy mint completes.
    const retried = await runSweep([mint], nwc, new MemoryJournalStore(), { ...fastOptions, journal });
    expect(retried.status).toBe("completed");
    expectConservation(3_000, mint, nwc, retried);
  });

  test("lost melt response is recovered from the quote state and counted once", async () => {
    const nwc = new FakeNwcWallet();
    const mint = new FakeMintSource(nwc, "https://mint.a", { proofs: splitPowersOfTwo(7_777) });
    mint.loseMeltResponse = true;
    const journal = await runSweep([mint], nwc, new MemoryJournalStore(), fastOptions);

    expect(journal.status).toBe("completed");
    expectConservation(7_777, mint, nwc, journal);
    const paid = journal.sources[0].attempts.filter((a) => a.state === "paid");
    expect(paid.length).toBeGreaterThan(0);
    expect(paid[0].verification).toBe("preimage");
  });

  test("lost melt response with the mint unreachable parks the source instead of retrying", async () => {
    const nwc = new FakeNwcWallet();
    const mint = new FakeMintSource(nwc, "https://mint.a", { proofs: splitPowersOfTwo(4_096) });
    mint.loseMeltResponse = true;
    mint.checkUnavailable = true;
    const store = new MemoryJournalStore();
    const journal = await runSweep([mint], nwc, store, fastOptions);

    expect(journal.status).toBe("incomplete");
    expect(journal.sources[0].status).toBe("awaiting_settlement");
    expect(journalHasUnsettledMelts(journal)).toBe(true);
    expect(mint.meltCalls).toBe(1);

    // Mint comes back; resuming from the persisted journal records the payment exactly once.
    mint.checkUnavailable = false;
    const resumed = await runSweep([mint], nwc, store, { ...fastOptions, journal: store.load() });
    expect(resumed.status).toBe("completed");
    expectConservation(4_096, mint, nwc, resumed);
  });

  test("pending lightning payment is not retried and settles on resume", async () => {
    const nwc = new FakeNwcWallet();
    const mint = new FakeMintSource(nwc, "https://mint.a", { proofs: splitPowersOfTwo(20_000) });
    mint.meltGoesPending = true;
    const store = new MemoryJournalStore();
    const first = await runSweep([mint], nwc, store, fastOptions);

    expect(first.sources[0].status).toBe("awaiting_settlement");
    expect(mint.meltCalls).toBe(1);
    expect(nwc.receivedSat).toBe(0);
    // Nothing spendable while inputs are reserved.
    expect(mint.unspentSat).toBe(0);

    // Resuming while still pending must not start another melt.
    const stillPending = await runSweep([mint], nwc, store, { ...fastOptions, journal: store.load() });
    expect(stillPending.sources[0].status).toBe("awaiting_settlement");
    expect(mint.meltCalls).toBe(1);

    mint.meltGoesPending = false;
    mint.finishPayment(mint.pendingQuotes()[0]);
    const done = await runSweep([mint], nwc, store, { ...fastOptions, journal: store.load() });
    expect(done.status).toBe("completed");
    expectConservation(20_000, mint, nwc, done);
  });

  test("pending payment that ultimately fails returns inputs and is re-swept", async () => {
    const nwc = new FakeNwcWallet();
    const mint = new FakeMintSource(nwc, "https://mint.a", { proofs: splitPowersOfTwo(2_500) });
    mint.meltGoesPending = true;
    const store = new MemoryJournalStore();
    await runSweep([mint], nwc, store, fastOptions);

    mint.meltGoesPending = false;
    mint.failPendingPayment(mint.pendingQuotes()[0]);
    const done = await runSweep([mint], nwc, store, { ...fastOptions, journal: store.load() });

    expect(done.status).toBe("completed");
    expect(done.sources[0].attempts.some((a) => a.state === "unpaid")).toBe(true);
    expectConservation(2_500, mint, nwc, done);
  });

  test("mint rejecting the payment keeps every proof", async () => {
    const nwc = new FakeNwcWallet();
    const mint = new FakeMintSource(nwc, "https://mint.a", { proofs: splitPowersOfTwo(9_000) });
    mint.meltFailsUnpaid = true;
    const journal = await runSweep([mint], nwc, new MemoryJournalStore(), fastOptions);
    expect(journal.sources[0].status).toBe("failed");
    expect(mint.unspentSat).toBe(9_000);
    expect(nwc.receivedSat).toBe(0);
  });

  test("one failing mint does not stop the others", async () => {
    const nwc = new FakeNwcWallet();
    const bad = new FakeMintSource(nwc, "https://mint.bad", { proofs: splitPowersOfTwo(1_000) });
    bad.failNextQuote = new Error("mint offline");
    const good = new FakeMintSource(nwc, "https://mint.good", { proofs: splitPowersOfTwo(1_000) });
    const journal = await runSweep([bad, good], nwc, new MemoryJournalStore(), fastOptions);

    expect(journal.status).toBe("incomplete");
    expect(journal.sources[0].status).toBe("failed");
    expect(journal.sources[0].error).toContain("mint offline");
    expect(journal.sources[1].status).toBe("swept");
    expect(bad.unspentSat).toBe(1_000);
  });

  test("NWC wallet failing to create an invoice leaves the mint untouched", async () => {
    const nwc = new FakeNwcWallet();
    nwc.failMakeInvoice = new Error("Timed out waiting for NWC response");
    const mint = new FakeMintSource(nwc, "https://mint.a", { proofs: splitPowersOfTwo(1_500) });
    const journal = await runSweep([mint], nwc, new MemoryJournalStore(), fastOptions);
    expect(journal.sources[0].status).toBe("failed");
    expect(mint.meltCalls).toBe(0);
    expect(mint.unspentSat).toBe(1_500);
  });
});

describe("runSweep: safety guards", () => {
  test("aborts when the NWC invoice amount differs from the requested amount", async () => {
    const nwc = new FakeNwcWallet();
    nwc.amountSkew = 1;
    const mint = new FakeMintSource(nwc, "https://mint.a", { proofs: splitPowersOfTwo(3_000) });
    const journal = await runSweep([mint], nwc, new MemoryJournalStore(), fastOptions);
    expect(journal.sources[0].status).toBe("failed");
    expect(journal.sources[0].error).toMatch(/does not match/);
    expect(mint.meltCalls).toBe(0);
    expect(mint.unspentSat).toBe(3_000);
  });

  test("aborts when the mint quotes a different amount than the invoice", async () => {
    const nwc = new FakeNwcWallet();
    const mint = new FakeMintSource(nwc, "https://mint.a", { proofs: splitPowersOfTwo(3_000) });
    mint.quoteAmountSkew = -5;
    const journal = await runSweep([mint], nwc, new MemoryJournalStore(), fastOptions);
    expect(journal.sources[0].status).toBe("failed");
    expect(mint.meltCalls).toBe(0);
  });

  test("refuses fee reserves above the configured ceiling", async () => {
    const nwc = new FakeNwcWallet();
    const mint = new FakeMintSource(nwc, "https://mint.greedy", {
      proofs: splitPowersOfTwo(10_000),
      feeReserve: (amount) => Math.ceil(amount * 0.2),
    });
    const journal = await runSweep([mint], nwc, new MemoryJournalStore(), fastOptions);
    expect(journal.sources[0].status).toBe("failed");
    expect(journal.sources[0].error).toMatch(/fee reserve/i);
    expect(mint.meltCalls).toBe(0);
    expect(mint.unspentSat).toBe(10_000);
  });

  test("SweepSafetyError is exported for callers to distinguish guard trips", () => {
    expect(new SweepSafetyError("x")).toBeInstanceOf(Error);
  });

  test("verifies via lookup_invoice when the wallet omits payment_hash", async () => {
    const nwc = new FakeNwcWallet();
    nwc.omitPaymentHash = true;
    const mint = new FakeMintSource(nwc, "https://mint.a", { proofs: splitPowersOfTwo(2_000) });
    const journal = await runSweep([mint], nwc, new MemoryJournalStore(), fastOptions);
    const paid = journal.sources[0].attempts.filter((a) => a.state === "paid");
    expect(paid.every((a) => a.verification === "lookup")).toBe(true);
  });

  test("the receiving wallet's confirmation outranks a preimage that doesn't match", async () => {
    const nwc = new FakeNwcWallet();
    const mint = new FakeMintSource(nwc, "https://mint.a", { proofs: splitPowersOfTwo(2_000) });
    const realFinish = mint.finishPayment.bind(mint);
    mint.finishPayment = (quote) => {
      realFinish(quote);
      quote.preimage = randomHex(); // mint reports a bogus preimage
    };
    const journal = await runSweep([mint], nwc, new MemoryJournalStore(), fastOptions);
    const paid = journal.sources[0].attempts.filter((a) => a.state === "paid");
    expect(paid.length).toBeGreaterThan(0);
    expect(paid.every((a) => a.verification === "lookup")).toBe(true);
    expect(summarizeSweepJournal(journal).unconfirmedSat).toBe(0);
  });

  test("reports unconfirmed sats when the preimage mismatches and the wallet can't be asked", async () => {
    const nwc = new FakeNwcWallet();
    nwc.supportsLookup = false;
    const mint = new FakeMintSource(nwc, "https://mint.a", { proofs: splitPowersOfTwo(2_000) });
    const realFinish = mint.finishPayment.bind(mint);
    mint.finishPayment = (quote) => {
      realFinish(quote);
      quote.preimage = randomHex();
    };
    const journal = await runSweep([mint], nwc, new MemoryJournalStore(), fastOptions);
    expect(summarizeSweepJournal(journal).unconfirmedSat).toBe(journal.sources[0].sentSat);
  });

  test("marks payments unverified when neither preimage nor lookup is available", async () => {
    const nwc = new FakeNwcWallet();
    nwc.omitPaymentHash = true;
    nwc.supportsLookup = false;
    const mint = new FakeMintSource(nwc, "https://mint.a", { proofs: splitPowersOfTwo(2_000) });
    const journal = await runSweep([mint], nwc, new MemoryJournalStore(), fastOptions);
    const paid = journal.sources[0].attempts.filter((a) => a.state === "paid");
    expect(paid.length).toBeGreaterThan(0);
    expect(paid.every((a) => a.verification === "unverified")).toBe(true);
  });

  test("the journal is persisted before every melt", async () => {
    const nwc = new FakeNwcWallet();
    const mint = new FakeMintSource(nwc, "https://mint.a", { proofs: splitPowersOfTwo(5_000) });
    const store = new MemoryJournalStore();
    const originalMelt = mint.melt.bind(mint);
    const statesAtMelt: string[] = [];
    mint.melt = async (quote, plan) => {
      const saved = store.load()!;
      const attempt = saved.sources[0].attempts.find((a) => a.quoteId === quote.quoteId);
      statesAtMelt.push(attempt?.state ?? "missing");
      return originalMelt(quote, plan);
    };
    await runSweep([mint], nwc, store, fastOptions);
    expect(statesAtMelt.length).toBeGreaterThan(0);
    expect(statesAtMelt.every((state) => state === "melting")).toBe(true);
  });
});

describe("runSweep: randomized conservation", () => {
  test("never creates or destroys sats across 300 random wallets and fault mixes", async () => {
    const rng = makeRng(0x5eed);
    for (let run = 0; run < 300; run += 1) {
      const nwc = new FakeNwcWallet();
      const proofCount = 1 + Math.floor(rng() * 30);
      const proofs = Array.from({ length: proofCount }, () => 2 ** Math.floor(rng() * 14));
      const start = proofs.reduce((a, b) => a + b, 0);
      const reservePct = rng() * 0.03;
      const reserveMin = Math.floor(rng() * 5);
      const mint = new FakeMintSource(nwc, `https://mint.${run}`, {
        proofs,
        inputFeePpk: rng() < 0.4 ? Math.floor(rng() * 1000) : 0,
        feeReserve: (amount) => Math.max(reserveMin, Math.ceil(amount * reservePct)),
        actualFee: (_amount, reserve) => Math.floor(reserve * rng()),
      });
      const fault = rng();
      if (fault < 0.1) mint.loseMeltResponse = true;
      else if (fault < 0.2) mint.meltFailsUnpaid = true;
      else if (fault < 0.3) mint.failMeltBeforeSubmit = true;
      else if (fault < 0.35) mint.meltGoesPending = true;

      const store = new MemoryJournalStore();
      let journal = await runSweep([mint], nwc, store, { ...fastOptions, maxFeeReserveRatio: 1 });

      // Settle anything left in flight, then resume until the run is final.
      for (let i = 0; i < 3 && journal.status !== "completed"; i += 1) {
        mint.meltGoesPending = false;
        for (const q of mint.pendingQuotes()) mint.finishPayment(q);
        journal = await runSweep([mint], nwc, store, { ...fastOptions, maxFeeReserveRatio: 1, journal: store.load() });
      }

      expect(journal.status, `run ${run}`).toBe("completed");
      expectConservation(start, mint, nwc, journal);
      // Fees never exceed what the mint was allowed to charge.
      const record = journal.sources[0];
      expect(record.feesSat, `run ${run}`).toBe(mint.lightningFeesPaidSat + mint.inputFeesPaidSat);
    }
  });
});
