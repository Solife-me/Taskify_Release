import * as Cashu from "@cashu/cashu-ts";
import {
  getDecodedToken,
  getEncodedToken,
  type MeltProofsResponse,
  type OutputConfig,
  type P2PKOptions,
  type Proof,
  type ProofState,
  type Secret,
  type Wallet,
} from "@cashu/cashu-ts";
import {
  getLockedMintQuote,
  getPendingMelt,
  getProofs,
  listPendingMelts,
  removeLockedMintQuote,
  removePendingMelt,
  setProofs,
  upsertLockedMintQuote,
  upsertPendingMelt,
  type PendingMeltRecord,
  type SerializedMeltPreview,
  type SerializedOutputData,
} from "./storage";
import type { MeltQuoteResponse, MintQuoteResponse } from "./cashuTypes";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  getWalletSeedBytes,
  getWalletCounterInit,
  persistWalletCounter,
  persistWalletCounterSnapshot,
} from "./seed";
import { assertValidProofsDleq } from "./dleq";

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
  private static readonly REFRESH_RETRY_CODES = new Set<number>([11005, 12001, 12002]);
  private getP2PKPrivkey?: (pubkey: string) => string | null;
  private onP2PKUsage?: (pubkey: string, count: number) => void;
  private proofCache: Proof[] = [];
  private pendingMeltPreviews = new Map<string, SerializedMeltPreview>();
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(mintUrl: string, options?: CashuManagerOptions) {
    this.mintUrl = mintUrl.replace(/\/$/, "");
    this.getP2PKPrivkey = options?.getP2PKPrivkey;
    this.onP2PKUsage = options?.onP2PKUsage;
  }

  updateHooks(options: { getP2PKPrivkey?: (pubkey: string) => string | null; onP2PKUsage?: (pubkey: string, count: number) => void }) {
    if (options.getP2PKPrivkey !== undefined) this.getP2PKPrivkey = options.getP2PKPrivkey;
    if (options.onP2PKUsage !== undefined) this.onP2PKUsage = options.onP2PKUsage;
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationChain;
    let release: () => void = () => {};
    this.mutationChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private resolveMintPubkeyForProof(proof: Proof): string | null {
    if (!proof || typeof proof !== "object") return null;
    if (!this.wallet) return null;
    const keysetId = typeof proof.id === "string" ? proof.id : "";
    if (!keysetId) return null;
    const amount = CashuManager.amountToNumber((proof as any).amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    try {
      const keyset = (this.wallet as any).getKeyset?.(keysetId);
      const keys = keyset?.keys;
      const pubkey = keys?.[amount];
      if (typeof pubkey === "string" && pubkey.trim()) return pubkey.trim();
    } catch {
      // fall back below
    }
    try {
      const keyset = (this.wallet as any).keyChain?.getKeyset?.(keysetId);
      const keys = keyset?.keys;
      const pubkey = keys?.[amount];
      if (typeof pubkey === "string" && pubkey.trim()) return pubkey.trim();
    } catch {
      return null;
    }
    return null;
  }

  private validateDleqProofs(proofs: Proof[]) {
    assertValidProofsDleq(proofs, (proof) => this.resolveMintPubkeyForProof(proof));
  }

  private static extractQuoteKey(quote?: { quote?: string } | null): string | null {
    if (!quote || typeof quote.quote !== "string") return null;
    const key = quote.quote.trim();
    return key ? key : null;
  }

  private clearMeltPreviewByQuote(target: MeltQuoteResponse | string | null | undefined) {
    if (!target) return;
    const key =
      typeof target === "string"
        ? target.trim()
        : CashuManager.extractQuoteKey(typeof target === "object" ? target : null);
    if (key) {
      this.pendingMeltPreviews.delete(key);
    }
  }

  private getStoredMeltPreview(target: MeltQuoteResponse | string | null | undefined): SerializedMeltPreview | null {
    if (!target) return null;
    const key =
      typeof target === "string"
        ? target.trim()
        : CashuManager.extractQuoteKey(typeof target === "object" ? target : null);
    if (!key) return null;
    return this.pendingMeltPreviews.get(key) ?? getPendingMelt(this.mintUrl, key)?.preview ?? null;
  }

  private persistPendingMeltPreview(quoteId: string, preview: SerializedMeltPreview) {
    const record = getPendingMelt(this.mintUrl, quoteId);
    if (!record) return;
    upsertPendingMelt({
      ...record,
      preview,
      updatedAt: Date.now(),
    });
  }

  private persistPendingMelt(record: Omit<PendingMeltRecord, "mint" | "createdAt" | "updatedAt">) {
    const now = Date.now();
    const existing = getPendingMelt(this.mintUrl, record.quoteId);
    upsertPendingMelt({
      ...record,
      mint: this.mintUrl,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  private removePendingMeltRecord(quoteId: string | null | undefined) {
    const normalized = quoteId?.trim();
    if (!normalized) return;
    removePendingMelt(this.mintUrl, normalized);
  }

  private static amountToNumber(value: unknown): number {
    if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    if (typeof value === "bigint") {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
      return Math.max(0, Number(value));
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
    }
    const amountLike = value as { toNumber?: () => number; toNumberUnsafe?: () => number; toString?: () => string };
    try {
      if (typeof amountLike?.toNumber === "function") {
        const numeric = amountLike.toNumber();
        return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
      }
    } catch {
      // fall back below
    }
    try {
      if (typeof amountLike?.toNumberUnsafe === "function") {
        const numeric = amountLike.toNumberUnsafe();
        return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
      }
    } catch {
      // fall back below
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
  }

  private static normalizeProof(proof: Proof): Proof {
    return {
      ...proof,
      amount: CashuManager.amountToNumber((proof as any).amount) as any,
    };
  }

  private static normalizeMintQuoteResponse(quote: MintQuoteResponse): MintQuoteResponse {
    return {
      ...quote,
      amount: CashuManager.amountToNumber((quote as any).amount) as any,
    };
  }

  private static normalizeMeltQuoteResponse(quote: MeltQuoteResponse): MeltQuoteResponse {
    return {
      ...quote,
      amount: CashuManager.amountToNumber((quote as any).amount) as any,
      fee_reserve: CashuManager.amountToNumber((quote as any).fee_reserve) as any,
    };
  }

  private serializeOutputData(output: any): SerializedOutputData {
    const secret = output?.secret instanceof Uint8Array ? output.secret : new Uint8Array(output?.secret ?? []);
    return {
      blindedMessage: output?.blindedMessage,
      blindingFactor: output?.blindingFactor?.toString?.() ?? String(output?.blindingFactor ?? "0"),
      secret: bytesToHex(secret),
      ephemeralE: typeof output?.ephemeralE === "string" ? output.ephemeralE : undefined,
    };
  }

  private deserializeOutputData(output: SerializedOutputData): any {
    const OutputDataCtor = CashuAny.OutputData;
    if (!OutputDataCtor) throw new Error("Unsupported @cashu/cashu-ts version: missing OutputData export");
    return new OutputDataCtor(
      output.blindedMessage,
      BigInt(output.blindingFactor),
      hexToBytes(output.secret),
      output.ephemeralE,
    );
  }

  private serializeMeltPreview(preview: any): SerializedMeltPreview {
    return {
      method: preview.method,
      inputs: Array.isArray(preview.inputs)
        ? preview.inputs.map((proof: Proof) => CashuManager.normalizeProof(proof))
        : [],
      outputData: Array.isArray(preview.outputData)
        ? preview.outputData.map((output: any) => this.serializeOutputData(output))
        : [],
      keysetId: preview.keysetId,
      quote: preview.quote,
    };
  }

  private deserializeMeltPreview(preview: SerializedMeltPreview): any {
    return {
      method: preview.method,
      inputs: Array.isArray(preview.inputs)
        ? preview.inputs.map((proof: Proof) => CashuManager.normalizeProof(proof))
        : [],
      outputData: preview.outputData.map((output) => this.deserializeOutputData(output)),
      keysetId: preview.keysetId,
      quote: preview.quote,
    };
  }

  private async finalizeStoredMeltChange(
    target: MeltQuoteResponse | string | null | undefined,
  ): Promise<Proof[] | null> {
    const preview = this.getStoredMeltPreview(target);
    if (!preview) return null;
    const walletAny = this.wallet as any;
    if (typeof walletAny.completeMelt !== "function") return null;
    try {
      const hydratedPreview = this.deserializeMeltPreview(preview);
      const privkey = this.privkeysForProofs(hydratedPreview.inputs);
      const completion = await walletAny.completeMelt(hydratedPreview, privkey);
      const change = Array.isArray(completion?.change) ? completion.change : [];
      if (!change.length) {
        this.clearMeltPreviewByQuote(target);
        return [];
      }
      const signedChange = this.autoSignProofs(change);
      this.validateDleqProofs(signedChange);
      this.clearMeltPreviewByQuote(target);
      return signedChange;
    } catch (error) {
      console.warn("CashuManager: failed to finalize stored melt change", error);
      return null;
    }
  }

  private privkeysForProofs(proofs: Proof[]): string | string[] | undefined {
    const privkeys = [...this.resolvePrivkeysFromProofs(proofs).values()].map((entry) => entry.privkey);
    if (!privkeys.length) return undefined;
    return privkeys.length === 1 ? privkeys[0] : privkeys;
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
    const amount = (proof as any)?.amount;
    const amountKey =
      amount && typeof amount === "object" && typeof amount.toString === "function"
        ? amount.toString()
        : String(amount ?? 0);
    return `${proof.secret ?? ""}|${proof.C ?? ""}|${proof.id ?? ""}|${amountKey}`;
  }

  private static proofStorageKey(proof: Proof): string {
    return proof.secret ? `secret:${proof.secret}` : `key:${CashuManager.proofKey(proof)}`;
  }

  private static dedupeProofs(proofs: Proof[]): Proof[] {
    const seen = new Set<string>();
    const deduped: Proof[] = [];
    for (const proof of proofs) {
      if (!proof || typeof proof !== "object") continue;
      const key = CashuManager.proofStorageKey(proof);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(proof);
    }
    return deduped;
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

  decodeToken(encoded: string) {
    return getDecodedToken(encoded, []);
  }

  private resolvePrivkeysForToken(encoded: string): Map<string, { privkey: string; count: number }> {
    if (!this.getP2PKPrivkey) return new Map();
    try {
      const decoded: any = this.decodeToken(encoded);
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

  private static toErrorMessage(error: unknown): string {
    if (typeof error === "string") return error.toLowerCase();
    if (error && typeof error === "object") {
      const message = typeof (error as any).message === "string" ? (error as any).message : "";
      const detail = typeof (error as any).detail === "string" ? (error as any).detail : "";
      const responseDetail =
        typeof (error as any)?.response?.data?.detail === "string"
          ? (error as any).response.data.detail
          : "";
      return `${message} ${detail} ${responseDetail}`.toLowerCase();
    }
    return "";
  }

  private static readErrorCode(error: unknown): number | null {
    if (!error || typeof error !== "object") return null;
    const codeCandidates = [
      (error as any).code,
      (error as any)?.response?.data?.code,
    ];
    for (const value of codeCandidates) {
      if (typeof value === "number" && Number.isFinite(value)) {
        return Math.floor(value);
      }
      if (typeof value === "string") {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return null;
  }

  private static shouldRefreshMintState(error: unknown): boolean {
    const code = CashuManager.readErrorCode(error);
    if (code !== null && CashuManager.REFRESH_RETRY_CODES.has(code)) {
      return true;
    }
    const message = CashuManager.toErrorMessage(error);
    if (!message) return false;
    return (
      message.includes("no keyset found") ||
      message.includes("keyset") ||
      message.includes("input_fee_ppk") ||
      message.includes("transaction is not balanced") ||
      message.includes("wallet keyset has no keys")
    );
  }

  private static shouldRebuildWallet(error: unknown): boolean {
    const message = CashuManager.toErrorMessage(error);
    return (
      message.includes("wallet keyset has no keys after refresh") ||
      message.includes("keyset has no keys loaded") ||
      message.includes("keyset '") ||
      message.includes("no active keyset found")
    );
  }

  private async refreshMintState() {
    try {
      await this.wallet.loadMint(true);
      return;
    } catch (error) {
      if (!CashuManager.shouldRebuildWallet(error)) {
        throw error;
      }
      console.warn("CashuManager: rebuilding wallet after mint keyset change", error);
      await this.init();
    }
  }

  private async withMintRefreshRetry<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!CashuManager.shouldRefreshMintState(error)) {
        throw error;
      }
      await this.refreshMintState();
      return operation();
    }
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
    await this.recoverPendingMelts();
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
      ? proofs
          .filter((proof): proof is Proof => !!proof && typeof proof === "object")
          .map((proof) => CashuManager.normalizeProof(proof))
      : [];
    this.proofCache = sanitized;
    setProofs(this.mintUrl, sanitized);
  }

  private mergeProofs(proofs: Proof[]) {
    if (!Array.isArray(proofs) || proofs.length === 0) return;
    const merged = CashuManager.dedupeProofs([...this.proofCache, ...proofs]);
    this.persistProofs(merged);
  }

  private mergeProofSets(...sets: Proof[][]): Proof[] {
    return CashuManager.dedupeProofs(
      sets.flatMap((entry) => (Array.isArray(entry) ? entry : [])),
    );
  }

  private removeProofSet(base: Proof[], toRemove: Proof[]): Proof[] {
    const removeKeys = new Set(
      (Array.isArray(toRemove) ? toRemove : []).map((proof) => CashuManager.proofStorageKey(proof)),
    );
    if (!removeKeys.size) return [...base];
    return (Array.isArray(base) ? base : []).filter(
      (proof) => !removeKeys.has(CashuManager.proofStorageKey(proof)),
    );
  }

  private isMeltQuotePaid(quote: MeltQuoteResponse | null | undefined): boolean {
    const state = typeof quote?.state === "string" ? quote.state.toUpperCase() : "";
    return state === "PAID";
  }

  private isMeltQuotePending(quote: MeltQuoteResponse | null | undefined): boolean {
    const state = typeof quote?.state === "string" ? quote.state.toUpperCase() : "";
    return state === "PENDING";
  }

  private static mintQuoteState(quote: MintQuoteResponse | null | undefined): string {
    const state = typeof quote?.state === "string" ? quote.state.toUpperCase() : "";
    return state;
  }

  private mintSupportsNut(info: any, nut: number): boolean {
    try {
      if (typeof info?.isSupported === "function") {
        return info.isSupported(nut)?.supported === true;
      }
    } catch {
      return false;
    }
    const nutInfo = info?.nuts?.[nut] ?? info?.nuts?.[String(nut)];
    return nutInfo?.supported === true;
  }

  private async assertP2PKSupported() {
    const info = await this.ensureMintInfo();
    if (!this.mintSupportsNut(info, 10) || !this.mintSupportsNut(info, 11)) {
      throw new Error("Mint does not advertise P2PK spending-condition support (NUT-10/NUT-11)");
    }
  }

  private async assertNutSupported(nut: number, label: string) {
    const info = await this.ensureMintInfo();
    if (!this.mintSupportsNut(info, nut)) {
      throw new Error(`Mint does not advertise ${label} support`);
    }
  }

  private async supportsNut(nut: number): Promise<boolean> {
    const info = await this.ensureMintInfo();
    return this.mintSupportsNut(info, nut);
  }

  private createMintQuoteKeypair(): { privkey: string; pubkey: string } {
    if (typeof CashuAny.createRandomSecretKey !== "function" || typeof CashuAny.getPubKeyFromPrivKey !== "function") {
      throw new Error("Installed cashu wallet library does not support mint quote key generation");
    }
    const secret = CashuAny.createRandomSecretKey() as Uint8Array;
    return {
      privkey: bytesToHex(secret),
      pubkey: bytesToHex(CashuAny.getPubKeyFromPrivKey(secret) as Uint8Array),
    };
  }

  private rememberLockedMintQuote(quote: MintQuoteResponse, keypair: { privkey: string; pubkey: string }) {
    const quoteId = CashuManager.extractQuoteKey(quote);
    if (!quoteId) return;
    upsertLockedMintQuote({
      quoteId,
      mint: this.mintUrl,
      quote: {
        ...quote,
        pubkey: (quote as any).pubkey ?? keypair.pubkey,
      } as any,
      pubkey: keypair.pubkey,
      privkey: keypair.privkey,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  private async checkMeltQuoteSafe(quote: MeltQuoteResponse): Promise<MeltQuoteResponse | null> {
    const quoteId = CashuManager.extractQuoteKey(quote);
    if (!quoteId) return null;
    try {
      const walletAny = this.wallet as Wallet & {
        checkMeltQuoteBolt11?: (quoteOrId: string | MeltQuoteResponse) => Promise<MeltQuoteResponse>;
        checkMeltQuote?: (quoteOrId: string | MeltQuoteResponse) => Promise<MeltQuoteResponse>;
      };
      const check =
        typeof walletAny.checkMeltQuoteBolt11 === "function"
          ? walletAny.checkMeltQuoteBolt11.bind(walletAny)
          : typeof walletAny.checkMeltQuote === "function"
            ? walletAny.checkMeltQuote.bind(walletAny)
            : null;
      if (!check) return null;
      const status = await check(quoteId);
      return CashuManager.normalizeMeltQuoteResponse({
        ...status,
        request: status.request ?? quote.request,
        unit: status.unit ?? quote.unit,
      } as MeltQuoteResponse);
    } catch (error) {
      console.warn("CashuManager: failed to check melt quote after error", error);
      return null;
    }
  }

  private async recoverPendingMelt(record: PendingMeltRecord) {
    if (record.preview) {
      this.pendingMeltPreviews.set(record.quoteId, record.preview);
    }
    const status = await this.checkMeltQuoteSafe(record.quote);
    if (!status) return;

    if (this.isMeltQuotePaid(status)) {
      const recoveredChange = await this.finalizeStoredMeltChange(record.quoteId);
      const base = this.removeProofSet(this.proofCache, record.send);
      const paidProofs = this.mergeProofSets(
        base,
        record.keep,
        Array.isArray(recoveredChange) ? recoveredChange : [],
      );
      this.persistProofs(paidProofs);
      this.clearMeltPreviewByQuote(record.quoteId);
      this.removePendingMeltRecord(record.quoteId);
      return;
    }

    if (this.isMeltQuotePending(status)) {
      const base = this.removeProofSet(this.proofCache, record.send);
      this.persistProofs(this.mergeProofSets(base, record.keep));
      return;
    }

    this.persistProofs(this.mergeProofSets(this.proofCache, record.keep, record.send));
    this.clearMeltPreviewByQuote(record.quoteId);
    this.removePendingMeltRecord(record.quoteId);
  }

  private async recoverPendingMelts() {
    const records = listPendingMelts(this.mintUrl);
    for (const record of records) {
      try {
        await this.recoverPendingMelt(record);
      } catch (error) {
        console.warn("CashuManager: failed to recover pending melt", error);
      }
    }
  }

  get balance(): number {
    return this.proofCache.reduce((a, p) => a + CashuManager.amountToNumber((p as any)?.amount), 0);
  }

  async createMintInvoice(
    amount: number,
    description?: string,
    options?: { pubkey?: string; method?: "bolt11" | "bolt12" },
  ): Promise<MintQuoteResponse> {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Amount must be greater than zero");
    }
    const normalizedAmount = Math.floor(amount);
    const walletAny = this.wallet as Wallet & {
      createMintQuoteBolt11?: (amount: number, description?: string) => Promise<MintQuoteResponse>;
      createLockedMintQuote?: (amount: number, pubkey: string, description?: string) => Promise<MintQuoteResponse>;
      createMintQuoteBolt12?: (pubkey: string, options?: { amount?: number; description?: string }) => Promise<MintQuoteResponse>;
    };
    if (options?.method === "bolt12" && typeof walletAny?.createMintQuoteBolt12 === "function") {
      if (!options.pubkey) throw new Error("BOLT12 mint quotes require a locking public key");
      const quote = await walletAny.createMintQuoteBolt12(options.pubkey, {
        amount: normalizedAmount,
        description,
      });
      return CashuManager.normalizeMintQuoteResponse(quote as unknown as MintQuoteResponse);
    }
    if (typeof walletAny?.createMintQuoteBolt11 === "function") {
      if (options?.pubkey) {
        await this.assertNutSupported(20, "locked mint quote (NUT-20)");
        if (typeof walletAny.createLockedMintQuote !== "function") {
          throw new Error("Installed cashu wallet library does not support locked mint quotes");
        }
        const quote = await walletAny.createLockedMintQuote(normalizedAmount, options.pubkey, description);
        return CashuManager.normalizeMintQuoteResponse(quote);
      }
      if (typeof walletAny.createLockedMintQuote === "function") {
        try {
          if (await this.supportsNut(20)) {
            const keypair = this.createMintQuoteKeypair();
            const quote = await walletAny.createLockedMintQuote(normalizedAmount, keypair.pubkey, description);
            const normalizedQuote = CashuManager.normalizeMintQuoteResponse(quote);
            this.rememberLockedMintQuote(normalizedQuote, keypair);
            return normalizedQuote;
          }
        } catch (error) {
          console.warn("CashuManager: locked mint quote unavailable, falling back to regular quote", error);
        }
      }
      const quote = await walletAny.createMintQuoteBolt11(normalizedAmount, description);
      return CashuManager.normalizeMintQuoteResponse(quote);
    }
    return CashuManager.normalizeMintQuoteResponse(await (this.wallet as any).createMintQuote(normalizedAmount, description));
  }

  async checkMintQuote(quoteOrId: string | MintQuoteResponse): Promise<MintQuoteResponse> {
    // normalize to id
    const quoteId = typeof quoteOrId === "string" ? quoteOrId : quoteOrId.quote;
    const walletAny = this.wallet as any;
    const res =
      typeof walletAny.checkMintQuoteBolt11 === "function"
        ? await walletAny.checkMintQuoteBolt11(quoteId)
        : typeof walletAny.checkMintQuote === "function"
          ? await walletAny.checkMintQuote(quoteId)
          : await (this.wallet as any).checkMintQuote(quoteId);
    // Type narrowing: ensure amount/unit exist (MintQuoteResponse) by probing wallet.getMintInfo if needed
    const info = await this.ensureMintInfo();
    return CashuManager.normalizeMintQuoteResponse({
      amount: (res as any).amount ?? 0,
      unit: (res as any).unit ?? info?.unit ?? this.unit,
      request: res.request,
      quote: res.quote,
      state: res.state as MintQuoteState,
      expiry: res.expiry,
      pubkey: (res as any).pubkey,
    } as MintQuoteResponse);
  }

  async claimMint(quoteId: string, amount: number) {
    return this.withMutation(async () => {
      const status = await this.checkMintQuote(quoteId).catch(() => null);
      const state = CashuManager.mintQuoteState(status);
      if (state === "ISSUED") {
        throw new Error("Mint quote is already issued. Restore from wallet seed if proofs are missing.");
      }
      if (state && state !== "PAID") {
        throw new Error("Mint invoice is not paid yet");
      }
      const lockedQuote = getLockedMintQuote(this.mintUrl, quoteId);
      const proofs = await this.withMintRefreshRetry(async () => {
        const config: Record<string, any> = {
          proofsWeHave: [...this.proofCache],
          ...(lockedQuote?.privkey ? { privkey: lockedQuote.privkey } : {}),
        };
        const quoteArg = lockedQuote?.quote ?? quoteId;
        const walletAny = this.wallet as any;
        if (typeof walletAny.mintProofsBolt11 === "function") {
          return walletAny.mintProofsBolt11(amount, quoteArg, config);
        }
        return (this.wallet as any).mintProofs(amount, quoteArg, config);
      });
      const signed = this.autoSignProofs(proofs);
      this.validateDleqProofs(signed);
      this.mergeProofs(signed);
      if (lockedQuote) removeLockedMintQuote(this.mintUrl, quoteId);
      return signed;
    });
  }

  async receiveToken(encoded: string) {
    return this.withMutation(async () => {
      const privkeyMap = this.resolvePrivkeysForToken(encoded);
      const privkeyValues = [...privkeyMap.values()].map((entry) => entry.privkey);
      const newProofs = await this.withMintRefreshRetry(async () => {
        const receiveConfig: Record<string, any> = { proofsWeHave: [...this.proofCache] };
        if (privkeyValues.length === 1) {
          receiveConfig.privkey = privkeyValues[0];
        } else if (privkeyValues.length > 1) {
          receiveConfig.privkey = privkeyValues;
        }
        return this.wallet.receive(encoded, receiveConfig);
      });
      const signed = this.autoSignProofs(newProofs);
      this.validateDleqProofs(signed);
      this.mergeProofs(signed);
      privkeyMap.forEach((entry, pubkey) => {
        if (entry.count > 0) this.onP2PKUsage?.(pubkey, entry.count);
      });
      return signed;
    });
  }

  async createTokenFromProofSecrets(
    secrets: string[],
  ): Promise<{ token: string; send: Proof[]; keep: Proof[]; lockInfo: SendTokenLockInfo }> {
    return this.withMutation(async () => {
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
      this.validateDleqProofs(selected);
      this.persistProofs(keep);
      const token = getEncodedToken({ mint: this.mintUrl, proofs: selected, unit: this.unit });
      return { token, send: selected, keep, lockInfo: undefined };
    });
  }

  async createSendToken(
    amount: number,
    options?: CreateSendTokenOptions,
  ): Promise<{ token: string; send: Proof[]; keep: Proof[]; lockInfo: SendTokenLockInfo }> {
    return this.withMutation(async () => {
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error("Amount must be greater than zero");
      }
      let outputConfig: OutputConfig | undefined;
      if (options?.p2pk) {
        await this.assertP2PKSupported();
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
      const { keep, send } = await this.withMintRefreshRetry(async () => {
        const privkey = this.privkeysForProofs(this.proofCache);
        const response = await this.wallet.send(
          amount,
          [...this.proofCache],
          { proofsWeHave: [...this.proofCache], ...(privkey ? { privkey } : {}) },
          outputConfig,
        );
        return { keep: response.keep, send: response.send };
      });
      this.validateDleqProofs([...keep, ...send]);
      this.persistProofs(this.mergeProofSets(keep));
      const token = getEncodedToken({ mint: this.mintUrl, proofs: send, unit: this.unit });
      const lockInfo: SendTokenLockInfo = options?.p2pk ? { type: "p2pk", options: options.p2pk } : undefined;
      return { token, send, keep, lockInfo };
    });
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
    const quote = await this.withMintRefreshRetry(() => {
      const walletAny = this.wallet as any;
      if (typeof walletAny.createMeltQuoteBolt11 === "function") {
        return walletAny.createMeltQuoteBolt11(invoice);
      }
      return (this.wallet as any).createMeltQuote(invoice);
    });
    return CashuManager.normalizeMeltQuoteResponse(quote as MeltQuoteResponse);
  }

  private requiredForQuote(quote: MeltQuoteResponse): number {
    const amount = CashuManager.amountToNumber((quote as any).amount);
    const fees = CashuManager.amountToNumber((quote as any).fee_reserve);
    return amount + fees;
  }

  private async executeMeltQuote(quote: MeltQuoteResponse): Promise<MeltProofsResponse> {
    return this.withMutation(() => this.executeMeltQuoteUnlocked(quote));
  }

  private async executeMeltQuoteUnlocked(quote: MeltQuoteResponse): Promise<MeltProofsResponse> {
    const required = this.requiredForQuote(quote);
    if (this.balance < required) throw new Error("Insufficient balance for invoice + fees");
    const quoteId = CashuManager.extractQuoteKey(quote);
    const { keep, send } = await this.withMintRefreshRetry(async () => {
      const privkey = this.privkeysForProofs(this.proofCache);
      const swapped = await this.wallet.send(
        required,
        [...this.proofCache],
        { proofsWeHave: [...this.proofCache], ...(privkey ? { privkey } : {}) },
      );
      this.validateDleqProofs([...swapped.keep, ...swapped.send]);
      return { keep: swapped.keep, send: swapped.send };
    });
    const proofsIfMeltUnpaid = this.mergeProofSets(keep, send);
    this.persistProofs(proofsIfMeltUnpaid);
    if (quoteId) {
      this.persistPendingMelt({
        quoteId,
        quote,
        keep,
        send,
      });
    }

    let res: MeltProofsResponse;
    try {
      const walletAny = this.wallet as any;
      const meltPrivkey = this.privkeysForProofs(send);
      if (typeof walletAny.prepareMelt === "function" && typeof walletAny.completeMelt === "function") {
        const preview = await walletAny.prepareMelt("bolt11", quote, send);
        if (quoteId) {
          const serializedPreview = this.serializeMeltPreview(preview);
          this.pendingMeltPreviews.set(quoteId, serializedPreview);
          this.persistPendingMeltPreview(quoteId, serializedPreview);
        }
        res = await walletAny.completeMelt(preview, meltPrivkey);
      } else if (typeof walletAny.meltProofsBolt11 === "function") {
        res = await walletAny.meltProofsBolt11(quote, send, {
          ...(meltPrivkey ? { privkey: meltPrivkey } : {}),
        });
      } else {
        res = await (this.wallet as any).meltProofs(quote, send, {
          ...(meltPrivkey ? { privkey: meltPrivkey } : {}),
        });
      }
    } catch (error) {
      const status = await this.checkMeltQuoteSafe(quote);
      if (!status) {
        throw error;
      }
      if (this.isMeltQuotePending(status)) {
        this.persistProofs(this.mergeProofSets(keep));
        return {
          quote: status,
          change: [],
        } as unknown as MeltProofsResponse;
      }
      if (!this.isMeltQuotePaid(status)) {
        this.persistProofs(proofsIfMeltUnpaid);
        if (quoteId) this.removePendingMeltRecord(quoteId);
        throw error;
      }
      const recoveredChange = await this.finalizeStoredMeltChange(status);
      const paidProofs = this.mergeProofSets(keep, Array.isArray(recoveredChange) ? recoveredChange : []);
      this.persistProofs(paidProofs);
      if (quoteId) this.removePendingMeltRecord(quoteId);
      return {
        quote: status,
        change: Array.isArray(recoveredChange) ? recoveredChange : [],
      } as unknown as MeltProofsResponse;
    }

    const responseKey =
      CashuManager.extractQuoteKey(res?.quote) ?? CashuManager.extractQuoteKey(quote);

    let resolvedChange: Proof[] = Array.isArray(res?.change) ? res.change : [];
    if (resolvedChange.length) {
      const signedChange = this.autoSignProofs(resolvedChange);
      this.validateDleqProofs(signedChange);
      res.change = signedChange;
      resolvedChange = signedChange;
    }

    if (this.isMeltQuotePaid(res?.quote as MeltQuoteResponse)) {
      const paidProofs = this.mergeProofSets(keep, resolvedChange);
      this.persistProofs(paidProofs);
      if (responseKey) this.clearMeltPreviewByQuote(responseKey);
      if (responseKey) this.removePendingMeltRecord(responseKey);
    } else if (this.isMeltQuotePending(res?.quote as MeltQuoteResponse)) {
      this.persistProofs(this.mergeProofSets(keep));
    } else {
      this.persistProofs(proofsIfMeltUnpaid);
      if (responseKey) this.removePendingMeltRecord(responseKey);
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
      const attemptMsat = attempt * 1000;
      if (!Number.isFinite(attemptMsat) || attemptMsat > Number.MAX_SAFE_INTEGER) return null;
      const quote = await this.withMintRefreshRetry(() => this.wallet.createMultiPathMeltQuote(invoice, attemptMsat));
      const required = this.requiredForQuote(quote as MeltQuoteResponse);
      if (required <= balance) {
        const quotedAmount = CashuManager.amountToNumber((quote as any).amount) || attempt;
        return { quote: quote as MeltQuoteResponse, amount: quotedAmount, required };
      }
      const feeReserve = CashuManager.amountToNumber((quote as any).fee_reserve);
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
    const meltQuote = await this.createMeltQuote(invoice);
    return this.executeMeltQuote(meltQuote as MeltQuoteResponse);
  }
}
