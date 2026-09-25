import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/**
 * Moves ecash to a Nostr Wallet Connect (NWC) lightning wallet by melting it into
 * invoices the NWC wallet creates. Used for the one-time migration from the ecash
 * wallet to NWC wallet mode, and for sweeping unredeemed tokens received later.
 *
 * Funds safety rules this engine enforces:
 * - A melt is only started when inputs cover amount + fee reserve + input fees.
 * - The quote amount must equal the invoice amount we asked the NWC wallet for.
 * - The journal is written before every melt so a crash can be resumed; the source
 *   (CashuManager) keeps its own pending-melt record for proof recovery.
 * - A melt whose outcome is unknown or PENDING is never retried with new proofs;
 *   the source is parked as "awaiting_settlement" until the mint reports a final state.
 * - Payment is verified by preimage (sha256(preimage) == payment_hash) and/or the
 *   NWC wallet's lookup_invoice.
 */

export type SweepPlan = {
  /** Sats the source can put into a melt right now (spent/pending proofs excluded). */
  spendableSat: number;
  /** Input fee (NUT-02) the mint charges to spend all spendable proofs. */
  inputFeeSat: number;
  /** Sats held in proofs the mint reported spent or pending; never swept. */
  excludedSat: number;
  /** Opaque data the source needs to melt exactly the planned inputs. */
  handle?: unknown;
};

export type SweepQuote = {
  quoteId: string;
  amountSat: number;
  feeReserveSat: number;
  raw?: unknown;
};

export type SweepMeltState = "PAID" | "PENDING" | "UNPAID";

export type SweepMeltResult = {
  state: SweepMeltState;
  preimage?: string | null;
  /** Ecash change returned by the mint (unused fee reserve and overpaid inputs). */
  changeSat?: number;
};

export interface SweepSource {
  readonly id: string;
  readonly label: string;
  plan(): Promise<SweepPlan>;
  createMeltQuote(invoice: string): Promise<SweepQuote>;
  /** Melts exactly the inputs described by `plan`. */
  melt(quote: SweepQuote, plan: SweepPlan): Promise<SweepMeltResult>;
  /** Returns null when the mint can't be reached or doesn't know the quote. */
  checkMeltQuote(quoteId: string): Promise<SweepMeltResult | null>;
}

export type SweepInvoice = { invoice: string; paymentHash: string | null };

export type SweepInvoiceLookup = { settled: boolean; preimage?: string | null };

export interface SweepDestination {
  makeInvoice(amountSat: number, memo: string): Promise<SweepInvoice>;
  lookupInvoice?(ref: { paymentHash?: string | null; invoice: string }): Promise<SweepInvoiceLookup | null>;
}

export type SweepAttemptState =
  | "invoice" // invoice created, no quote yet
  | "quoted" // quote received, not melted (e.g. abandoned to adjust for fees)
  | "melting" // melt submitted; outcome not yet known
  | "pending" // mint reported PENDING
  | "paid"
  | "unpaid"
  | "error";

export type SweepVerification = "preimage" | "lookup" | "unverified" | "mismatch";

export type SweepAttempt = {
  attemptId: string;
  invoice: string;
  paymentHash: string | null;
  amountSat: number;
  quoteId?: string;
  feeReserveSat?: number;
  inputFeeSat?: number;
  inputSat?: number;
  state: SweepAttemptState;
  note?: string;
  preimage?: string | null;
  changeSat?: number;
  verification?: SweepVerification;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

export type SweepSourceStatus =
  | "pending" // not started
  | "in_progress"
  | "swept" // all passes paid; remainingSat is the last melt's returned fee reserve
  | "dust" // nothing left that can cover an invoice plus fees
  | "awaiting_settlement" // a melt is pending/unknown at the mint
  | "failed";

export type SweepSourceRecord = {
  sourceId: string;
  label: string;
  status: SweepSourceStatus;
  startSpendableSat?: number;
  remainingSat?: number;
  excludedSat?: number;
  sentSat: number;
  feesSat: number;
  attempts: SweepAttempt[];
  error?: string;
};

export type SweepRunStatus = "running" | "completed" | "incomplete";

export type SweepJournal = {
  version: 1;
  runId: string;
  createdAt: number;
  updatedAt: number;
  status: SweepRunStatus;
  sources: SweepSourceRecord[];
};

export interface SweepJournalStore {
  load(): SweepJournal | null;
  save(journal: SweepJournal): void;
}

export type SweepOptions = {
  /** Smallest invoice worth creating. Remaining balances below this are reported as dust. */
  minSweepSat?: number;
  /** Refuse melts whose fee reserve exceeds max(feeReserveFloorSat, amount * maxFeeReserveRatio). */
  maxFeeReserveRatio?: number;
  feeReserveFloorSat?: number;
  /** Invoices tried per pass while converging on an affordable amount. */
  maxQuoteAttempts?: number;
  /** Melts per source (the first melt returns unused fee reserve as change, swept by the next pass). */
  maxPasses?: number;
  /** Polls of lookup_invoice when no preimage was returned. */
  lookupAttempts?: number;
  lookupDelayMs?: number;
  memo?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onUpdate?: (journal: SweepJournal) => void;
};

export class SweepSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SweepSafetyError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const DEFAULTS = {
  minSweepSat: 1,
  maxFeeReserveRatio: 0.05,
  feeReserveFloorSat: 10,
  maxQuoteAttempts: 6,
  maxPasses: 3,
  lookupAttempts: 5,
  lookupDelayMs: 2000,
  memo: "Taskify wallet migration",
};

const ACTIVE_ATTEMPT_STATES: ReadonlySet<SweepAttemptState> = new Set(["melting", "pending"]);
const FINAL_SOURCE_STATUSES: ReadonlySet<SweepSourceStatus> = new Set(["swept", "dust"]);

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "Unknown error");
}

function toSat(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function randomId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** First guess at the lightning fee reserve; corrected from the mint's real quote. */
export function initialFeeReserveGuess(amountSat: number): number {
  return Math.max(2, Math.ceil(amountSat * 0.01));
}

export function preimageMatchesPaymentHash(preimage: string, paymentHash: string): boolean {
  try {
    const cleanPreimage = preimage.trim().toLowerCase();
    const cleanHash = paymentHash.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(cleanPreimage) || !/^[0-9a-f]{64}$/.test(cleanHash)) return false;
    return bytesToHex(sha256(hexToBytes(cleanPreimage))) === cleanHash;
  } catch {
    return false;
  }
}

export function createSweepJournal(sources: Array<Pick<SweepSource, "id" | "label">>, now = Date.now()): SweepJournal {
  return {
    version: 1,
    runId: randomId(),
    createdAt: now,
    updatedAt: now,
    status: "running",
    sources: sources.map((source) => ({
      sourceId: source.id,
      label: source.label,
      status: "pending",
      sentSat: 0,
      feesSat: 0,
      attempts: [],
    })),
  };
}

/** True when the journal has an attempt whose melt outcome isn't final yet. */
export function journalHasUnsettledMelts(journal: SweepJournal | null): boolean {
  if (!journal) return false;
  return journal.sources.some((source) =>
    source.attempts.some((attempt) => ACTIVE_ATTEMPT_STATES.has(attempt.state)),
  );
}

export function summarizeSweepJournal(journal: SweepJournal) {
  let sentSat = 0;
  let feesSat = 0;
  let remainingSat = 0;
  let excludedSat = 0;
  for (const source of journal.sources) {
    sentSat += source.sentSat;
    feesSat += source.feesSat;
    remainingSat += source.remainingSat ?? 0;
    excludedSat += source.excludedSat ?? 0;
  }
  const unconfirmedSat = journal.sources
    .flatMap((source) => source.attempts)
    .filter((attempt) => attempt.state === "paid" && (attempt.verification === "mismatch" || attempt.verification === "unverified"))
    .reduce((sum, attempt) => sum + attempt.amountSat, 0);
  return {
    sentSat,
    feesSat,
    remainingSat,
    excludedSat,
    /** Paid by the mint but not confirmed by the receiving wallet. */
    unconfirmedSat,
    complete: journal.sources.every((source) => FINAL_SOURCE_STATUSES.has(source.status)),
  };
}

class SweepRunner {
  private readonly opts: Required<Omit<SweepOptions, "onUpdate">> & Pick<SweepOptions, "onUpdate">;
  private readonly journal: SweepJournal;
  private readonly store: SweepJournalStore;
  private readonly destination: SweepDestination;

  constructor(journal: SweepJournal, store: SweepJournalStore, destination: SweepDestination, options: SweepOptions) {
    this.journal = journal;
    this.store = store;
    this.destination = destination;
    this.opts = {
      minSweepSat: Math.max(1, toSat(options.minSweepSat ?? DEFAULTS.minSweepSat)),
      maxFeeReserveRatio: options.maxFeeReserveRatio ?? DEFAULTS.maxFeeReserveRatio,
      feeReserveFloorSat: options.feeReserveFloorSat ?? DEFAULTS.feeReserveFloorSat,
      maxQuoteAttempts: Math.max(1, options.maxQuoteAttempts ?? DEFAULTS.maxQuoteAttempts),
      maxPasses: Math.max(1, options.maxPasses ?? DEFAULTS.maxPasses),
      lookupAttempts: Math.max(0, options.lookupAttempts ?? DEFAULTS.lookupAttempts),
      lookupDelayMs: Math.max(0, options.lookupDelayMs ?? DEFAULTS.lookupDelayMs),
      memo: options.memo ?? DEFAULTS.memo,
      now: options.now ?? (() => Date.now()),
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      onUpdate: options.onUpdate,
    };
  }

  private persist() {
    this.journal.updatedAt = this.opts.now();
    this.store.save(this.journal);
    this.opts.onUpdate?.(this.journal);
  }

  private record(sourceId: string): SweepSourceRecord {
    let record = this.journal.sources.find((entry) => entry.sourceId === sourceId);
    if (!record) {
      record = { sourceId, label: sourceId, status: "pending", sentSat: 0, feesSat: 0, attempts: [] };
      this.journal.sources.push(record);
    }
    return record;
  }

  private update(attempt: SweepAttempt, patch: Partial<SweepAttempt>) {
    Object.assign(attempt, patch, { updatedAt: this.opts.now() });
    this.persist();
  }

  private feeReserveAllowed(amountSat: number, feeReserveSat: number): boolean {
    const allowed = Math.max(this.opts.feeReserveFloorSat, Math.ceil(amountSat * this.opts.maxFeeReserveRatio));
    return feeReserveSat <= allowed;
  }

  async run(sources: SweepSource[]): Promise<SweepJournal> {
    this.journal.status = "running";
    this.persist();
    for (const source of sources) {
      const record = this.record(source.id);
      record.label = source.label;
      if (FINAL_SOURCE_STATUSES.has(record.status)) continue;
      try {
        await this.sweepSource(source, record);
      } catch (error) {
        record.status = "failed";
        record.error = errorMessage(error);
        this.persist();
      }
    }
    const allFinal = this.journal.sources.every((record) => FINAL_SOURCE_STATUSES.has(record.status));
    this.journal.status = allFinal ? "completed" : "incomplete";
    this.persist();
    return this.journal;
  }

  /** Resolves melts left unsettled by an earlier run. Returns false if any is still unresolved. */
  private async settleOutstanding(source: SweepSource, record: SweepSourceRecord): Promise<boolean> {
    let settled = true;
    for (const attempt of record.attempts) {
      if (!ACTIVE_ATTEMPT_STATES.has(attempt.state)) continue;
      if (!attempt.quoteId) {
        this.update(attempt, { state: "error", error: "Melt started without a quote id" });
        continue;
      }
      const status = await source.checkMeltQuote(attempt.quoteId).catch(() => null);
      if (!status) {
        settled = false;
        continue;
      }
      if (status.state === "PENDING") {
        if (attempt.state !== "pending") this.update(attempt, { state: "pending" });
        settled = false;
        continue;
      }
      if (status.state === "UNPAID") {
        this.update(attempt, { state: "unpaid", note: "Mint reported the melt unpaid; inputs were returned" });
        continue;
      }
      await this.completePaidAttempt(record, attempt, status);
    }
    return settled;
  }

  private async completePaidAttempt(record: SweepSourceRecord, attempt: SweepAttempt, result: SweepMeltResult) {
    const changeSat = result.changeSat !== undefined ? toSat(result.changeSat) : undefined;
    const inputSat = attempt.inputSat ?? 0;
    const feeSat =
      changeSat !== undefined && inputSat > 0
        ? Math.max(0, inputSat - attempt.amountSat - changeSat)
        : Math.max(0, (attempt.feeReserveSat ?? 0) + (attempt.inputFeeSat ?? 0));
    this.update(attempt, { state: "paid", preimage: result.preimage ?? attempt.preimage ?? null, changeSat });
    record.sentSat += attempt.amountSat;
    record.feesSat += feeSat;
    this.persist();
    await this.verify(attempt);
  }

  private async verify(attempt: SweepAttempt) {
    const preimage = attempt.preimage?.trim();
    if (preimage && attempt.paymentHash) {
      const matches = preimageMatchesPaymentHash(preimage, attempt.paymentHash);
      this.update(attempt, { verification: matches ? "preimage" : "mismatch" });
      if (matches) return;
    }
    const lookup = this.destination.lookupInvoice?.bind(this.destination);
    if (!lookup) {
      if (!attempt.verification) this.update(attempt, { verification: "unverified" });
      return;
    }
    for (let i = 0; i < this.opts.lookupAttempts; i += 1) {
      const res = await lookup({ paymentHash: attempt.paymentHash, invoice: attempt.invoice }).catch(() => null);
      if (res?.settled) {
        // The receiving wallet's own confirmation outranks a preimage that didn't match.
        this.update(attempt, { verification: "lookup" });
        return;
      }
      if (i < this.opts.lookupAttempts - 1) await this.opts.sleep(this.opts.lookupDelayMs);
    }
    if (!attempt.verification) this.update(attempt, { verification: "unverified" });
  }

  private async sweepSource(source: SweepSource, record: SweepSourceRecord) {
    record.status = "in_progress";
    record.error = undefined;
    this.persist();

    if (!(await this.settleOutstanding(source, record))) {
      record.status = "awaiting_settlement";
      this.persist();
      return;
    }

    for (let pass = 0; pass < this.opts.maxPasses; pass += 1) {
      const plan = await source.plan();
      const spendable = toSat(plan.spendableSat);
      const inputFee = toSat(plan.inputFeeSat);
      if (record.startSpendableSat === undefined) record.startSpendableSat = spendable;
      record.remainingSat = spendable;
      record.excludedSat = toSat(plan.excludedSat);
      this.persist();

      const outcome = await this.meltOnce(source, record, plan, spendable, inputFee);
      if (outcome === "dust") {
        record.status = record.sentSat > 0 ? "swept" : "dust";
        this.persist();
        return;
      }
      if (outcome === "unsettled") {
        record.status = "awaiting_settlement";
        this.persist();
        return;
      }
    }

    // Every pass paid. What remains is the last melt's returned fee reserve, which stays
    // in the ecash wallet (reported via remainingSat) rather than paying another reserve.
    const finalPlan = await source.plan();
    record.remainingSat = toSat(finalPlan.spendableSat);
    record.excludedSat = toSat(finalPlan.excludedSat);
    record.status = "swept";
    this.persist();
  }

  /** One melt of everything spendable. */
  private async meltOnce(
    source: SweepSource,
    record: SweepSourceRecord,
    plan: SweepPlan,
    spendable: number,
    inputFee: number,
  ): Promise<"paid" | "dust" | "unsettled"> {
    const budget = spendable - inputFee;
    if (budget < this.opts.minSweepSat) return "dust";

    const tried = new Set<number>();
    let target = budget - initialFeeReserveGuess(budget);
    let bestAffordable: { target: number; attempt: SweepAttempt; quote: SweepQuote } | null = null;

    for (let i = 0; i < this.opts.maxQuoteAttempts; i += 1) {
      target = Math.floor(target);
      if (target < this.opts.minSweepSat) {
        if (bestAffordable) break;
        return "dust";
      }
      if (tried.has(target)) break;
      tried.add(target);

      const invoice = await this.destination.makeInvoice(target, this.opts.memo);
      const now = this.opts.now();
      const attempt: SweepAttempt = {
        attemptId: randomId(),
        invoice: invoice.invoice,
        paymentHash: invoice.paymentHash,
        amountSat: target,
        inputFeeSat: inputFee,
        inputSat: spendable,
        state: "invoice",
        createdAt: now,
        updatedAt: now,
      };
      record.attempts.push(attempt);
      this.persist();

      let quote: SweepQuote;
      try {
        quote = await source.createMeltQuote(invoice.invoice);
      } catch (error) {
        this.update(attempt, { state: "error", error: errorMessage(error) });
        throw error;
      }
      const quoteAmount = toSat(quote.amountSat);
      const feeReserve = toSat(quote.feeReserveSat);
      this.update(attempt, { state: "quoted", quoteId: quote.quoteId, feeReserveSat: feeReserve });
      if (quoteAmount !== target) {
        this.update(attempt, { state: "error", error: `Mint quoted ${quoteAmount} sats for a ${target} sat invoice` });
        throw new SweepSafetyError(
          `Melt quote amount (${quoteAmount}) does not match the NWC invoice amount (${target}); aborting`,
        );
      }

      const affordableTarget = budget - feeReserve;
      if (target <= affordableTarget) {
        if (!bestAffordable || target > bestAffordable.target) {
          bestAffordable = { target, attempt, quote };
        }
        // Slack returns as change anyway, but try once more for a tighter fit.
        if (target === affordableTarget || tried.has(affordableTarget)) break;
        target = affordableTarget;
        continue;
      }
      this.update(attempt, { note: `Needs ${target + feeReserve + inputFee} sats; ${spendable} available` });
      target = Math.min(affordableTarget, target - 1);
    }

    if (!bestAffordable) {
      throw new Error("Could not find an amount that covers the mint's lightning fee reserve");
    }

    const { attempt, quote } = bestAffordable;
    for (const other of record.attempts) {
      if (other !== attempt && (other.state === "quoted" || other.state === "invoice")) {
        if (!other.note) other.note = "Superseded by a better-fitting invoice";
      }
    }
    if (!this.feeReserveAllowed(attempt.amountSat, toSat(quote.feeReserveSat))) {
      throw new SweepSafetyError(
        `Lightning fee reserve of ${quote.feeReserveSat} sats is too high for a ${attempt.amountSat} sat transfer`,
      );
    }

    this.update(attempt, { state: "melting" });
    let result: SweepMeltResult | null;
    try {
      result = await source.melt(quote, plan);
    } catch (error) {
      result = await source.checkMeltQuote(quote.quoteId).catch(() => null);
      if (!result) {
        // Outcome unknown: the source keeps the inputs reserved until the mint answers.
        this.update(attempt, { error: errorMessage(error) });
        return "unsettled";
      }
      if (result.state === "UNPAID") {
        this.update(attempt, { state: "unpaid", error: errorMessage(error) });
        throw error;
      }
    }

    if (result.state === "PENDING") {
      this.update(attempt, { state: "pending" });
      return "unsettled";
    }
    if (result.state === "UNPAID") {
      this.update(attempt, { state: "unpaid" });
      throw new Error("Mint did not pay the NWC invoice");
    }
    await this.completePaidAttempt(record, attempt, result);
    return "paid";
  }
}

/**
 * Sweeps every source to the destination, one at a time. Pass an existing journal
 * (from the store) to resume an interrupted run; sources already swept are skipped.
 */
export async function runSweep(
  sources: SweepSource[],
  destination: SweepDestination,
  store: SweepJournalStore,
  options: SweepOptions & { journal?: SweepJournal | null } = {},
): Promise<SweepJournal> {
  const journal = options.journal ?? createSweepJournal(sources, (options.now ?? Date.now)());
  const runner = new SweepRunner(journal, store, destination, options);
  return runner.run(sources);
}
