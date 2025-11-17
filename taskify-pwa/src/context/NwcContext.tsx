import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { NwcClient, parseNwcUri, type ParsedNwcUri } from "../wallet/nwc";

const LS_NWC_URI = "cashu_nwc_connection_v1";

type NwcStatus = "idle" | "connecting" | "connected" | "error";

type NwcInfo = {
  alias?: string;
  methods?: string[];
  balanceMsat?: number;
  maxSendMsat?: number;
  maxReceiveMsat?: number;
  rawInfo?: Record<string, unknown>;
  rawBalance?: Record<string, unknown>;
};

type NwcPayResponse = {
  preimage?: string;
  [key: string]: unknown;
};

type NwcMakeInvoiceResponse = {
  invoice: string;
  [key: string]: unknown;
};

function mergeInfo(base: NwcInfo | null, next: NwcInfo | null): NwcInfo | null {
  if (!base) return next ? { ...next } : null;
  if (!next) return { ...base };
  return {
    alias: next.alias ?? base.alias,
    methods: next.methods ?? base.methods,
    balanceMsat: next.balanceMsat ?? base.balanceMsat,
    maxSendMsat: next.maxSendMsat ?? base.maxSendMsat,
    maxReceiveMsat: next.maxReceiveMsat ?? base.maxReceiveMsat,
    rawInfo: next.rawInfo ?? base.rawInfo,
    rawBalance: next.rawBalance ?? base.rawBalance,
  };
}

type NwcContextValue = {
  ready: boolean;
  status: NwcStatus;
  connection: ParsedNwcUri | null;
  info: NwcInfo | null;
  lastError: string | null;
  connect: (uri: string) => Promise<void>;
  disconnect: () => void;
  refreshInfo: () => Promise<NwcInfo | null>;
  getBalanceMsat: () => Promise<number | null>;
  payInvoice: (invoice: string) => Promise<NwcPayResponse>;
  makeInvoice: (amountMsat: number, memo?: string) => Promise<NwcMakeInvoiceResponse>;
};

const NwcContext = createContext<NwcContextValue | null>(null);

function extractInfo(infoRes: Record<string, any> | null | undefined, balanceRes: Record<string, any> | null | undefined): NwcInfo | null {
  if (!infoRes && !balanceRes) return null;
  const info: NwcInfo = {};
  if (infoRes) {
    info.alias = infoRes.alias || infoRes.name || infoRes.wallet_name;
    const methods = infoRes.supported_methods || infoRes.methods;
    if (Array.isArray(methods)) info.methods = methods;
    info.maxSendMsat = infoRes.max_sendable ?? infoRes.max_payment_amount ?? infoRes.max_send_msat;
    info.maxReceiveMsat = infoRes.max_receivable ?? infoRes.max_invoice_amount ?? infoRes.max_receive_msat;
    info.rawInfo = infoRes;
  }
  if (balanceRes) {
    const raw = balanceRes.balance ?? balanceRes;
    let msat: number | undefined;
    if (typeof raw === "number") {
      msat = raw;
    } else if (raw && typeof raw === "object") {
      if (typeof raw.msat === "number") msat = raw.msat;
      else if (typeof raw.msats === "number") msat = raw.msats;
      else if (typeof raw.amount === "number") msat = raw.amount;
      else if (typeof raw.available === "number") msat = raw.available;
      else if (typeof raw.total === "number") msat = raw.total;
    }
    if (typeof msat === "number") info.balanceMsat = msat;
    info.rawBalance = balanceRes;
  }
  return info;
}

export function NwcProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<NwcStatus>("idle");
  const [connection, setConnection] = useState<ParsedNwcUri | null>(null);
  const [info, setInfo] = useState<NwcInfo | null>(null);
  const infoRef = useRef<NwcInfo | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const clientRef = useRef<NwcClient | null>(null);

  useEffect(() => {
    infoRef.current = info;
  }, [info]);

  const setClient = useCallback((parsed: ParsedNwcUri | null) => {
    if (!parsed) {
      clientRef.current = null;
      return;
    }
    clientRef.current = new NwcClient(parsed);
  }, []);

  useEffect(() => {
    let parsed: ParsedNwcUri | null = null;
    try {
      const saved = localStorage.getItem(LS_NWC_URI);
      if (saved) parsed = parseNwcUri(saved);
    } catch (err) {
      console.warn("Failed to restore NWC connection", err);
      localStorage.removeItem(LS_NWC_URI);
    }
    if (parsed) {
      setConnection(parsed);
      setClient(parsed);
      setStatus("connected");
    }
    setReady(true);
  }, [setClient]);

  const ensureClient = useCallback(() => {
    if (clientRef.current) return clientRef.current;
    if (!connection) throw new Error("NWC connection not configured");
    const fresh = new NwcClient(connection);
    clientRef.current = fresh;
    return fresh;
  }, [connection]);

  const connect = useCallback(async (uri: string) => {
    setStatus("connecting");
    setLastError(null);
    try {
      const parsed = parseNwcUri(uri);
      const client = new NwcClient(parsed);
      let infoRes: Record<string, any> | null = null;
      try {
        infoRes = await client.request<Record<string, any>>("get_info", {});
      } catch (err) {
        console.warn("NWC get_info failed", err);
      }
      let balanceRes: Record<string, any> | null = null;
      try {
        balanceRes = await client.request<Record<string, any>>("get_balance", {});
      } catch (err) {
        console.warn("NWC get_balance failed", err);
      }
      const combined = extractInfo(infoRes, balanceRes);
      setConnection(parsed);
      setClient(parsed);
      setInfo(combined ?? null);
      infoRef.current = combined ?? null;
      setStatus("connected");
      try { localStorage.setItem(LS_NWC_URI, parsed.uri); } catch {}
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      setLastError(message);
      setStatus("error");
      throw new Error(message);
    }
  }, [setClient]);

  const disconnect = useCallback(() => {
    setConnection(null);
    setClient(null);
    setInfo(null);
    infoRef.current = null;
    setStatus("idle");
    setLastError(null);
    try { localStorage.removeItem(LS_NWC_URI); } catch {}
  }, [setClient]);

  const refreshInfo = useCallback(async () => {
    try {
      const client = ensureClient();
      const infoRes = await client.request<Record<string, any>>("get_info", {});
      let balanceRes: Record<string, any> | null = null;
      try {
        balanceRes = await client.request<Record<string, any>>("get_balance", {});
      } catch (err) {
        console.warn("NWC get_balance failed", err);
      }
      const combined = extractInfo(infoRes, balanceRes);
      const next = mergeInfo(infoRef.current, combined);
      setInfo(next);
      infoRef.current = next;
      return next;
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      setLastError(message);
      throw new Error(message);
    }
  }, [ensureClient]);

  const getBalanceMsat = useCallback(async () => {
    try {
      const client = ensureClient();
      const balanceRes = await client.request<Record<string, any>>("get_balance", {});
      const combined = extractInfo(null, balanceRes);
      if (combined?.balanceMsat !== undefined) {
        const next = mergeInfo(infoRef.current, combined);
        setInfo(next);
        infoRef.current = next;
        return combined.balanceMsat ?? null;
      }
      return null;
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      setLastError(message);
      throw new Error(message);
    }
  }, [ensureClient]);

  const payInvoice = useCallback(async (invoice: string) => {
    if (!invoice?.trim()) throw new Error("Missing invoice");
    try {
      const client = ensureClient();
      const res = await client.request<NwcPayResponse>("pay_invoice", { invoice: invoice.trim() });
      return res;
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      setLastError(message);
      throw new Error(message);
    }
  }, [ensureClient]);

  const makeInvoice = useCallback(async (amountMsat: number, memo?: string) => {
    if (!Number.isFinite(amountMsat) || amountMsat <= 0) throw new Error("Amount must be positive");
    try {
      const client = ensureClient();
      const amt = Math.round(amountMsat);
      const payload: Record<string, unknown> = { amount: amt, amount_msat: amt };
      if (memo) payload.memo = memo;
      const res = await client.request<NwcMakeInvoiceResponse>("make_invoice", payload);
      if (!res?.invoice) throw new Error("Wallet did not return an invoice");
      return res;
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      setLastError(message);
      throw new Error(message);
    }
  }, [ensureClient]);

  const value = useMemo<NwcContextValue>(() => ({
    ready,
    status,
    connection,
    info,
    lastError,
    connect,
    disconnect,
    refreshInfo,
    getBalanceMsat,
    payInvoice,
    makeInvoice,
  }), [ready, status, connection, info, lastError, connect, disconnect, refreshInfo, getBalanceMsat, payInvoice, makeInvoice]);

  return <NwcContext.Provider value={value}>{children}</NwcContext.Provider>;
}

export function useNwc() {
  const ctx = useContext(NwcContext);
  if (!ctx) throw new Error("useNwc must be used within NwcProvider");
  return ctx;
}
