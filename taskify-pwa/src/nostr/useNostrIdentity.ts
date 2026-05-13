import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, type EventTemplate } from "nostr-tools";
import { DEFAULT_NOSTR_RELAYS } from "../lib/relays";
import {
  acknowledgeBackupNotice as nostrSkAcknowledgeBackupNotice,
  getSkSync as nostrSkSync,
  isBackupNoticePending as nostrSkBackupNoticePending,
  setSk as nostrSkSet,
} from "../lib/nostrSkStore";
import {
  createNostrPool,
  NOSTR_MIN_EVENT_INTERVAL_MS,
  type NostrEvent,
} from "../domains/nostr/nostrPool";
import { NostrSession } from "./NostrSession";

export type NostrPublishFn = {
  (relays: string[], template: EventTemplate, options?: { sk?: Uint8Array | string }): Promise<number>;
  (
    relays: string[],
    template: EventTemplate,
    options: { sk?: Uint8Array | string; returnEvent: true },
  ): Promise<{ createdAt: number; event: NostrEvent }>;
};

type UseNostrIdentityParams = {
  defaultRelays: string[];
};

function bytesLikeToHex(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (Array.isArray(value)) return bytesToHex(Uint8Array.from(value as number[]));
  return null;
}

function normalizeSecretKeyInput(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (!value) return null;
  if (value.startsWith("nsec")) {
    try {
      const dec = nip19.decode(value);
      if (dec.type !== "nsec") return null;
      value = bytesLikeToHex(dec.data) ?? "";
    } catch {
      return null;
    }
  }
  if (!/^[0-9a-fA-F]{64}$/.test(value)) return null;
  return value.toLowerCase();
}

function toNsec(secret: string): string {
  const trimmed = (secret || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("nsec")) return trimmed;
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed;
  try {
    return typeof (nip19 as any)?.nsecEncode === "function" ? (nip19 as any).nsecEncode(hexToBytes(trimmed)) : trimmed;
  } catch {
    return trimmed;
  }
}

export function useNostrIdentity({ defaultRelays }: UseNostrIdentityParams) {
  const pool = useMemo(() => createNostrPool(), []);
  const initialStoredNostrSecretHex = useMemo(() => {
    try {
      const existing = nostrSkSync();
      if (existing && /^[0-9a-fA-F]{64}$/.test(existing)) {
        return existing.toLowerCase();
      }
    } catch {}
    return null;
  }, []);

  const [nostrSK, setNostrSK] = useState<Uint8Array>(() => {
    if (initialStoredNostrSecretHex) {
      return hexToBytes(initialStoredNostrSecretHex);
    }
    return generateSecretKey();
  });
  const [nostrPK, setNostrPK] = useState<string>(() => {
    if (!initialStoredNostrSecretHex) return "";
    try {
      return getPublicKey(hexToBytes(initialStoredNostrSecretHex));
    } catch {
      return "";
    }
  });
  const nostrSkHex = useMemo(() => bytesToHex(nostrSK), [nostrSK]);

  useEffect(() => { (window as any).nostrPK = nostrPK; }, [nostrPK]);
  useEffect(() => {
    const relays = defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS);
    NostrSession.init(relays).catch((err) => {
      console.warn("Failed to initialize Nostr session", err);
    });
  }, [defaultRelays]);

  const [showSkBackupNotice, setShowSkBackupNotice] = useState(() => nostrSkBackupNoticePending());
  const dismissSkBackupNotice = useCallback(() => {
    nostrSkAcknowledgeBackupNotice();
    setShowSkBackupNotice(false);
  }, []);
  const copyNsecAndDismiss = useCallback(async () => {
    try {
      const sk = nostrSkSync();
      if (sk) await navigator.clipboard?.writeText(toNsec(sk));
    } catch {}
    dismissSkBackupNotice();
  }, [dismissSkBackupNotice]);

  const rotateNostrKey = useCallback(() => {
    const sk = generateSecretKey();
    const skHex = bytesToHex(sk);
    setNostrSK(sk);
    const pk = getPublicKey(sk);
    setNostrPK(pk);
    void nostrSkSet(skHex);
    return toNsec(skHex);
  }, []);

  const applyCustomNostrKey = useCallback((key: string, options?: { silent?: boolean }): boolean => {
    try {
      const normalized = normalizeSecretKeyInput(key);
      if (!normalized) throw new Error("invalid");
      const sk = hexToBytes(normalized);
      setNostrSK(sk);
      const pk = getPublicKey(sk);
      setNostrPK(pk);
      void nostrSkSet(normalized);
      return true;
    } catch {
      if (!options?.silent) {
        alert("Invalid private key");
      }
      return false;
    }
  }, []);

  const setCustomNostrKey = useCallback((key: string) => {
    applyCustomNostrKey(key);
  }, [applyCustomNostrKey]);

  const lastNostrCreated = useRef<Map<string, number>>(new Map());
  const nostrPublishQueue = useRef<Promise<unknown>>(Promise.resolve());
  const lastNostrSentMs = useRef(0);
  const nostrPublish = useCallback(async (
    relays: string[],
    template: EventTemplate,
    options?: { sk?: Uint8Array | string; returnEvent?: boolean },
  ) => {
    const run = async () => {
      const nowMs = Date.now();
      const elapsed = nowMs - lastNostrSentMs.current;
      if (elapsed < NOSTR_MIN_EVENT_INTERVAL_MS) {
        await new Promise((resolve) => setTimeout(resolve, NOSTR_MIN_EVENT_INTERVAL_MS - elapsed));
      }
      const now = Math.floor(Date.now() / 1000);
      let createdAt = typeof template.created_at === "number" ? template.created_at : now;
      const signer = options?.sk || nostrSK;
      const signerBytes =
        typeof signer === "string"
          ? (() => {
              const trimmed = signer.trim();
              if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
                return hexToBytes(trimmed.toLowerCase());
              }
              if (trimmed.startsWith("nsec")) {
                const decoded = nip19.decode(trimmed);
                if (decoded.type === "nsec" && decoded.data) {
                  const decodedHex = bytesLikeToHex(decoded.data);
                  if (decodedHex) return hexToBytes(decodedHex);
                }
              }
              throw new Error("Invalid Nostr signer key");
            })()
          : signer;
      const signerKey = bytesToHex(signerBytes);
      const lastForSigner = lastNostrCreated.current.get(signerKey) || 0;
      if (createdAt <= lastForSigner) {
        createdAt = lastForSigner + 1;
      }
      lastNostrCreated.current.set(signerKey, createdAt);
      const ev = finalizeEvent({ ...template, created_at: createdAt }, signerBytes);
      pool.publishEvent(relays, ev as unknown as NostrEvent);
      lastNostrSentMs.current = Date.now();
      return options?.returnEvent ? { createdAt, event: ev as unknown as NostrEvent } : createdAt;
    };
    const next = nostrPublishQueue.current.catch(() => {}).then(run);
    nostrPublishQueue.current = next.then(() => {}, () => {});
    return next;
  }, [nostrSK, pool]) as NostrPublishFn;
  const nostrPublishRef = useRef<NostrPublishFn>(nostrPublish);
  nostrPublishRef.current = nostrPublish;

  return {
    applyCustomNostrKey,
    copyNsecAndDismiss,
    dismissSkBackupNotice,
    nostrPK,
    nostrPublish,
    nostrPublishRef,
    nostrSK,
    nostrSkHex,
    pool,
    rotateNostrKey,
    setCustomNostrKey,
    showSkBackupNotice,
  };
}
