import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { generateSecretKey, nip19, verifyEvent, type EventTemplate } from "nostr-tools";
import { localEventSigner, type EventSigner } from "taskify-runtime-nostr";
import { DEFAULT_NOSTR_RELAYS } from "../lib/relays";
import { adoptLocalSecretKey, revealLocalSecretKey, useIdentity } from "../identity/identity";
import {
  createNostrPool,
  NOSTR_MIN_EVENT_INTERVAL_MS,
  type NostrEvent,
} from "../domains/nostr/nostrPool";
import { NostrSession } from "./NostrSession";
import { EventTimestampClock } from "../domains/nostr/eventTimestamps";

export type NostrPublishFn = {
  (relays: string[], template: EventTemplate, options?: { sk?: Uint8Array | string; republish?: boolean }): Promise<number>;
  (
    relays: string[],
    template: EventTemplate,
    options: { sk?: Uint8Array | string; returnEvent: true; republish?: boolean },
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

export function useNostrIdentity({ defaultRelays }: UseNostrIdentityParams) {
  const pool = useMemo(() => createNostrPool(), []);
  const identity = useIdentity();
  const nostrPK = identity?.pubkey ?? "";
  // Before sign-in, events this device signs (none are user-facing) use a throwaway key.
  const [throwawayKey] = useState(() => generateSecretKey());
  const nostrSK = useMemo<Uint8Array>(() => {
    const local = identity ? revealLocalSecretKey() : null;
    return local ? hexToBytes(local) : throwawayKey;
  }, [identity, throwawayKey]);
  const nostrSkHex = useMemo(() => bytesToHex(nostrSK), [nostrSK]);

  useEffect(() => {
    const relays = defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS);
    NostrSession.init(relays).catch((err) => {
      console.warn("Failed to initialize Nostr session", err);
    });
  }, [defaultRelays]);

  const rotateNostrKey = useCallback(async () => {
    const skHex = bytesToHex(generateSecretKey());
    await adoptLocalSecretKey(skHex, { createdHere: true });
  }, []);

  const applyCustomNostrKey = useCallback(async (key: string, options?: { silent?: boolean }): Promise<boolean> => {
    const normalized = normalizeSecretKeyInput(key);
    if (!normalized) {
      if (!options?.silent) alert("Invalid private key");
      return false;
    }
    await adoptLocalSecretKey(normalized);
    return true;
  }, []);

  const setCustomNostrKey = useCallback(async (key: string) => {
    await applyCustomNostrKey(key);
  }, [applyCustomNostrKey]);

  const eventTimestampClock = useRef(new EventTimestampClock());
  const nostrPublishQueue = useRef<Promise<unknown>>(Promise.resolve());
  const lastNostrSentMs = useRef(0);
  const nostrPublish = useCallback(async (
    relays: string[],
    template: EventTemplate,
    options?: { sk?: Uint8Array | string; returnEvent?: boolean; republish?: boolean },
  ) => {
    const run = async () => {
      const nowMs = Date.now();
      const elapsed = nowMs - lastNostrSentMs.current;
      if (elapsed < NOSTR_MIN_EVENT_INTERVAL_MS) {
        await new Promise((resolve) => setTimeout(resolve, NOSTR_MIN_EVENT_INTERVAL_MS - elapsed));
      }
      const now = Math.floor(Date.now() / 1000);
      let createdAt = typeof template.created_at === "number" ? template.created_at : now;
      // Board and other derived keys are passed in; the user's own events are signed by their
      // signer, wherever the key is held. Before sign-in a throwaway key stands in.
      const accountSigner = options?.sk ? null : identity?.signer ?? null;
      let signer: EventSigner;
      if (accountSigner) {
        createdAt = eventTimestampClock.current.next(accountSigner.pubkey, template as { kind: number; tags: string[][] }, createdAt, now);
        signer = accountSigner;
      } else {
        const keySource = options?.sk || nostrSK;
        const signerBytes =
          typeof keySource === "string"
            ? (() => {
                const trimmed = keySource.trim();
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
            : keySource;
        createdAt = eventTimestampClock.current.next(bytesToHex(signerBytes), template as { kind: number; tags: string[][] }, createdAt, now);
        signer = localEventSigner(signerBytes);
      }
      const event = await signer.sign({ ...template, created_at: createdAt });
      if (event.pubkey !== signer.pubkey || !verifyEvent(event)) throw new Error("The signer returned an invalid event.");
      await pool.publishEvent(relays, event, { republish: options?.republish, proofOfWorkSigner: signer });
      lastNostrSentMs.current = Date.now();
      return options?.returnEvent ? { createdAt, event } : createdAt;
    };
    const next = nostrPublishQueue.current.catch(() => {}).then(run);
    nostrPublishQueue.current = next.then(() => {}, () => {});
    return next;
  }, [identity, nostrSK, pool]) as NostrPublishFn;
  const nostrPublishRef = useRef<NostrPublishFn>(nostrPublish);
  nostrPublishRef.current = nostrPublish;

  return {
    applyCustomNostrKey,
    nostrPK,
    nostrPublish,
    nostrPublishRef,
    nostrSK,
    nostrSkHex,
    pool,
    rotateNostrKey,
    setCustomNostrKey,
  };
}
