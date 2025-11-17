import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { bytesToHex } from "@noble/hashes/utils";
import { generateSecretKey, nip19 } from "nostr-tools";
import { LS_P2PK_KEYS } from "../localStorageKeys";
import { normalizeNostrPubkey, deriveCompressedPubkeyFromSecret } from "../lib/nostr";

export type P2PKKey = {
  id: string;
  label?: string;
  publicKey: string;
  privateKey: string;
  createdAt: number;
  usedCount: number;
  lastUsedAt?: number;
};

type P2PKContextValue = {
  keys: P2PKKey[];
  primaryKeyId: string | null;
  primaryKey: P2PKKey | null;
  generateKeypair: (options?: { label?: string }) => P2PKKey;
  importFromNsec: (nsec: string, options?: { label?: string }) => P2PKKey;
  removeKey: (id: string) => void;
  setPrimaryKey: (id: string) => void;
  markKeyUsed: (pubkey: string, count?: number) => void;
  getPrivateKeyForPubkey: (pubkey: string) => string | null;
};

const defaultValue: P2PKContextValue = {
  keys: [],
  primaryKeyId: null,
  primaryKey: null,
  generateKeypair: () => {
    throw new Error("P2PKProvider missing");
  },
  importFromNsec: () => {
    throw new Error("P2PKProvider missing");
  },
  removeKey: () => {
    throw new Error("P2PKProvider missing");
  },
  setPrimaryKey: () => {
    throw new Error("P2PKProvider missing");
  },
  markKeyUsed: () => {
    throw new Error("P2PKProvider missing");
  },
  getPrivateKeyForPubkey: () => null,
};

const P2PKContext = createContext<P2PKContextValue>(defaultValue);

function normalizeStoredPubkey(value: string): string | null {
  if (!value) return null;
  const normalized = normalizeNostrPubkey(value);
  return normalized ? normalized.toLowerCase() : null;
}

function loadStoredKeys(): { keys: P2PKKey[]; primaryKeyId: string | null } {
  try {
    const raw = localStorage.getItem(LS_P2PK_KEYS);
    if (!raw) return { keys: [], primaryKeyId: null };
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.keys)
    ) {
      return { keys: [], primaryKeyId: null };
    }
    const keys = parsed.keys
      .map((item: any) => {
        if (!item) return null;
        const pubkey = normalizeStoredPubkey(item.publicKey);
        const priv = typeof item.privateKey === "string" ? item.privateKey : "";
        if (!pubkey || !/^[0-9a-f]{64}$/.test(priv)) return null;
        return {
          id: typeof item.id === "string" ? item.id : crypto.randomUUID(),
          label: typeof item.label === "string" ? item.label : undefined,
          publicKey: pubkey,
          privateKey: priv.toLowerCase(),
          createdAt:
            typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
              ? item.createdAt
              : Date.now(),
          usedCount:
            typeof item.usedCount === "number" && item.usedCount >= 0
              ? Math.floor(item.usedCount)
              : 0,
          lastUsedAt:
            typeof item.lastUsedAt === "number" && Number.isFinite(item.lastUsedAt)
              ? item.lastUsedAt
              : undefined,
        } satisfies P2PKKey;
      })
      .filter((key): key is P2PKKey => !!key);
    const primary =
      typeof parsed.primaryKeyId === "string" ? parsed.primaryKeyId : null;
    return { keys, primaryKeyId: primary };
  } catch {
    return { keys: [], primaryKeyId: null };
  }
}

export function P2PKProvider({ children }: { children: React.ReactNode }) {
  const initial = React.useMemo(loadStoredKeys, []);
  const [keys, setKeys] = useState<P2PKKey[]>(initial.keys);
  const [primaryKeyId, setPrimaryKeyId] = useState<string | null>(
    initial.primaryKeyId,
  );

  const persist = useCallback(
    (nextKeys: P2PKKey[], nextPrimary: string | null) => {
      setKeys(nextKeys);
      setPrimaryKeyId(nextPrimary);
      try {
        localStorage.setItem(
          LS_P2PK_KEYS,
          JSON.stringify({
            keys: nextKeys,
            primaryKeyId: nextPrimary,
          }),
        );
      } catch {
        // ignore persistence failures
      }
    },
    [],
  );

  const insertKey = useCallback(
    (privkeyHex: string, options?: { label?: string }) => {
      const normalizedPriv = privkeyHex.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(normalizedPriv)) {
        throw new Error("Invalid secret key");
      }
      const pubFromPriv = deriveCompressedPubkeyFromSecret(normalizedPriv);
      if (!pubFromPriv) {
        throw new Error("Unable to derive public key");
      }
      if (keys.some((k) => k.publicKey === pubFromPriv)) {
        throw new Error("Key already exists");
      }
      const record: P2PKKey = {
        id: crypto.randomUUID(),
        label: options?.label?.trim() || undefined,
        publicKey: pubFromPriv,
        privateKey: normalizedPriv,
        createdAt: Date.now(),
        usedCount: 0,
      };
      const nextKeys = [...keys, record];
      const nextPrimary = primaryKeyId ?? record.id;
      persist(nextKeys, nextPrimary);
      return record;
    },
    [keys, persist, primaryKeyId],
  );

  const generateKeypair = useCallback(
    (options?: { label?: string }) => {
      const skBytes = generateSecretKey();
      const privHex = bytesToHex(skBytes);
      return insertKey(privHex, options);
    },
    [insertKey],
  );

  const importFromNsec = useCallback(
    (nsec: string, options?: { label?: string }) => {
      const trimmed = nsec.trim();
      if (!trimmed) {
        throw new Error("Missing nsec");
      }
      let secretHex: string | null = null;
      if (trimmed.startsWith("nsec")) {
        try {
          const decoded = nip19.decode(trimmed);
          if (decoded.type === "nsec") {
            if (decoded.data instanceof Uint8Array) {
              secretHex = bytesToHex(decoded.data);
            } else if (typeof decoded.data === "string") {
              secretHex = decoded.data;
            }
          }
        } catch {
          throw new Error("Invalid nsec");
        }
      } else if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        secretHex = trimmed;
      }
      if (!secretHex) {
        throw new Error("Unsupported key format");
      }
      return insertKey(secretHex, options);
    },
    [insertKey],
  );

  const removeKey = useCallback(
    (id: string) => {
      const nextKeys = keys.filter((key) => key.id !== id);
      const nextPrimary =
        primaryKeyId && primaryKeyId === id
          ? nextKeys[nextKeys.length - 1]?.id ?? null
          : primaryKeyId;
      persist(nextKeys, nextPrimary);
    },
    [keys, persist, primaryKeyId],
  );

  const setPrimaryKey = useCallback(
    (id: string) => {
      if (keys.some((key) => key.id === id)) {
        persist(keys, id);
      }
    },
    [keys, persist],
  );

  const markKeyUsed = useCallback(
    (pubkey: string, count = 1) => {
      const normalized = normalizeStoredPubkey(pubkey);
      if (!normalized) return;
      const nextKeys = keys.map((key) => {
        if (key.publicKey !== normalized) return key;
        return {
          ...key,
          usedCount: key.usedCount + Math.max(1, count),
          lastUsedAt: Date.now(),
        };
      });
      persist(nextKeys, primaryKeyId);
    },
    [keys, persist, primaryKeyId],
  );

  const getPrivateKeyForPubkey = useCallback(
    (pubkey: string) => {
      const normalized = normalizeStoredPubkey(pubkey);
      if (!normalized) return null;
      const match = keys.find((key) => key.publicKey === normalized);
      return match?.privateKey ?? null;
    },
    [keys],
  );

  const primaryKey = useMemo(() => {
    if (!primaryKeyId) return keys[keys.length - 1] ?? null;
    return keys.find((key) => key.id === primaryKeyId) ?? keys[keys.length - 1] ?? null;
  }, [keys, primaryKeyId]);

  const value = useMemo<P2PKContextValue>(
    () => ({
      keys,
      primaryKeyId,
      primaryKey: primaryKey ?? null,
      generateKeypair,
      importFromNsec,
      removeKey,
      setPrimaryKey,
      markKeyUsed,
      getPrivateKeyForPubkey,
    }),
    [
      keys,
      primaryKeyId,
      primaryKey,
      generateKeypair,
      importFromNsec,
      removeKey,
      setPrimaryKey,
      markKeyUsed,
      getPrivateKeyForPubkey,
    ],
  );

  return <P2PKContext.Provider value={value}>{children}</P2PKContext.Provider>;
}

export function useP2PK() {
  return useContext(P2PKContext);
}
