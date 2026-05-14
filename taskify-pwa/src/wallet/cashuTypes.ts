export type CashuAmountLike =
  | number
  | bigint
  | string
  | {
      toNumber?: () => number;
      toNumberUnsafe?: () => number;
      toString?: () => string;
    };

export type MintQuoteResponse = {
  quote: string;
  request?: string;
  unit?: string;
  amount?: CashuAmountLike;
  state?: string;
  expiry?: number | null;
  pubkey?: string;
  [key: string]: unknown;
};

export type MeltQuoteResponse = {
  quote: string;
  request?: string;
  unit?: string;
  amount?: CashuAmountLike;
  fee_reserve?: CashuAmountLike;
  state?: string;
  expiry?: number | null;
  payment_preimage?: string | null;
  [key: string]: unknown;
};
