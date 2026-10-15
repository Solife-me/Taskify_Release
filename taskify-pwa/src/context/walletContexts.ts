/**
 * The wallet's React contexts and hooks, without the wallet itself.
 *
 * The Taskify wallet is being phased out, and most devices never use it. Its providers (and the
 * Cashu SDK they load) run in `WalletRuntime`, which `App` mounts lazily, as a sibling rather
 * than an ancestor, only where the wallet is enabled. The runtime publishes each provider's
 * value to a store here; `useCashu`, `useNwc` and `useP2PK` read the nearest provider when called
 * inside the runtime and the published value elsewhere. Where the wallet is not running they
 * return an unavailable value whose actions fail with `WalletUnavailableError`, which the
 * wallet UI never reaches because it is hidden there.
 *
 * Only types may be imported from the provider modules here: a value import would put the
 * Cashu SDK back into startup.
 */
import { createContext, useContext, useSyncExternalStore } from "react";
import type { CashuContextType } from "./CashuContext";
import type { NwcContextValue } from "./NwcContext";
import type { P2PKContextValue } from "./P2PKContext";
import { createStateStore, type StateStore } from "../state/stateStore";

export class WalletUnavailableError extends Error {
  constructor() {
    super("The Taskify wallet is not running on this device.");
    this.name = "WalletUnavailableError";
  }
}

const unavailable = (): never => {
  throw new WalletUnavailableError();
};
const unavailableAsync = async (): Promise<never> => unavailable();

const UNAVAILABLE_CASHU: CashuContextType = {
  ready: false,
  mintUrl: "",
  setMintUrl: unavailableAsync,
  balance: 0,
  totalBalance: 0,
  pendingBalance: 0,
  proofs: [],
  info: null,
  createMintInvoice: unavailableAsync,
  checkMintQuote: unavailableAsync,
  claimMint: unavailableAsync,
  savePendingTokenForRedemption: unavailableAsync,
  receiveToken: unavailableAsync,
  createSendToken: unavailableAsync,
  payInvoice: unavailableAsync,
  checkProofStates: unavailableAsync,
  subscribeProofStateUpdates: unavailableAsync,
  subscribeMintQuoteUpdates: unavailableAsync,
  createTokenFromProofSelection: unavailableAsync,
  redeemPendingToken: unavailableAsync,
  getMintConnection: unavailableAsync,
  refreshTotalBalance: () => {},
};

const UNAVAILABLE_NWC: NwcContextValue = {
  ready: false,
  status: "idle",
  connection: null,
  info: null,
  lastError: null,
  wallets: [],
  activeWalletId: null,
  activeWallet: null,
  connect: unavailableAsync,
  selectWallet: unavailable,
  updateReceiveAddress: unavailable,
  removeWallet: unavailable,
  disconnect: () => {},
  refreshInfo: unavailableAsync,
  getBalanceMsat: unavailableAsync,
  payInvoice: unavailableAsync,
  makeInvoice: unavailableAsync,
  lookupInvoice: unavailableAsync,
};

const UNAVAILABLE_P2PK: P2PKContextValue = {
  keys: [],
  primaryKeyId: null,
  primaryKey: null,
  generateKeypair: unavailable,
  importFromNsec: unavailable,
  removeKey: unavailable,
  setPrimaryKey: unavailable,
  markKeyUsed: unavailable,
  getPrivateKeyForPubkey: () => null,
};

// Kept on globalThis so hot reloads in development reuse the same context objects.
const globalObj = globalThis as Record<string, unknown>;
function sharedContext<T>(key: string) {
  return (globalObj[key] ??= createContext<T | null>(null)) as React.Context<T | null>;
}

export const CashuContext = sharedContext<CashuContextType>("__TASKIFY_CASHU_CONTEXT__");
export const NwcContext = sharedContext<NwcContextValue>("__TASKIFY_NWC_CONTEXT__");
export const P2PKContext = sharedContext<P2PKContextValue>("__TASKIFY_P2PK_CONTEXT__");

/** What the running wallet last published; null while it is not running. */
export const publishedCashu: StateStore<CashuContextType | null> = createStateStore<CashuContextType | null>(null);
export const publishedNwc: StateStore<NwcContextValue | null> = createStateStore<NwcContextValue | null>(null);
export const publishedP2PK: StateStore<P2PKContextValue | null> = createStateStore<P2PKContextValue | null>(null);

function useWalletValue<T>(context: React.Context<T | null>, published: StateStore<T | null>, fallback: T): T {
  const fromProvider = useContext(context);
  const fromRuntime = useSyncExternalStore(published.subscribe, published.get, published.get);
  return fromProvider ?? fromRuntime ?? fallback;
}

export function useCashu(): CashuContextType {
  return useWalletValue(CashuContext, publishedCashu, UNAVAILABLE_CASHU);
}

export function useNwc(): NwcContextValue {
  return useWalletValue(NwcContext, publishedNwc, UNAVAILABLE_NWC);
}

export function useP2PK(): P2PKContextValue {
  return useWalletValue(P2PKContext, publishedP2PK, UNAVAILABLE_P2PK);
}
