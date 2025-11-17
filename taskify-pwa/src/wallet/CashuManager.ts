import * as Cashu from "@cashu/cashu-ts";
import {
  getDecodedToken,
  getEncodedToken,
  type MeltBlanks,
  type MeltProofsResponse,
  type MeltQuoteResponse,
  type MintQuoteResponse,
  type OutputConfig,
  type P2PKOptions,
  type Proof,
  type ProofState,
  type Secret,
  type Wallet,
} from "@cashu/cashu-ts";
import { getProofs, setProofs } from "./storage";
import {
  getWalletSeedBytes,
  getWalletCounterInit,
  persistWalletCounter,
  persistWalletCounterSnapshot,
} from "./seed";

export type MintQuoteState = "UNPAID" | "PAID" | "ISSUED";

export type P2PKLockOptions = P2PKOptions & { pubkey: string | string[] };

export type CreateSendTokenOptions = {
  p2pk?: P2PKLockOptions;
};

export type SendTokenLockInfo =
  | { type: "p2pk"; options: P2PKLockOptions }
  | undefined;

type CashuManagerOptions = {
  getP2PKPrivkey?: (pubkey: string) => string | null;
  onP2PKUsage?: (pubkey: string, count: number) => void;
};

const CashuAny = Cashu as Record<string, any>;
const MintCtor = CashuAny.Mint ?? CashuAny.CashuMint;
const WalletCtor = CashuAny.Wallet ?? CashuAny.CashuWallet;

if (!MintCtor || !WalletCtor) {
  throw new Error("Unsupported @cashu/cashu-ts version: missing Mint/Wallet exports");
}

export class CashuManager {
  readonly mintUrl: string;
  wallet!: Wallet;
  unit = "sat";
  private readonly getP2PKPrivkey?: (pubkey: string) => string | null;
  private readonly onP2PKUsage?: (pubkey: string, count: number) => void;
  private proofCache: Proof[] = [];
  private pendingMeltBlanks = new Map<string, MeltBlanks>();

  constructor(mintUrl: string, options?: CashuManagerOptions) {
    this.mintUrl = mintUrl.replace(/\/$/, "");
    this.getP2PKPrivkey = options?.getP2PKPrivkey;
    this.onP2PKUsage = options?.onP2PKUsage;
  }

  private static extractQuoteKey(quote?: { quote?: string } | null): string | null {
    if (!quote || typeof quote.quote !== "string") return null;
    const key = quote.quote.trim();
    return key ? key : null;
  }

  private rememberMeltBlanks(blanks: MeltBlanks | null | undefined): string | null {
    const key = CashuManager.extractQuoteKey(blanks?.quote);
    if (!key) return null;
    if (blanks) {
      this.pendingMeltBlanks.set(key, blanks);
    } else {
      this.pendingMeltBlanks.delete(key);
    }
    return key;
  }

  private clearMeltBlanksByQuote(target: MeltQuoteResponse | string | null | undefined) {
    if (!target) return;
    const key =
      typeof target === "string"
        ? target.trim()
        : CashuManager.extractQuoteKey(typeof target === "object" ? target : null);
    if (key) {
      this.pendingMeltBlanks.delete(key);
    }
  }

  private getStoredMeltBlanks(target: MeltQuoteResponse | string | null | undefined): MeltBlanks | null {
    if (!target) return null;
    const key =
      typeof target === "string"
        ? target.trim()
        : CashuManager.extractQuoteKey(typeof target === "object" ? target : null);
    if (!key) return null;
    return this.pendingMeltBlanks.get(key) ?? null;
  }

  private async finalizeStoredMeltChange(
    target: MeltQuoteResponse | string | null | undefined,
  ): Promise<Proof[] | null> {
    const blanks = this.getStoredMeltBlanks(target);
    if (!blanks) return null;
    try {
      const completion = await this.wallet.completeMelt(blanks);
      const change = Array.isArray(completion?.change) ? completion.change : [];
      if (!change.length) {
        this.clearMeltBlanksByQuote(target);
        return [];
      }
      const signedChange = this.autoSignProofs(change);
      this.mergeProofs(signedChange);
      this.clearMeltBlanksByQuote(target);
      return signedChange;
    } catch (error) {
      console.warn("CashuManager: failed to finalize melt change", error);
      return null;
    }
  }

  private static parseP2PKSecretString(secret: string): Secret | null {
    if (!secret || typeof secret !== "string") return null;
    try {
      const parsed = JSON.parse(secret);
      if (
        Array.isArray(parsed) &&
        parsed.length === 2 &&
        typeof parsed[0] === "string" &&
        typeof parsed[1] === "object" &&
        parsed[1] !== null
      ) {
        return parsed as Secret;
      }
    } catch {
      return null;
    }
    return null;
  }

  private static normalizePubkeyHex(value?: string | null): string | null {
    if (!value) return null;
    const hex = value.trim().toLowerCase();
    if (/^(02|03)[0-9a-f]{64}$/.test(hex)) return hex;
    if (/^[0-9a-f]{64}$/.test(hex)) return `02${hex}`;
    if (/^04[0-9a-f]{128}$/.test(hex)) return `02${hex.slice(2, 66)}`;
    return null;
  }

  private static proofKey(proof: Proof): string {
    return `${proof.secret ?? ""}|${proof.C ?? ""}|${proof.id ?? ""}|${proof.amount ?? 0}`;
  }

  private extractProofPubkeys(proof: Proof): string[] {
    const secret = typeof proof.secret === "string" ? proof.secret : "";
    if (!secret) return [];
    try {
      const parsed = CashuManager.parseP2PKSecretString(secret);
      if (!parsed) return [];
      const [, data] = parsed;
      if (!data) return [];
      const keys = new Set<string>();
      const addKey = (value?: string) => {
        const normalized = CashuManager.normalizePubkeyHex(value);
        if (normalized) keys.add(normalized);
      };
      addKey(data.data);
      if (Array.isArray(data.tags)) {
        for (const tag of data.tags) {
          if (!Array.isArray(tag) || tag.length < 2) continue;
          const [tagName, ...values] = tag;
          if (tagName === "pubkeys" || tagName === "refund") {
            values.forEach((value) => addKey(value));
          }
        }
      }
      return [...keys];
    } catch {
      return [];
    }
  }

  private autoSignProofs(proofs: Proof[]): Proof[] {
    if (!Array.isArray(proofs) || proofs.length === 0 || !this.wallet) return proofs;
    if (!this.getP2PKPrivkey) return proofs;
    const replacements = new Map<string, Proof>();
    const grouped = new Map<string, { privkey: string; proofs: Proof[] }>();
    for (const proof of proofs) {
      const candidateKeys = this.extractProofPubkeys(proof);
      let resolved: { pubkey: string; privkey: string } | null = null;
      for (const candidate of candidateKeys) {
        if (!candidate) continue;
        try {
          const privkey = this.getP2PKPrivkey(candidate);
          if (privkey && /^[0-9a-f]{64}$/i.test(privkey.trim())) {
            resolved = { pubkey: candidate, privkey: privkey.trim().toLowerCase() };
            break;
          }
        } catch {
          // ignore resolver errors
        }
      }
      if (!resolved) continue;
      const bucket = grouped.get(resolved.pubkey);
      if (bucket) {
        bucket.proofs.push(proof);
      } else {
        grouped.set(resolved.pubkey, { privkey: resolved.privkey, proofs: [proof] });
      }
    }
    if (!grouped.size) return proofs;
    grouped.forEach((payload, pubkey) => {
      try {
        const signed = this.wallet.signP2PKProofs(payload.proofs, payload.privkey);
        for (const proof of signed) {
          replacements.set(CashuManager.proofKey(proof), proof);
        }
        if (this.onP2PKUsage) this.onP2PKUsage(pubkey, payload.proofs.length);
      } catch (error) {
        console.warn("CashuManager: failed to auto-sign P2PK proofs", error);
      }
    });
    if (!replacements.size) return proofs;
    return proofs.map((proof) => replacements.get(CashuManager.proofKey(proof)) ?? proof);
  }

  private resolvePrivkeysFromProofs(proofs: Proof[]): Map<string, { privkey: string; count: number }> {
    const result = new Map<string, { privkey: string; count: number }>();
    if (!this.getP2PKPrivkey) return result;
    for (const proof of proofs) {
      const candidates = this.extractProofPubkeys(proof);
      for (const candidate of candidates) {
        if (!candidate) continue;
        let privkey: string | null = null;
        try {
          privkey = this.getP2PKPrivkey(candidate);
        } catch {
          privkey = null;
        }
        if (privkey && /^[0-9a-f]{64}$/i.test(privkey.trim())) {
          const normalized = privkey.trim().toLowerCase();
          const existing = result.get(candidate);
          if (existing) {
            existing.count += 1;
          } else {
            result.set(candidate, { privkey: normalized, count: 1 });
          }
          break;
        }
      }
    }
    return result;
  }

  private resolvePrivkeysForToken(encoded: string): Map<string, { privkey: string; count: number }> {
    if (!this.getP2PKPrivkey) return new Map();
    try {
      const decoded: any = getDecodedToken(encoded);
      const entries = Array.isArray(decoded?.token) ? decoded.token : decoded ? [decoded] : [];
      const proofs = entries.flatMap((entry: any) =>
        Array.isArray(entry?.proofs) ? (entry.proofs as Proof[]) : [],
      );
      return this.resolvePrivkeysFromProofs(proofs);
    } catch {
      return new Map();
    }
  }

  private async ensureMintInfo() {
    const walletAny = this.wallet as unknown as {
      lazyGetMintInfo?: () => Promise<any>;
      getMintInfo?: () => Promise<any>;
    } | null;
    if (!walletAny) return null;
    if (typeof walletAny.lazyGetMintInfo === "function") {
      try {
        return await walletAny.lazyGetMintInfo();
      } catch {
        // fall back to getMintInfo below
      }
    }
    if (typeof walletAny.getMintInfo === "function") {
      return walletAny.getMintInfo();
    }
    return null;
  }

  async init() {
    const mint = new MintCtor(this.mintUrl);
    const seed = getWalletSeedBytes();
    const counterInit = getWalletCounterInit(this.mintUrl);
    const options: Record<string, any> = { unit: this.unit };
    if (seed?.length) {
      options.bip39seed = seed;
      if (counterInit && Object.keys(counterInit).length > 0) {
        options.counterInit = counterInit;
      }
    }
    this.wallet = new WalletCtor(mint, options) as Wallet;
    await this.wallet.loadMint();
    const existing = getProofs(this.mintUrl);
    this.proofCache = Array.isArray(existing) ? [...existing] : [];
    if (options.bip39seed) {
      try {
        const snapshot = await this.wallet.counters.snapshot();
        if (snapshot && typeof snapshot === "object") {
          persistWalletCounterSnapshot(this.mintUrl, snapshot as Record<string, number>);
        }
      } catch {
        // counter source may not support snapshot; ignore
      }
      this.wallet.on.countersReserved(({ keysetId, next }) => {
        try {
          persistWalletCounter(this.mintUrl, keysetId, next);
        } catch (error) {
          console.warn("CashuManager: failed to persist counter", error);
        }
      });
    }
  }

  get proofs(): Proof[] {
    return [...this.proofCache];
  }

  private persistProofs(proofs: Proof[]) {
    const sanitized = Array.isArray(proofs)
      ? proofs.filter((proof): proof is Proof => !!proof && typeof proof === "object")
      : [];
    this.proofCache = sanitized;
    setProofs(this.mintUrl, sanitized);
  }

  private removeProofsBySecrets(secrets: Set<string>) {
    if (!secrets.size) return;
    const filtered = this.proofCache.filter((proof) => !secrets.has(proof?.secret ?? ""));
    if (filtered.length === this.proofCache.length) return;
    this.persistProofs(filtered);
  }

  private mergeProofs(proofs: Proof[]) {
    if (!Array.isArray(proofs) || proofs.length === 0) return;
    const merged = [...this.proofCache, ...proofs];
    const seen = new Set<string>();
    const deduped: Proof[] = [];
    for (const proof of merged) {
      if (!proof || typeof proof !== "object") continue;
      const key = proof.secret ? `secret:${proof.secret}` : `key:${CashuManager.proofKey(proof)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(proof);
    }
    this.persistProofs(deduped);
  }

  private selectProofsForAmount(amount: number, includeFees = false): Proof[] {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Amount must be greater than zero");
    }
    const target = Math.floor(amount);
    if (this.balance < target) {
      throw new Error("Insufficient balance");
    }
    const walletAny = this.wallet as Wallet & {
      selectProofsToSend?: (
        proofs: Proof[],
        amountToSend: number,
        includeFees?: boolean,
        exactMatch?: boolean,
      ) => { send?: Proof[] };
    };
    if (typeof walletAny?.selectProofsToSend === "function") {
      try {
        const selection = walletAny.selectProofsToSend([...this.proofCache], target, includeFees, true);
        if (selection?.send?.length) {
          return selection.send;
        }
      } catch (error) {
        console.warn("CashuManager: proof pre-selection failed, falling back to greedy selection", error);
      }
    }
    const sorted = [...this.proofCache].sort((a, b) => (b?.amount || 0) - (a?.amount || 0));
    const picked: Proof[] = [];
    let runningTotal = 0;
    for (const proof of sorted) {
      if (!proof || typeof proof.amount !== "number" || proof.amount <= 0) continue;
      picked.push(proof);
      runningTotal += proof.amount;
      if (runningTotal >= target) break;
    }
    if (runningTotal < target) {
      throw new Error("Insufficient balance");
    }
    return picked;
  }

  private persistAfterSpend(consumed: Proof[], kept: Proof[]) {
    if (!Array.isArray(consumed) || !consumed.length) {
      this.persistProofs([...this.proofCache, ...kept]);
      return;
    }
    const consumedKeys = new Set<string>();
    for (const proof of consumed) {
      if (!proof) continue;
      const key = proof.secret ? `secret:${proof.secret}` : `key:${CashuManager.proofKey(proof)}`;
      consumedKeys.add(key);
    }
    const survivors = this.proofCache.filter((proof) => {
      if (!proof) return false;
      const key = proof.secret ? `secret:${proof.secret}` : `key:${CashuManager.proofKey(proof)}`;
      return !consumedKeys.has(key);
    });
    this.persistProofs([...survivors, ...kept]);
  }

  get balance(): number {
    return this.proofCache.reduce((a, p) => a + (p?.amount || 0), 0);
  }

  async createMintInvoice(amount: number, description?: string) {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Amount must be greater than zero");
    }
    const normalizedAmount = Math.floor(amount);
    const walletAny = this.wallet as Wallet & {
      createMintQuoteBolt11?: (amount: number, description?: string) => Promise<MintQuoteResponse>;
    };
    if (typeof walletAny?.createMintQuoteBolt11 === "function") {
      return walletAny.createMintQuoteBolt11(normalizedAmount, description);
    }
    return this.wallet.createMintQuote(normalizedAmount, description);
  }

  async checkMintQuote(quoteOrId: string | MintQuoteResponse): Promise<MintQuoteResponse> {
    // normalize to id
    const res = await (typeof quoteOrId === "string"
      ? this.wallet.checkMintQuote(quoteOrId)
      : this.wallet.checkMintQuote(quoteOrId.quote));
    // Type narrowing: ensure amount/unit exist (MintQuoteResponse) by probing wallet.getMintInfo if needed
    const info = await this.ensureMintInfo();
    return {
      amount: (res as any).amount ?? 0,
      unit: (res as any).unit ?? info?.unit ?? this.unit,
      request: res.request,
      quote: res.quote,
      state: res.state as MintQuoteState,
      expiry: res.expiry,
      pubkey: (res as any).pubkey,
    } as MintQuoteResponse;
  }

  async claimMint(quoteId: string, amount: number) {
    const config: Record<string, any> = { proofsWeHave: [...this.proofCache] };
    const proofs = await this.wallet.mintProofs(amount, quoteId, config);
    const signed = this.autoSignProofs(proofs);
    this.mergeProofs(signed);
    return signed;
  }

  async receiveToken(encoded: string) {
    const privkeyMap = this.resolvePrivkeysForToken(encoded);
    const privkeyValues = [...privkeyMap.values()].map((entry) => entry.privkey);
    const receiveConfig: Record<string, any> = { proofsWeHave: [...this.proofCache] };
    if (privkeyValues.length === 1) {
      receiveConfig.privkey = privkeyValues[0];
    } else if (privkeyValues.length > 1) {
      receiveConfig.privkey = privkeyValues;
    }
    const newProofs = await this.wallet.receive(encoded, receiveConfig);
    const signed = this.autoSignProofs(newProofs);
    this.mergeProofs(signed);
    privkeyMap.forEach((entry, pubkey) => {
      if (entry.count > 0) this.onP2PKUsage?.(pubkey, entry.count);
    });
    return signed;
  }

  async createTokenFromProofSecrets(
    secrets: string[],
  ): Promise<{ token: string; send: Proof[]; keep: Proof[]; lockInfo: SendTokenLockInfo }> {
    if (!Array.isArray(secrets) || secrets.length === 0) {
      throw new Error("Select at least one note");
    }
    const requested = new Set<string>();
    for (const secret of secrets) {
      if (typeof secret === "string" && secret.trim()) {
        requested.add(secret.trim());
      }
    }
    if (!requested.size) {
      throw new Error("Select at least one note");
    }
    const selected: Proof[] = [];
    const keep: Proof[] = [];
    for (const proof of this.proofCache) {
      const secret = typeof proof?.secret === "string" ? proof.secret : "";
      if (secret && requested.has(secret)) {
        selected.push(proof);
        requested.delete(secret);
      } else {
        keep.push(proof);
      }
    }
    if (requested.size) {
      throw new Error("Some selected notes are no longer available");
    }
    if (!selected.length) {
      throw new Error("Select at least one note");
    }
    this.persistProofs(keep);
    const token = getEncodedToken({ mint: this.mintUrl, proofs: selected, unit: this.unit });
    return { token, send: selected, keep, lockInfo: undefined };
  }

  async createSendToken(
    amount: number,
    options?: CreateSendTokenOptions,
  ): Promise<{ token: string; send: Proof[]; keep: Proof[]; lockInfo: SendTokenLockInfo }> {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Amount must be greater than zero");
    }
    if (!options?.p2pk) {
      const exactSubset = this.findExactProofSubset(amount);
      if (exactSubset) {
        const token = getEncodedToken({ mint: this.mintUrl, proofs: exactSubset, unit: this.unit });
        this.persistAfterSpend(exactSubset, []);
        return { token, send: exactSubset, keep: [], lockInfo: undefined };
      }
    }
    const selected = this.selectProofsForAmount(amount, !!options?.p2pk);
    let outputConfig: OutputConfig | undefined;
    if (options?.p2pk) {
      const pubkey = options.p2pk.pubkey;
      if (!pubkey || (Array.isArray(pubkey) && pubkey.length === 0)) {
        throw new Error("Missing public key for P2PK lock");
      }
      outputConfig = {
        send: {
          type: "p2pk",
          options: options.p2pk,
        },
      } satisfies OutputConfig;
    }
    const { keep, send } = await this.wallet.send(amount, selected, { proofsWeHave: [...this.proofCache] }, outputConfig);
    this.persistAfterSpend(selected, keep);
    const token = getEncodedToken({ mint: this.mintUrl, proofs: send, unit: this.unit });
    const lockInfo: SendTokenLockInfo = options?.p2pk ? { type: "p2pk", options: options.p2pk } : undefined;
    return { token, send, keep, lockInfo };
  }

  private findExactProofSubset(amount: number): Proof[] | null {
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const target = Math.floor(amount);
    if (target <= 0) return null;
    const pathMap = new Map<number, { prevSum: number; proofIndex: number } | null>();
    pathMap.set(0, null);
    this.proofCache.forEach((proof, proofIndex) => {
      const normalizedAmount = Math.floor(proof?.amount ?? 0);
      if (!proof || normalizedAmount <= 0) return;
      const existingSums = Array.from(pathMap.keys()).sort((a, b) => b - a);
      for (const sum of existingSums) {
        const nextSum = sum + normalizedAmount;
        if (nextSum > target || pathMap.has(nextSum)) continue;
        pathMap.set(nextSum, { prevSum: sum, proofIndex });
      }
    });
    if (!pathMap.has(target)) return null;
    const selection: Proof[] = [];
    const used = new Set<number>();
    let current = target;
    while (current > 0) {
      const entry = pathMap.get(current);
      if (!entry) return null;
      if (used.has(entry.proofIndex)) return null;
      const proof = this.proofCache[entry.proofIndex];
      if (!proof) return null;
      selection.push(proof);
      used.add(entry.proofIndex);
      current = entry.prevSum;
    }
    selection.reverse();
    return selection.length ? selection : null;
  }

  async checkProofStates(proofs: Proof[]): Promise<ProofState[]> {
    return this.wallet.checkProofsStates(proofs);
  }

  async supportsProofStateSubscriptions(): Promise<boolean> {
    try {
      const info = await this.ensureMintInfo();
      const support = info?.isSupported?.(17);
      if (!support || support.supported !== true) return false;
      const params = Array.isArray(support.params) ? support.params : [];
      return params.some((entry: any) =>
        Array.isArray(entry?.commands) ? entry.commands.includes("proof_state") : false
      );
    } catch {
      return false;
    }
  }

  async subscribeProofStateUpdates(
    proofs: Proof[],
    callback: (payload: ProofState & { proof: Proof }) => void,
    onError: (e: Error) => void,
  ): Promise<() => void> {
    const walletAny = this.wallet as Wallet & {
      on?: {
        proofStateUpdates?: (
          proofList: Proof[],
          cb: (payload: ProofState & { proof: Proof }) => void,
          err: (e: Error) => void,
        ) => Promise<() => void>;
      };
      proofStateUpdates?: (
        proofList: Proof[],
        cb: (payload: ProofState & { proof: Proof }) => void,
        err: (e: Error) => void,
      ) => Promise<() => void>;
    };
    const subscribe =
      (typeof walletAny.on?.proofStateUpdates === "function"
        ? walletAny.on.proofStateUpdates.bind(walletAny.on)
        : null) ??
      (typeof walletAny.proofStateUpdates === "function"
        ? walletAny.proofStateUpdates.bind(walletAny)
        : null);
    if (!subscribe) {
      throw new Error("Mint does not support proof_state subscriptions");
    }
    return subscribe(proofs, callback, onError);
  }

  async subscribeMintQuoteUpdates(
    quoteIds: string[],
    callback: (quote: MintQuoteResponse) => void,
    onError: (error: Error) => void,
  ): Promise<() => void> {
    const walletAny = this.wallet as unknown as {
      on?: {
        mintQuoteUpdates?: (
          ids: string[],
          cb: (quote: MintQuoteResponse) => void,
          err: (error: Error) => void,
          options?: { signal?: AbortSignal },
        ) => Promise<() => void>;
      };
    };
    const subscribe = walletAny?.on?.mintQuoteUpdates;
    if (typeof subscribe !== "function") {
      throw new Error("Mint does not support mint quote subscriptions");
    }
    const context = walletAny.on;
    return subscribe.call(context, quoteIds, callback, onError);
  }

  async supportsMintQuoteSubscriptions(): Promise<boolean> {
    const walletAny = this.wallet as unknown as { on?: { mintQuoteUpdates?: unknown } };
    return typeof walletAny?.on?.mintQuoteUpdates === "function";
  }

  async createMeltQuote(invoice: string): Promise<MeltQuoteResponse> {
    const quote = await this.wallet.createMeltQuote(invoice);
    return quote as MeltQuoteResponse; // {quote, amount, fee_reserve, request, state, expiry, unit}
  }

  private requiredForQuote(quote: MeltQuoteResponse): number {
    const amount = typeof quote.amount === "number" ? quote.amount : 0;
    const fees = typeof quote.fee_reserve === "number" ? quote.fee_reserve : 0;
    return amount + fees;
  }

  private async executeMeltQuote(quote: MeltQuoteResponse): Promise<MeltProofsResponse> {
    const required = this.requiredForQuote(quote);
    if (this.balance < required) throw new Error("Insufficient balance for invoice + fees");
    const selected = this.selectProofsForAmount(required, true);
    const { keep, send } = await this.wallet.send(required, selected, { proofsWeHave: [...this.proofCache] });
    this.persistAfterSpend(selected, keep);

    let storedKey: string | null = null;
    const res = await this.wallet.meltProofs(quote as MeltQuoteResponse, send, {
      onChangeOutputsCreated: (blanks) => {
        storedKey = this.rememberMeltBlanks(blanks);
      },
    });

    const responseKey =
      CashuManager.extractQuoteKey(res?.quote) ?? storedKey ?? CashuManager.extractQuoteKey(quote);

    if (res?.change?.length) {
      const signedChange = this.autoSignProofs(res.change);
      this.mergeProofs(signedChange);
      res.change = signedChange;
      if (responseKey) this.clearMeltBlanksByQuote(responseKey);
      return res;
    }

    if (responseKey) {
      const blanks = this.getStoredMeltBlanks(responseKey);
      if (blanks && res?.quote?.state === "PAID") {
        const finalized = await this.finalizeStoredMeltChange(responseKey);
        if (Array.isArray(finalized)) {
          res.change = finalized;
        }
      } else if (!blanks) {
        this.clearMeltBlanksByQuote(responseKey);
      }
    }

    return res;
  }

  async supportsBolt11MultiPathPayments(): Promise<boolean> {
    try {
      const info = await this.ensureMintInfo();
      if (!info || typeof info.isSupported !== "function") return false;
      const support = info.isSupported(15);
      if (!support || support.supported !== true) return false;
      const params = Array.isArray(support.params) ? support.params : [];
      return params.some((entry: any) => entry?.method === "bolt11" && entry?.unit === this.unit);
    } catch {
      return false;
    }
  }

  async payMeltQuote(quote: MeltQuoteResponse): Promise<MeltProofsResponse> {
    return this.executeMeltQuote(quote);
  }

  async prepareMultiPathMeltQuote(
    invoice: string,
    targetAmount: number,
  ): Promise<{ quote: MeltQuoteResponse; amount: number; required: number } | null> {
    const balance = this.balance;
    let attempt = Math.min(Math.floor(targetAmount), Math.floor(balance));
    if (!Number.isFinite(attempt) || attempt <= 0) return null;
    while (attempt > 0) {
      const quote = await this.wallet.createMultiPathMeltQuote(invoice, attempt);
      const required = this.requiredForQuote(quote as MeltQuoteResponse);
      if (required <= balance) {
        return { quote: quote as MeltQuoteResponse, amount: quote.amount ?? attempt, required };
      }
      const feeReserve = typeof quote.fee_reserve === "number" ? quote.fee_reserve : 0;
      const maxPartial = Math.floor(balance - feeReserve);
      const nextAttempt = Math.floor(Math.min(attempt - 1, maxPartial));
      if (!Number.isFinite(nextAttempt) || nextAttempt < 1) break;
      attempt = nextAttempt;
    }
    return null;
  }

  async payInvoicePartial(invoice: string, partialAmount: number): Promise<MeltProofsResponse> {
    const prepared = await this.prepareMultiPathMeltQuote(invoice, partialAmount);
    if (!prepared) {
      throw new Error("Insufficient balance for partial invoice + fees");
    }
    return this.executeMeltQuote(prepared.quote);
  }

  async payInvoice(invoice: string): Promise<MeltProofsResponse> {
    const meltQuote = await this.wallet.createMeltQuote(invoice);
    return this.executeMeltQuote(meltQuote as MeltQuoteResponse);
  }
}
