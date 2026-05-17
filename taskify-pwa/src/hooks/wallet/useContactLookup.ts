// @ts-nocheck
import { useCallback } from "react";
import { nip19 } from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Contact, ContactProfile } from "../../lib/contacts";
import { makeContactId, normalizeContact } from "../../lib/contacts";
import type { ContactSharePayload } from "../../wallet/walletModalHelpers";
import { encodeContactPayload, parseProfileContent } from "../../wallet/walletModalHelpers";
import { normalizeNostrPubkey } from "../../lib/nostr";

export interface UseContactLookupOptions {
  compressedToRawHex: (hex: string) => string;
  contactLookupBusy: boolean;
  contactLookupInput: string;
  contactsPublishQueuedRef: React.MutableRefObject<boolean>;
  defaultNostrRelays: string[];
  ensureNostrPool: () => any;
  formatNpub: (pubkey: string) => string;
  setActiveContactId: (id: string) => void;
  setContactLookupBusy: (busy: boolean) => void;
  setContactLookupError: (error: string) => void;
  setContactLookupInput: (input: string) => void;
  setContactView: (view: string) => void;
  setContacts: React.Dispatch<React.SetStateAction<Contact[]>>;
  setPublicFollowPickerOpen: (open: boolean) => void;
  setScannerMessage: (message: string) => void;
  setScannedContact: (contact: Contact | null) => void;
  setShowScanner: (show: boolean) => void;
  upsertContact: (contact: any) => any;
}

export function useContactLookup({
  compressedToRawHex,
  contactLookupBusy,
  contactLookupInput,
  contactsPublishQueuedRef,
  defaultNostrRelays,
  ensureNostrPool,
  formatNpub,
  setActiveContactId,
  setContactLookupBusy,
  setContactLookupError,
  setContactLookupInput,
  setContactView,
  setContacts,
  setPublicFollowPickerOpen,
  setScannerMessage,
  setScannedContact,
  setShowScanner,
  upsertContact,
}: UseContactLookupOptions) {
  const parseNip05Address = useCallback((input: string | null | undefined) => {
    const value = input?.trim();
    if (!value) return null;
    const atIndex = value.indexOf("@");
    if (atIndex <= 0 || atIndex === value.length - 1) return null;
    const name = value.slice(0, atIndex).trim().toLowerCase();
    const domain = value.slice(atIndex + 1).trim().toLowerCase();
    if (!name || !domain) return null;
    return { name, domain, normalized: `${name}@${domain}` };
  }, []);

  const normalizeNip05 = useCallback(
    (value: string | null | undefined) => parseNip05Address(value)?.normalized ?? null,
    [parseNip05Address],
  );

  const resolveNip05Record = useCallback(
    async (value: string) => {
      const parsed = parseNip05Address(value);
      if (!parsed) {
        throw new Error("Invalid NIP-05 address.");
      }
      const { name, domain, normalized } = parsed;
      const searchParam = encodeURIComponent(name);
      const isLocalhost =
        /^localhost(?::\d+)?$/.test(domain) || /^127\.0\.0\.1(?::\d+)?$/.test(domain) || domain === "[::1]";

      const buildUrls = (scheme: "https" | "http") => [
        `${scheme}://${domain}/.well-known/nostr.json?name=${searchParam}`,
        `${scheme}://${domain}/.well-known/nostr.json`,
      ];

      const urls = [...buildUrls("https"), ...(isLocalhost ? [] : buildUrls("http"))];

      const resolveFromRecord = (
        record: any,
      ): { pubkey: string; relays?: string[]; nip05: string } | null => {
        const names = (record?.names as Record<string, unknown>) || {};
        const matched = normalizePubkeyCandidate(findPubkey(names));
        if (!matched) {
          return null;
        }
        let relayHints: string[] | undefined;
        const relaysRecord =
          record?.relays && typeof record.relays === "object" ? (record.relays as Record<string, unknown>) : null;
        if (relaysRecord && matched in relaysRecord) {
          const relays = relaysRecord[matched];
          if (Array.isArray(relays)) {
            relayHints = relays
              .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
              .filter(Boolean);
          }
        }
        return { pubkey: matched, relays: relayHints, nip05: normalized };
      };

      const workerBaseUrl =
        typeof window !== "undefined" && typeof (window as any).__TASKIFY_WORKER_BASE_URL__ === "string"
          ? (window as any).__TASKIFY_WORKER_BASE_URL__
          : "";

      const normalizePubkeyCandidate = (candidate: string | null | undefined): string | null => {
        if (!candidate) return null;
        const trimmed = candidate.trim();
        if (!trimmed) return null;

        // Try to decode any bech32 values first (npub/nprofile) to hex
        if (/^n(profile|pub)1[ac-hj-np-z02-9]+$/i.test(trimmed)) {
          try {
            const decoded = nip19.decode(trimmed.toLowerCase());
            if (decoded.type === "npub" && decoded.data) {
              if (typeof decoded.data === "string" && /^[0-9a-f]{64}$/i.test(decoded.data)) return decoded.data.toLowerCase();
              if (decoded.data instanceof Uint8Array) return bytesToHex(decoded.data).toLowerCase();
            }
            if (decoded.type === "nprofile" && decoded.data) {
              const pubkey = (decoded.data as any)?.pubkey;
              if (typeof pubkey === "string" && /^[0-9a-f]{64}$/i.test(pubkey)) {
                return pubkey.toLowerCase();
              }
            }
          } catch {
            // fall through to hex handling
          }
        }

        const hexMatch = trimmed.replace(/^0x/i, "");
        if (/^[0-9a-f]{64}$/i.test(hexMatch)) return hexMatch.toLowerCase();
        if (/^(02|03)[0-9a-f]{64}$/i.test(hexMatch)) return hexMatch.slice(-64).toLowerCase();
        return null;
      };

      const findPubkey = (names: Record<string, unknown>): string | null => {
        if (!names) return null;
        const directMatch = names[name];
        const lowerMatch = names[name.toLowerCase()];
        const wildcard = names._;
        const candidate =
          (typeof directMatch === "string" && directMatch) ||
          (typeof lowerMatch === "string" && lowerMatch) ||
          (typeof wildcard === "string" && wildcard);
        return candidate ? String(candidate) : null;
      };

      let lastError = "NIP-05 lookup failed";

      const fetchViaWorker = async (): Promise<{ pubkey: string; relays?: string[]; nip05: string } | null> => {
        const base = workerBaseUrl?.trim().replace(/\/$/, "");
        if (!base) return null;
        const workerUrl = `${base}/api/nip05?address=${encodeURIComponent(normalized)}`;
        try {
          const res = await fetch(workerUrl, {
            headers: { Accept: "application/json" },
            redirect: "follow",
            mode: "cors",
          });
          if (!res.ok) {
            lastError = `NIP-05 lookup failed (${res.status})`;
            return null;
          }
          const payload = await res.json();
          const candidate = resolveFromRecord(payload?.record ?? payload);
          if (candidate) return candidate;
          lastError = "Name not found in NIP-05 record.";
          return null;
        } catch (error: any) {
          lastError = error?.message || String(error);
          return null;
        }
      };

      const workerResolution = await fetchViaWorker();
      if (workerResolution) {
        return workerResolution;
      }

      for (const url of urls) {
        try {
          const res = await fetch(url, {
            headers: { Accept: "application/json" },
            redirect: "follow",
            mode: "cors",
          });
          if (!res.ok) {
            lastError = `NIP-05 lookup failed (${res.status})`;
            continue;
          }
          const data = await res.json();
          const resolved = resolveFromRecord(data);
          if (resolved) {
            return resolved;
          }
          lastError = "Name not found in NIP-05 record.";
        } catch (error: any) {
          lastError = error?.message || String(error);
        }
      }
      throw new Error(lastError);
    },
    [parseNip05Address],
  );

  const handleLookupContact = useCallback(async (overrideInput?: string) => {
    if (contactLookupBusy) return;
    const input = (overrideInput ?? contactLookupInput).trim();
    if (!input) {
      setContactLookupError("Enter a npub, hex key, or NIP-05 address.");
      return;
    }
    setContactLookupBusy(true);
    setContactLookupError("");
    try {
      let targetPubkeyHex: string | null = null;
      let relayHints: string[] | undefined;
      let resolvedNip05: string | null = null;
      const normalizedInputNip05 = normalizeNip05(input);
      if (input.includes("@") && !input.toLowerCase().startsWith("npub")) {
        const resolution = await resolveNip05Record(input);
        const normalizedPubkey = normalizeNostrPubkey(resolution.pubkey) ?? resolution.pubkey;
        targetPubkeyHex = normalizedPubkey;
        relayHints = resolution.relays;
        resolvedNip05 = resolution.nip05;
      } else {
        const normalized = normalizeNostrPubkey(input);
        if (!normalized) {
          throw new Error("Invalid npub or hex key.");
        }
        targetPubkeyHex = compressedToRawHex(normalized);
      }
      if (!targetPubkeyHex) {
        throw new Error("Unable to resolve contact key.");
      }
      const authorHex = compressedToRawHex(targetPubkeyHex);
      const pool = ensureNostrPool();
      const relayList = Array.from(
        new Set([
          ...(Array.isArray(relayHints) ? relayHints : []),
          ...defaultNostrRelays.map((url) => (typeof url === "string" ? url.trim() : "")),
        ].filter(Boolean)),
      );
      let profile: ContactProfile = {};
      if (relayList.length) {
        try {
          const profileEvent = await pool.get(relayList, { kinds: [0], authors: [authorHex] });
          if (profileEvent?.content) {
            profile = parseProfileContent(profileEvent.content);
          }
        } catch {
          // ignore profile fetch failure
        }
      }
      const newContact = upsertContact({
        kind: "nostr",
        npub: formatNpub(authorHex),
        name: profile.displayName || profile.username || input,
        displayName: profile.displayName,
        username: profile.username,
        address: profile.lud16 || "",
        nip05: profile.nip05 || resolvedNip05 || normalizedInputNip05 || "",
        picture: profile.picture,
        relays: relayHints,
        source: "profile",
        updatedAt: Date.now(),
      });
      if (!newContact) {
        throw new Error("Unable to save contact.");
      }
      setContactLookupInput("");
      contactsPublishQueuedRef.current = true;
      setActiveContactId(newContact.id);
      setContactView("detail");
    } catch (err: any) {
      setContactLookupError(err?.message || "Unable to add contact from profile.");
    } finally {
      setContactLookupBusy(false);
    }
  }, [
    compressedToRawHex,
    contactLookupBusy,
    contactLookupInput,
    defaultNostrRelays,
    ensureNostrPool,
    formatNpub,
    setActiveContactId,
    setContactView,
    normalizeNip05,
    normalizeNostrPubkey,
    resolveNip05Record,
    parseProfileContent,
    upsertContact,
  ]);

  const handleContactImportAction = useCallback(async () => {
    if (contactLookupBusy) return;
    const trimmedInput = contactLookupInput.trim();
    if (trimmedInput) {
      await handleLookupContact();
      return;
    }
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
        throw new Error("Clipboard access is not available.");
      }
      const pasted = await navigator.clipboard.readText();
      const nextValue = pasted.trim();
      if (!nextValue) {
        setContactLookupError("Clipboard is empty.");
        return;
      }
      setContactLookupError("");
      setContactLookupInput(nextValue);
    } catch (err: any) {
      const message = err?.message || "Unable to read from clipboard.";
      setContactLookupError(message);
    }
  }, [contactLookupBusy, contactLookupInput, handleLookupContact]);

  const handleImportPublicFollow = useCallback(
    async (npub: string) => {
      const trimmed = (npub || "").trim();
      if (!trimmed) return;
      setPublicFollowPickerOpen(false);
      setContactLookupInput(trimmed);
      await handleLookupContact(trimmed);
    },
    [handleLookupContact],
  );

    const handleScannedContactPayload = useCallback(
      async (payload: ContactSharePayload | { npub?: string; relays?: string[]; name?: string; displayName?: string; lud16?: string; nip05?: string; kind?: string }) => {
        const relayHints = Array.isArray((payload as any).relays)
          ? ((payload as any).relays as string[]).filter((r) => typeof r === "string" && r.trim())
          : undefined;
      const rawNpub = typeof (payload as any).npub === "string" ? (payload as any).npub.trim() : "";
      const normalizedHex = rawNpub ? normalizeNostrPubkey(rawNpub) : null;
      const scannedNpub = normalizedHex
        ? formatNpub(normalizedHex)
        : rawNpub.startsWith("npub")
          ? rawNpub
          : "";
      const authorHex = normalizedHex ? compressedToRawHex(normalizedHex) : null;
      let mergedProfile: ContactProfile = {
        username: (payload as any).name,
        displayName: (payload as any).displayName,
        lud16: (payload as any).lud16,
        nip05: (payload as any).nip05,
        picture: (payload as any).picture,
      };
      if (authorHex) {
        const relays = Array.from(
          new Set(
            [
              ...(relayHints || []),
              ...defaultNostrRelays.map((url) => (typeof url === "string" ? url.trim() : "")),
            ].filter(Boolean),
          ),
        );
        if (relays.length) {
          try {
            const pool = ensureNostrPool();
            const profileEvent = await pool.get(relays, { kinds: [0], authors: [authorHex] });
            if (profileEvent?.content) {
              mergedProfile = { ...mergedProfile, ...parseProfileContent(profileEvent.content) };
            }
          } catch {
            // ignore profile fetch failures
          }
        }
      }
      const candidateContact = normalizeContact({
        id: makeContactId(),
        kind: (payload as any).kind === "custom" && !authorHex ? "custom" : "nostr",
        npub: scannedNpub || (authorHex ? formatNpub(authorHex) : ""),
        name:
          mergedProfile.displayName ||
          mergedProfile.username ||
          (payload as any).name ||
          (payload as any).displayName ||
          rawNpub,
        displayName: mergedProfile.displayName || (payload as any).displayName,
        username: mergedProfile.username || (payload as any).name,
        address: mergedProfile.lud16 || (payload as any).lud16 || "",
        nip05: mergedProfile.nip05 || (payload as any).nip05,
        picture: mergedProfile.picture,
        relays: relayHints,
        source: "scan",
        updatedAt: Date.now(),
      });
      if (!candidateContact) {
        setScannerMessage("Contact code is missing usable details.");
        return;
      }
      setScannedContact(candidateContact);
      setShowScanner(false);
      setScannerMessage("");
    },
    [
      compressedToRawHex,
      defaultNostrRelays,
      ensureNostrPool,
      formatNpub,
      parseProfileContent,
      setScannerMessage,
      setShowScanner,
    ],
  );

  const handleDeleteContact = useCallback((id: string) => {
    setContacts((prev) => prev.filter((c) => c.id !== id));
    contactsPublishQueuedRef.current = true;
  }, []);

  const buildContactShareValue = useCallback(
    (contact: Contact): string | null => {
      const rawNpub = contact.npub?.trim() || "";
      const relays = contact.relays;
      const normalized = normalizeNostrPubkey(rawNpub);
      const npub = normalized ? formatNpub(normalized) : rawNpub.startsWith("npub") ? rawNpub : "";

      if (contact.kind === "custom") {
        const payload: ContactSharePayload = {
          v: 1,
          kind: "custom",
          npub: npub || undefined,
          relays,
          name: contact.name?.trim() || undefined,
          displayName: contact.displayName?.trim() || undefined,
          lud16: contact.address?.trim() || undefined,
          nip05: contact.nip05?.trim() || undefined,
        };
        return encodeContactPayload(payload);
      }

      if (npub) {
        return npub;
      }

      // Fallback: share whatever fields we have if npub is missing.
      return encodeContactPayload({
        v: 1,
        kind: contact.kind,
        npub: npub || undefined,
        relays,
        name: contact.name?.trim() || undefined,
        displayName: contact.displayName?.trim() || undefined,
        lud16: contact.address?.trim() || undefined,
        nip05: contact.nip05?.trim() || undefined,
      });
    },
    [encodeContactPayload, formatNpub],
  );

  return {
    parseNip05Address,
    normalizeNip05,
    resolveNip05Record,
    handleLookupContact,
    handleContactImportAction,
    handleImportPublicFollow,
    handleScannedContactPayload,
    handleDeleteContact,
    buildContactShareValue,
  };
}
