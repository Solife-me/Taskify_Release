import type { MeltProofsResponse, Proof } from "@cashu/cashu-ts";
import type { MeltQuoteResponse } from "./cashuTypes";
import { kvStorage } from "../storage/kvStorage";
import { LS_NWC_SWEEP_JOURNAL } from "../localStorageKeys";
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
      kvStorage.setItem(key, JSON.stringify(journal));
    },
    clear() {
      kvStorage.removeItem(key);
    },
  };
}
