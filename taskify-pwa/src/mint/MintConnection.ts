import type {
  GetInfoResponse,
  MeltProofsResponse,
  Proof,
  ProofState,
} from "@cashu/cashu-ts";
import { CashuManager, type CreateSendTokenOptions, type SendTokenLockInfo } from "../wallet/CashuManager";
import type { MeltQuoteResponse, MintQuoteResponse } from "../wallet/cashuTypes";
import { assertValidProofsDleq } from "../wallet/dleq";
import { MintRequestCache } from "./MintRequestCache";
import { MintRateLimiter } from "./MintRateLimiter";
import { MintQuoteManager } from "./MintQuoteManager";
import { SwapManager } from "./SwapManager";
import { StateCheckManager } from "./StateCheckManager";
import { PaymentRequestManager } from "./PaymentRequestManager";
import { LockedTokenManager } from "./LockedTokenManager";
import { MintCapabilityStore } from "./MintCapabilityStore";

export type MintConnectionOptions = {
  capabilityStore: MintCapabilityStore;
  getP2PKPrivkey?: (pubkey: string) => string | null;
  onP2PKUsage?: (pubkey: string, count: number) => void;
  requestCache?: MintRequestCache;
  rateLimiter?: MintRateLimiter;
};

export class MintConnection {
  readonly mintUrl: string;
  readonly unit = "sat";
  private readonly manager: CashuManager;
  readonly requestCache: MintRequestCache;
  readonly rateLimiter: MintRateLimiter;
  readonly capabilityStore: MintCapabilityStore;
  readonly quoteManager: MintQuoteManager;
  readonly swapManager: SwapManager;
  readonly stateCheckManager: StateCheckManager;
  readonly paymentRequestManager: PaymentRequestManager;
  readonly lockedTokenManager: LockedTokenManager;
  private initPromise: Promise<void> | null = null;

  constructor(mintUrl: string, options: MintConnectionOptions) {
    this.mintUrl = mintUrl.trim().replace(/\/+$/, "");
    this.capabilityStore = options.capabilityStore;
    this.requestCache = options.requestCache ?? new MintRequestCache();
    this.rateLimiter = options.rateLimiter ?? new MintRateLimiter();
    this.manager = new CashuManager(this.mintUrl, {
      getP2PKPrivkey: options.getP2PKPrivkey,
      onP2PKUsage: options.onP2PKUsage,
    });
    this.quoteManager = new MintQuoteManager(this);
    this.swapManager = new SwapManager(this);
    this.stateCheckManager = new StateCheckManager(this);
    this.paymentRequestManager = new PaymentRequestManager(this);
    this.lockedTokenManager = new LockedTokenManager(this);
  }

  updateHooks(options: { getP2PKPrivkey?: (pubkey: string) => string | null; onP2PKUsage?: (pubkey: string, count: number) => void }) {
    this.manager.updateHooks(options);
  }

  async init() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      await this.manager.init();
      try {
        await this.getMintInfo();
      } catch {
        // mint info caching is best-effort
      }
    })();
    return this.initPromise;
  }

  async runWithRateLimit<T>(key: string, factory: () => Promise<T>, options: { ttlMs?: number; slow?: boolean } = {}): Promise<T> {
    const work = () => this.rateLimiter.schedule(factory, { slow: options.slow });
    if (options.ttlMs === 0) {
      return work();
    }
    return this.requestCache.getOrCreate(key, work, options.ttlMs);
  }

  async getMintInfo(): Promise<GetInfoResponse | null> {
    return this.capabilityStore.get(this.mintUrl, async () => {
      try {
        const res = await this.manager.wallet.getMintInfo();
        return res as GetInfoResponse;
      } catch {
        return (await (this.manager as any).ensureMintInfo?.()) as GetInfoResponse;
      }
    });
  }

  get balance(): number {
    return this.manager.balance;
  }

  get proofs(): Proof[] {
    return this.manager.proofs;
  }

  get wallet() {
    return this.manager.wallet;
  }

  private amountToNumber(value: unknown): number {
    if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    if (typeof value === "bigint") {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
      return Math.max(0, Number(value));
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
    }
    const amountLike = value as { toNumber?: () => number; toNumberUnsafe?: () => number };
    try {
      if (typeof amountLike?.toNumber === "function") {
        const numeric = amountLike.toNumber();
        return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
      }
    } catch {
      // fall through
    }
    try {
      if (typeof amountLike?.toNumberUnsafe === "function") {
        const numeric = amountLike.toNumberUnsafe();
        return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
      }
    } catch {
      // fall through
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
  }

  validateProofsDleq<T extends Proof[]>(proofs: T): T {
    assertValidProofsDleq(proofs, (proof) => {
      const keysetId = typeof proof?.id === "string" ? proof.id : "";
      if (!keysetId) return null;
      const amount = this.amountToNumber((proof as any)?.amount);
      if (!Number.isFinite(amount) || amount <= 0) return null;
      try {
        const keyset = (this.wallet as any).getKeyset?.(keysetId);
        const pubkey = keyset?.keys?.[amount];
        if (typeof pubkey === "string" && pubkey.trim()) return pubkey.trim();
      } catch {
        // fall through
      }
      try {
        const keyset = (this.wallet as any).keyChain?.getKeyset?.(keysetId);
        const pubkey = keyset?.keys?.[amount];
        if (typeof pubkey === "string" && pubkey.trim()) return pubkey.trim();
      } catch {
        return null;
      }
      return null;
    });
    return proofs;
  }

  decodeToken(encoded: string) {
    return this.manager.decodeToken(encoded);
  }

  async createMintQuote(
    payload: { amount: number; description?: string; pubkey?: string; method?: "bolt11" | "bolt12" },
  ): Promise<MintQuoteResponse> {
    await this.init();
    const key = this.requestCache.buildKey(
      "POST",
      `mint-quote-${payload.method ?? "bolt11"}`,
      { amount: payload.amount, description: payload.description ?? "", pubkey: payload.pubkey ?? "" },
    );
    return this.runWithRateLimit(
      key,
      () =>
        this.manager.createMintInvoice(payload.amount, payload.description, {
          pubkey: payload.pubkey,
          method: payload.method,
        }),
      {
        ttlMs: 3000,
      },
    ).then((quote) => {
      this.quoteManager.cacheMintQuote(quote);
      return quote;
    });
  }

  async createMintInvoice(amount: number, description?: string, options?: { pubkey?: string; method?: "bolt11" | "bolt12" }) {
    return this.createMintQuote({ amount, description, pubkey: options?.pubkey, method: options?.method });
  }

  async checkMintQuote(quoteId: string): Promise<MintQuoteResponse> {
    await this.init();
    const key = this.requestCache.buildKey("GET", "mint-quote-status", { quoteId });
    return this.runWithRateLimit(key, () => this.manager.checkMintQuote(quoteId), { ttlMs: 1500, slow: true }).then((quote) => {
      this.quoteManager.cacheMintQuote(quote);
      return quote;
    });
  }

  async claimMint(quoteId: string, amount: number) {
    await this.init();
    const proofs = await this.manager.claimMint(quoteId, amount);
    return this.validateProofsDleq(proofs);
  }

  async receiveToken(encoded: string) {
    await this.init();
    const proofs = await this.manager.receiveToken(encoded);
    return this.validateProofsDleq(proofs);
  }

  async createSendToken(amount: number, options?: CreateSendTokenOptions) {
    await this.init();
    const res = await this.manager.createSendToken(amount, options);
    return {
      ...res,
      keep: this.validateProofsDleq(res.keep),
      send: this.validateProofsDleq(res.send),
    };
  }

  async createTokenFromProofSecrets(secrets: string[]) {
    await this.init();
    return this.manager.createTokenFromProofSecrets(secrets);
  }

  async createMeltQuote(invoice: string): Promise<MeltQuoteResponse> {
    await this.init();
    const key = this.requestCache.buildKey("POST", "melt-quote", { invoice });
    return this.runWithRateLimit(key, () => this.manager.createMeltQuote(invoice), { ttlMs: 2000 }).then((quote) => {
      this.quoteManager.cacheMeltQuote(invoice, quote);
      return quote;
    });
  }

  private buildMeltPaymentRequestId(quote: MeltQuoteResponse): string {
    const request = typeof quote?.request === "string" ? quote.request.trim() : "";
    if (request) return `melt-request:${request}`;

    const quoteId = typeof quote?.quote === "string" ? quote.quote.trim() : "";
    if (quoteId) return `melt-quote:${quoteId}`;

    const amount = typeof quote?.amount === "number" ? quote.amount : 0;
    const feeReserve = typeof quote?.fee_reserve === "number" ? quote.fee_reserve : 0;
    const expiry = typeof quote?.expiry === "number" ? quote.expiry : 0;
    return `melt-anon:${amount}:${feeReserve}:${expiry}`;
  }

  async payMeltQuote(quote: MeltQuoteResponse): Promise<MeltProofsResponse> {
    await this.init();
    const requestId = this.buildMeltPaymentRequestId(quote);
    const res = await this.paymentRequestManager.executeOnce(
      requestId,
      () => this.manager.payMeltQuote(quote),
    );
    if (Array.isArray((res as any)?.change)) {
      (res as any).change = this.validateProofsDleq((res as any).change);
    }
    return res;
  }

  async prepareMultiPathMeltQuote(invoice: string, targetAmount: number) {
    await this.init();
    return this.manager.prepareMultiPathMeltQuote(invoice, targetAmount);
  }

  async supportsBolt11MultiPathPayments() {
    await this.init();
    return this.manager.supportsBolt11MultiPathPayments();
  }

  async checkProofStates(proofs: Proof[]): Promise<ProofState[]> {
    await this.init();
    return this.manager.checkProofStates(proofs);
  }

  async supportsProofStateSubscriptions(): Promise<boolean> {
    await this.init();
    return this.manager.supportsProofStateSubscriptions();
  }

  async subscribeProofStateUpdates(
    proofs: Proof[],
    callback: (payload: ProofState & { proof: Proof }) => void,
    onError: (e: Error) => void,
  ): Promise<() => void> {
    await this.init();
    return this.manager.subscribeProofStateUpdates(proofs, callback, onError);
  }

  async supportsMintQuoteSubscriptions(): Promise<boolean> {
    await this.init();
    return this.manager.supportsMintQuoteSubscriptions();
  }

  async subscribeMintQuoteUpdates(
    quoteIds: string[],
    callback: (quote: MintQuoteResponse) => void,
    onError: (e: Error) => void,
  ): Promise<() => void> {
    await this.init();
    return this.manager.subscribeMintQuoteUpdates(quoteIds, callback, onError);
  }
}

export type { CreateSendTokenOptions, SendTokenLockInfo };
