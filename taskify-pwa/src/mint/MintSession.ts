import type { Proof, ProofState } from "@cashu/cashu-ts";
import type { MeltQuoteResponse, MintQuoteResponse } from "../wallet/cashuTypes";
import { MintCapabilityStore } from "./MintCapabilityStore";
import { MintConnection, type MintConnectionOptions, type CreateSendTokenOptions, type SendTokenLockInfo } from "./MintConnection";

export type MintSessionHooks = {
  getP2PKPrivkey?: (pubkey: string) => string | null;
  onP2PKUsage?: (pubkey: string, count: number) => void;
};

export class MintSession {
  private static instance: MintSession | null = null;
  private readonly capabilityStore = new MintCapabilityStore();
  private readonly connections = new Map<string, MintConnection>();
  private hooks: MintSessionHooks;

  private constructor(hooks: MintSessionHooks = {}) {
    this.hooks = hooks;
  }

  private normalize(url: string): string {
    return url.trim().replace(/\/+$/, "");
  }

  private buildOptions(): MintConnectionOptions {
    return {
      capabilityStore: this.capabilityStore,
      getP2PKPrivkey: this.hooks.getP2PKPrivkey,
      onP2PKUsage: this.hooks.onP2PKUsage,
    };
  }

  static init(hooks: MintSessionHooks = {}) {
    if (!MintSession.instance) {
      MintSession.instance = new MintSession(hooks);
    } else {
      MintSession.instance.setHooks(hooks);
    }
    return MintSession.instance;
  }

  private static getInstance(): MintSession {
    if (!MintSession.instance) {
      MintSession.instance = new MintSession();
    }
    return MintSession.instance;
  }

  setHooks(hooks: MintSessionHooks = {}) {
    this.hooks = { ...this.hooks, ...hooks };
    this.connections.forEach((conn) => conn.updateHooks(this.hooks));
  }

  async getConnection(mintUrl: string): Promise<MintConnection> {
    const normalized = this.normalize(mintUrl);
    let connection = this.connections.get(normalized);
    if (!connection) {
      connection = new MintConnection(normalized, this.buildOptions());
      this.connections.set(normalized, connection);
    } else {
      connection.updateHooks(this.hooks);
    }
    await connection.init();
    return connection;
  }

  // ---- static helpers

  static async getMintInfo(mintUrl: string) {
    const session = MintSession.getInstance();
    const conn = await session.getConnection(mintUrl);
    return conn.getMintInfo();
  }

  static async requestMintQuote(mintUrl: string, params: { amount: number; description?: string; pubkey?: string; method?: "bolt11" | "bolt12" }): Promise<MintQuoteResponse> {
    const session = MintSession.getInstance();
    const conn = await session.getConnection(mintUrl);
    return conn.quoteManager.requestMintQuote(params);
  }

  static async checkMintQuote(mintUrl: string, quoteId: string): Promise<MintQuoteResponse> {
    const session = MintSession.getInstance();
    const conn = await session.getConnection(mintUrl);
    return conn.quoteManager.checkMintQuote(quoteId);
  }

  static async executeMint(mintUrl: string, quoteId: string, amount: number) {
    const session = MintSession.getInstance();
    const conn = await session.getConnection(mintUrl);
    return conn.claimMint(quoteId, amount);
  }

  static async requestMeltQuote(mintUrl: string, invoice: string): Promise<MeltQuoteResponse> {
    const session = MintSession.getInstance();
    const conn = await session.getConnection(mintUrl);
    return conn.quoteManager.requestMeltQuote(invoice);
  }

  static async executeMelt(mintUrl: string, quote: MeltQuoteResponse) {
    const session = MintSession.getInstance();
    const conn = await session.getConnection(mintUrl);
    return conn.payMeltQuote(quote);
  }

  static async swap(mintUrl: string, inputs: Proof[], outputs: Proof[]) {
    const session = MintSession.getInstance();
    const conn = await session.getConnection(mintUrl);
    return conn.swapManager.swap(inputs, outputs);
  }

  static async checkTokenStates(mintUrl: string, proofs: Proof[]): Promise<ProofState[]> {
    const session = MintSession.getInstance();
    const conn = await session.getConnection(mintUrl);
    return conn.stateCheckManager.checkStates(proofs);
  }

  static async subscribeToQuote(
    mintUrl: string,
    quoteIds: string[],
    callback: (quote: MintQuoteResponse) => void,
    onError: (err: Error) => void,
  ) {
    const session = MintSession.getInstance();
    const conn = await session.getConnection(mintUrl);
    const supported = await conn.supportsMintQuoteSubscriptions();
    if (!supported) {
      throw new Error("Mint does not support quote subscriptions");
    }
    return conn.quoteManager.subscribeMintQuoteUpdates(quoteIds, callback, onError);
  }

  static async subscribeToProofState(
    mintUrl: string,
    proofs: Proof[],
    callback: (payload: ProofState & { proof: Proof }) => void,
    onError: (err: Error) => void,
  ) {
    const session = MintSession.getInstance();
    const conn = await session.getConnection(mintUrl);
    const supported = await conn.supportsProofStateSubscriptions();
    if (!supported) {
      throw new Error("Mint does not support proof_state subscriptions");
    }
    return conn.subscribeProofStateUpdates(proofs, callback, onError);
  }

  static async receiveToken(mintUrl: string, token: string) {
    const session = MintSession.getInstance();
    const conn = await session.getConnection(mintUrl);
    return conn.receiveToken(token);
  }

  static async createSendToken(
    mintUrl: string,
    amount: number,
    options?: CreateSendTokenOptions,
  ): Promise<{ token: string; send: Proof[]; keep: Proof[]; lockInfo: SendTokenLockInfo }> {
    const session = MintSession.getInstance();
    const conn = await session.getConnection(mintUrl);
    const res = await conn.createSendToken(amount, options);
    return res;
  }

  static async createTokenFromProofSecrets(
    mintUrl: string,
    secrets: string[],
  ): Promise<{ token: string; send: Proof[]; keep: Proof[] }> {
    const session = MintSession.getInstance();
    const conn = await session.getConnection(mintUrl);
    return conn.createTokenFromProofSecrets(secrets);
  }

  static async getBalance(mintUrl: string): Promise<number> {
    const session = MintSession.getInstance();
    const conn = await session.getConnection(mintUrl);
    return conn.balance;
  }

  static async getProofs(mintUrl: string): Promise<Proof[]> {
    const session = MintSession.getInstance();
    const conn = await session.getConnection(mintUrl);
    return conn.proofs;
  }
}

export type { MintConnection, CreateSendTokenOptions, SendTokenLockInfo };
