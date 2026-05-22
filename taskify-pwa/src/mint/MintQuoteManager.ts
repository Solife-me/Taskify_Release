import type { MeltQuoteResponse, MintQuoteResponse } from "../wallet/cashuTypes";
import type { MintConnection } from "./MintConnection";

type MintQuoteParams = {
  amount: number;
  description?: string;
  pubkey?: string;
  method?: "bolt11" | "bolt12";
};

export class MintQuoteManager {
  private readonly connection: MintConnection;
  private readonly mintQuoteCache = new Map<string, MintQuoteResponse>();
  private readonly meltQuoteCache = new Map<string, MeltQuoteResponse>();

  constructor(connection: MintConnection) {
    this.connection = connection;
  }

  private rememberMintQuote(quote: MintQuoteResponse) {
    if (!quote?.quote) return;
    this.mintQuoteCache.set(quote.quote, quote);
  }

  private rememberMeltQuote(quote: MeltQuoteResponse, key?: string) {
    if (!quote?.quote) return;
    const cacheKey = key ?? quote.request ?? quote.quote;
    if (cacheKey) {
      this.meltQuoteCache.set(cacheKey, quote);
    } else {
      this.meltQuoteCache.set(quote.quote, quote);
    }
  }

  cacheMintQuote(quote: MintQuoteResponse) {
    this.rememberMintQuote(quote);
  }

  cacheMeltQuote(key: string, quote: MeltQuoteResponse) {
    this.rememberMeltQuote(quote, key);
  }

  async requestMintQuote(params: MintQuoteParams): Promise<MintQuoteResponse> {
    const key = this.connection.requestCache.buildKey("POST", "mint-quote", params);
    const res = await this.connection.runWithRateLimit(
      key,
      () => this.connection.createMintQuote(params),
      { ttlMs: 3000 },
    );
    this.rememberMintQuote(res);
    return res;
  }

  async checkMintQuote(quoteId: string): Promise<MintQuoteResponse> {
    if (this.mintQuoteCache.has(quoteId)) {
      const cached = this.mintQuoteCache.get(quoteId)!;
      if (cached.state === "PAID" || cached.state === "ISSUED") {
        return cached;
      }
    }
    const res = await this.connection.checkMintQuote(quoteId);
    this.rememberMintQuote(res);
    return res;
  }

  async requestMeltQuote(invoice: string): Promise<MeltQuoteResponse> {
    const cached = this.meltQuoteCache.get(invoice);
    if (cached) return cached;
    const key = this.connection.requestCache.buildKey("POST", "melt-quote", { invoice });
    const res = await this.connection.runWithRateLimit(
      key,
      () => this.connection.createMeltQuote(invoice),
      { ttlMs: 2500 },
    );
    this.rememberMeltQuote(res, invoice);
    return res;
  }

  async subscribeMintQuoteUpdates(
    quoteIds: string[],
    callback: (quote: MintQuoteResponse) => void,
    onError: (err: Error) => void,
  ) {
    const cancel = await this.connection.subscribeMintQuoteUpdates(quoteIds, (quote) => {
      this.rememberMintQuote(quote);
      callback(quote);
    }, onError);
    return cancel;
  }
}
