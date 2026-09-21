import { getEncodedToken, type MeltProofsResponse, type Proof, type ProofState, type Token } from "@cashu/cashu-ts";
import type { MeltQuoteResponse } from "./cashuTypes";
import type { SerializedMeltPreview } from "./storage";
import { kvStorage } from "../storage/kvStorage";
import { LS_NWC_SWEEP_JOURNAL, LS_NWC_TOKEN_SWEEPS } from "../localStorageKeys";
import type {
  SweepDestination,
  SweepJournal,
  SweepJournalStore,
  SweepMeltResult,
  SweepMeltState,
  SweepPlan,
  SweepQuote,
  SweepSource,
} from "./nwcSweep";

/** The subset of MintConnection a full-balance sweep needs. */
export type SweepableMint = {
  readonly mintUrl: string;
  planSweep(): Promise<{ proofs: Proof[]; spendableSat: number; inputFeeSat: number; excludedSat: number }>;
  createMeltQuote(invoice: string): Promise<MeltQuoteResponse>;
  meltProofsForSweep(quote: MeltQuoteResponse, proofs: Proof[]): Promise<MeltProofsResponse>;
  checkMeltQuoteState(quote: MeltQuoteResponse): Promise<MeltQuoteResponse | null>;
};

/** The subset of the NWC context a sweep needs. */
export type SweepableNwc = {
  makeInvoice(amountMsat: number, memo?: string): Promise<{ invoice: string; payment_hash?: string }>;
  lookupInvoice?(ref: { paymentHash?: string | null; invoice?: string }): Promise<{
    preimage?: string | null;
    settled_at?: number | null;
    state?: string;
  }>;
};

export function amountToSat(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  if (typeof value === "bigint") return Math.max(0, Number(value));
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  }
  const amountLike = value as { toNumber?: () => number; toString?: () => string } | null | undefined;
  if (amountLike && typeof amountLike.toNumber === "function") {
    const n = amountLike.toNumber();
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  }
  return 0;
}

export function meltStateOf(quote: { state?: unknown } | null | undefined): SweepMeltState | null {
  const state = typeof quote?.state === "string" ? quote.state.toUpperCase() : "";
  if (state === "PAID" || state === "PENDING" || state === "UNPAID") return state;
  return null;
}

function sumAmounts(list: unknown): number {
  if (!Array.isArray(list)) return 0;
  return list.reduce((sum: number, entry: any) => sum + amountToSat(entry?.amount), 0);
}

export function mintSweepSource(mint: SweepableMint, label?: string): SweepSource {
  const quotes = new Map<string, MeltQuoteResponse>();

  const check = async (quoteId: string): Promise<SweepMeltResult | null> => {
    const known = quotes.get(quoteId) ?? ({ quote: quoteId } as MeltQuoteResponse);
    const status = await mint.checkMeltQuoteState(known);
    const state = meltStateOf(status);
    if (!status || !state) return null;
    return {
      state,
      preimage: typeof status.payment_preimage === "string" ? status.payment_preimage : null,
      // Paid quotes carry the change signatures; their amounts are the change the wallet got back.
      changeSat: state === "PAID" && Array.isArray((status as any).change) ? sumAmounts((status as any).change) : undefined,
    };
  };

  return {
    id: mint.mintUrl,
    label: label ?? mint.mintUrl.replace(/^https?:\/\//, ""),

    async plan(): Promise<SweepPlan> {
      const res = await mint.planSweep();
      return {
        spendableSat: res.spendableSat,
        inputFeeSat: res.inputFeeSat,
        excludedSat: res.excludedSat,
        handle: res.proofs,
      };
    },

    async createMeltQuote(invoice: string): Promise<SweepQuote> {
      const quote = await mint.createMeltQuote(invoice);
      const quoteId = typeof quote?.quote === "string" ? quote.quote : "";
      if (!quoteId) throw new Error("Mint returned a melt quote without an id");
      quotes.set(quoteId, quote);
      return {
        quoteId,
        amountSat: amountToSat(quote.amount),
        feeReserveSat: amountToSat(quote.fee_reserve),
        raw: quote,
      };
    },

    async melt(quote: SweepQuote, plan: SweepPlan): Promise<SweepMeltResult> {
      const raw = (quote.raw as MeltQuoteResponse | undefined) ?? quotes.get(quote.quoteId);
      if (!raw) throw new Error("Unknown melt quote");
      const proofs = Array.isArray(plan.handle) ? (plan.handle as Proof[]) : [];
      const res = await mint.meltProofsForSweep(raw, proofs);
      const state = meltStateOf(res?.quote as MeltQuoteResponse);
      if (!state) {
        // Mint answered without a state; ask again rather than guess.
        const status = await check(quote.quoteId);
        if (!status) throw new Error("Mint did not report the melt outcome");
        return status;
      }
      return {
        state,
        preimage:
          typeof (res.quote as MeltQuoteResponse)?.payment_preimage === "string"
            ? ((res.quote as MeltQuoteResponse).payment_preimage as string)
            : null,
        changeSat: state === "PAID" ? sumAmounts(res.change) : undefined,
      };
    },

    checkMeltQuote: check,
  };
}

export function nwcSweepDestination(nwc: SweepableNwc): SweepDestination {
  const destination: SweepDestination = {
    async makeInvoice(amountSat: number, memo: string) {
      if (!Number.isSafeInteger(amountSat) || amountSat <= 0) throw new Error("Invalid invoice amount");
      const res = await nwc.makeInvoice(amountSat * 1000, memo);
      const invoice = typeof res?.invoice === "string" ? res.invoice.trim() : "";
      if (!invoice) throw new Error("NWC wallet did not return an invoice");
      const paymentHash =
        typeof res.payment_hash === "string" && /^[0-9a-f]{64}$/i.test(res.payment_hash)
          ? res.payment_hash.toLowerCase()
          : null;
      return { invoice, paymentHash };
    },
  };
  if (nwc.lookupInvoice) {
    const lookup = nwc.lookupInvoice.bind(nwc);
    destination.lookupInvoice = async (ref) => {
      const res = await lookup(ref.paymentHash ? { paymentHash: ref.paymentHash } : { invoice: ref.invoice });
      if (!res) return null;
      const state = typeof res.state === "string" ? res.state.toLowerCase() : "";
      const settled = state === "settled" || (typeof res.settled_at === "number" && res.settled_at > 0);
      return { settled, preimage: typeof res.preimage === "string" ? res.preimage : null };
    };
  }
  return destination;
}

/** kvStorage swallows write errors; read back so a failed write aborts before a melt. */
function durableSetItem(key: string, value: string) {
  kvStorage.setItem(key, value);
  if (kvStorage.getItem(key) !== value) {
    throw new Error("Could not save sweep progress to this device's storage");
  }
}

/** Journal persisted synchronously to localStorage so every step is on disk before the next one. */
export function kvSweepJournalStore(key = LS_NWC_SWEEP_JOURNAL): SweepJournalStore & { clear(): void } {
  return {
    load() {
      try {
        const raw = kvStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as SweepJournal;
        return parsed && parsed.version === 1 && Array.isArray(parsed.sources) ? parsed : null;
      } catch {
        return null;
      }
    },
    save(journal: SweepJournal) {
      durableSetItem(key, JSON.stringify(journal));
    },
    clear() {
      kvStorage.removeItem(key);
    },
  };
}

// ---------------------------------------------------------------------------
// Sweeping a stored (unredeemed) token
// ---------------------------------------------------------------------------

/** The subset of MintConnection needed to melt a token's own proofs. */
export type TokenSweepMint = {
  readonly mintUrl: string;
  readonly unit: string;
  decodeTokenWithKeysets(encoded: string): Promise<Token>;
  checkProofStates(proofs: Proof[]): Promise<ProofState[]>;
  inputFeeForProofs(proofs: Proof[]): Promise<number>;
  createMeltQuote(invoice: string): Promise<MeltQuoteResponse>;
  meltForeignProofs(
    quote: MeltQuoteResponse,
    proofs: Proof[],
    persist: (preview: SerializedMeltPreview) => void,
  ): Promise<{ quote: MeltQuoteResponse; change: Proof[] }>;
  rebuildMeltChange(quoteId: string, preview: SerializedMeltPreview): Promise<Proof[] | null>;
  checkMeltQuoteState(quote: MeltQuoteResponse): Promise<MeltQuoteResponse | null>;
};

export type StoredTokenRef = { id: string; mint: string; token: string };

/** Writes that move a token sweep's result into the stored-token list. */
export type TokenSweepLedger = {
  /** Store change as a new token; must be durable before it resolves. */
  addChangeToken(mintUrl: string, token: string, amountSat: number): Promise<void>;
  /** Drop the original token once its proofs are spent by the melt. */
  removeToken(id: string): Promise<void>;
};

/** In-flight token melts, kept so change can be rebuilt after a crash. */
export type TokenSweepRecord = {
  quoteId: string;
  entryId: string;
  mintUrl: string;
  quote: MeltQuoteResponse;
  preview: SerializedMeltPreview;
  createdAt: number;
};

export type TokenSweepRecordStore = {
  get(quoteId: string): TokenSweepRecord | null;
  list(): TokenSweepRecord[];
  put(record: TokenSweepRecord): void;
  remove(quoteId: string): void;
};

export function kvTokenSweepRecordStore(key = LS_NWC_TOKEN_SWEEPS): TokenSweepRecordStore {
  const read = (): Record<string, TokenSweepRecord> => {
    try {
      const raw = kvStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  };
  // Writes throw on failure so a melt is never sent without its record.
  const write = (records: Record<string, TokenSweepRecord>) => durableSetItem(key, JSON.stringify(records));
  return {
    get: (quoteId) => read()[quoteId] ?? null,
    list: () => Object.values(read()),
    put(record) {
      write({ ...read(), [record.quoteId]: record });
    },
    remove(quoteId) {
      const records = read();
      delete records[quoteId];
      write(records);
    },
  };
}

function normalizeMint(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * A SweepSource for one stored token. Its proofs are melted directly — never claimed
 * into the ecash wallet — and any change is stored as a new token.
 */
export function tokenSweepSource(
  entry: StoredTokenRef,
  mint: TokenSweepMint,
  ledger: TokenSweepLedger,
  records: TokenSweepRecordStore,
  label?: string,
): SweepSource {
  const quotes = new Map<string, MeltQuoteResponse>();

  const tokenProofs = async (): Promise<Proof[]> => {
    const decoded = await mint.decodeTokenWithKeysets(entry.token);
    if (decoded.unit && decoded.unit !== mint.unit) throw new Error(`Token unit ${decoded.unit} is not supported`);
    if (normalizeMint(decoded.mint) !== normalizeMint(mint.mintUrl)) throw new Error("Token belongs to a different mint");
    return decoded.proofs as Proof[];
  };

  const finish = async (quoteId: string, change: Proof[]) => {
    const changeSat = sumAmounts(change);
    if (changeSat > 0) {
      const token = getEncodedToken({ mint: mint.mintUrl, proofs: change, unit: mint.unit });
      await ledger.addChangeToken(mint.mintUrl, token, changeSat);
    }
    // Only after change is safely stored: the original token's proofs are now spent.
    await ledger.removeToken(entry.id);
    records.remove(quoteId);
    return changeSat;
  };

  const check = async (quoteId: string): Promise<SweepMeltResult | null> => {
    const record = records.get(quoteId);
    const known = quotes.get(quoteId) ?? record?.quote ?? ({ quote: quoteId } as MeltQuoteResponse);
    const status = await mint.checkMeltQuoteState(known);
    const state = meltStateOf(status);
    if (!status || !state) return null;
    const preimage = typeof status.payment_preimage === "string" ? status.payment_preimage : null;
    if (state === "UNPAID") {
      if (record) records.remove(quoteId);
      return { state, preimage };
    }
    if (state === "PENDING" || !record) return { state, preimage };
    const change = await mint.rebuildMeltChange(quoteId, record.preview);
    if (change === null) return null; // paid, but change not recoverable yet — keep the record
    const changeSat = await finish(quoteId, change);
    return { state, preimage, changeSat };
  };

  return {
    id: `token:${entry.id}`,
    label: label ?? `Token (${mint.mintUrl.replace(/^https?:\/\//, "")})`,

    async plan(): Promise<SweepPlan> {
      const proofs = await tokenProofs();
      if (!proofs.length) return { spendableSat: 0, inputFeeSat: 0, excludedSat: 0, handle: [] };
      const states = await mint.checkProofStates(proofs);
      const spendable = proofs.filter((_, i) => String(states[i]?.state ?? "").toUpperCase() === "UNSPENT");
      return {
        spendableSat: sumAmounts(spendable),
        inputFeeSat: await mint.inputFeeForProofs(spendable),
        excludedSat: sumAmounts(proofs) - sumAmounts(spendable),
        handle: spendable,
      };
    },

    async createMeltQuote(invoice: string): Promise<SweepQuote> {
      const quote = await mint.createMeltQuote(invoice);
      const quoteId = typeof quote?.quote === "string" ? quote.quote : "";
      if (!quoteId) throw new Error("Mint returned a melt quote without an id");
      quotes.set(quoteId, quote);
      return { quoteId, amountSat: amountToSat(quote.amount), feeReserveSat: amountToSat(quote.fee_reserve), raw: quote };
    },

    async melt(quote: SweepQuote, plan: SweepPlan): Promise<SweepMeltResult> {
      const raw = (quote.raw as MeltQuoteResponse | undefined) ?? quotes.get(quote.quoteId);
      if (!raw) throw new Error("Unknown melt quote");
      const proofs = Array.isArray(plan.handle) ? (plan.handle as Proof[]) : [];
      const res = await mint.meltForeignProofs(raw, proofs, (preview) =>
        records.put({
          quoteId: quote.quoteId,
          entryId: entry.id,
          mintUrl: mint.mintUrl,
          quote: raw,
          preview,
          createdAt: Date.now(),
        }),
      );
      const state = meltStateOf(res.quote);
      const preimage = typeof res.quote?.payment_preimage === "string" ? res.quote.payment_preimage : null;
      if (state === "PAID") {
        const changeSat = await finish(quote.quoteId, res.change);
        return { state, preimage, changeSat };
      }
      if (state === "UNPAID") {
        records.remove(quote.quoteId);
        return { state, preimage };
      }
      if (state === "PENDING") return { state, preimage };
      const status = await check(quote.quoteId);
      if (!status) throw new Error("Mint did not report the melt outcome");
      return status;
    },

    checkMeltQuote: check,
  };
}

/**
 * Settles token melts left in flight by a previous session (e.g. the app closed while a
 * payment was pending). Returns the number still unresolved.
 */
export async function resolveOutstandingTokenSweeps(
  records: TokenSweepRecordStore,
  connect: (mintUrl: string) => Promise<TokenSweepMint>,
  ledger: TokenSweepLedger,
): Promise<number> {
  let unresolved = 0;
  for (const record of records.list()) {
    try {
      const mint = await connect(record.mintUrl);
      const source = tokenSweepSource({ id: record.entryId, mint: record.mintUrl, token: "" }, mint, ledger, records);
      const status = await source.checkMeltQuote(record.quoteId);
      if (!status || status.state === "PENDING") unresolved += 1;
    } catch {
      unresolved += 1;
    }
  }
  return unresolved;
}
