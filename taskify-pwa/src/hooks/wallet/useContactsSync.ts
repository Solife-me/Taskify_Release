// @ts-nocheck
import { useCallback } from "react";
import { nip44, finalizeEvent } from "nostr-tools";
import type { EventTemplate } from "nostr-tools";
import { hexToBytes } from "@noble/hashes/utils.js";
import { normalizeNostrPubkey } from "../../lib/nostr";
import {
  saveContactsToStorage,
  loadContactsFromStorage,
  mergeContactsFromSync,
  parseContactSyncEnvelope,
  contactHasNpub,
  formatContactNpub,
  makeContactId,
  sanitizeUsername,
  type Contact,
  type ContactProfile,
  type ContactSyncEnvelope,
} from "../../lib/contacts";
import {
  fetchLatestPrivateContactsList,
  publishNip51PrivateContactsList,
  type Nip51PrivateContact,
} from "../../lib/nip51Contacts";
import { publishMyProfile, loadMyLatestProfileEvent } from "../../nostr/ProfilePublisher";
import {
  loadContactProfileCache,
  persistContactProfileCache,
  parseProfileContent,
  isDataUrl,
  shouldCacheProfilePhoto,
  fetchProfilePhotoDataUrl,
  extractPublicFollowsFromTags,
  enrichPublicFollowsWithProfiles,
  persistProfileMetadataCache,
  readProfileMetadataCache,
  type CachedContactProfile,
  type PublicFollow,
  type NostrIdentity,
} from "../../wallet/walletModalHelpers";
import { idbKeyValue } from "../../storage/idbKeyValue";
import { TASKIFY_STORE_NOSTR } from "../../storage/taskifyDb";
import { LS_NIP51_CONTACTS_MIGRATED } from "../../localStorageKeys";

export function useContactsSync({
  contactsSyncEnabled,
  walletDebugEnabled,
  nostrMissingReason,
  // from useContactsState
  setContacts,
  contactsRef,
  contactSyncMetaRef,
  contactSyncMeta,
  setContactSyncState,
  contactsPublishQueuedRef,
  setContactsPublishState,
  setContactsPublishMessage,
  contactsFingerprintRef,
  nip51MigrationInFlightRef,
  computeContactsFingerprint,
  persistContactSyncMeta,
  compressedToRawHex,
  setProfileStatus,
  setProfileMessage,
  setProfileForm,
  setProfileSharePayload,
  setProfileUpdatedAt,
  profileEventIdRef,
  profileFormRef,
  formatNpub,
  setProfilePhotoError,
  // from useNostrPoolState
  ensureNostrIdentity,
  defaultNostrRelays,
  ensureNostrPool,
  safePublish,
  persistProfileEventId,
  readProfileEventId,
  // callback still in component at extraction time
  deriveDefaultLightningAddress,
}) {
  const readNip51ContactsMigrated = useCallback((): boolean => {
    try {
      return idbKeyValue.getItem(TASKIFY_STORE_NOSTR, LS_NIP51_CONTACTS_MIGRATED) === "true";
    } catch {
      return false;
    }
  }, []);

  const persistNip51ContactsMigrated = useCallback((value: boolean) => {
    try {
      idbKeyValue.setItem(TASKIFY_STORE_NOSTR, LS_NIP51_CONTACTS_MIGRATED, value ? "true" : "false");
    } catch {
      // ignore persistence issues
    }
  }, []);

  const contactPubkeyKey = useCallback(
    (npub: string | null | undefined): string | null => {
      const normalized = normalizeNostrPubkey(npub || "");
      if (!normalized) return null;
      return compressedToRawHex(normalized).toLowerCase();
    },
    [compressedToRawHex, normalizeNostrPubkey],
  );

  const mergeContactsByPubkey = useCallback(
    (base: Contact[], incoming: Contact[]): Contact[] => {
      const next = [...base];
      const seen = new Set<string>();
      base.forEach((contact) => {
        const key = contactPubkeyKey(contact.npub);
        if (key) seen.add(key);
      });
      incoming.forEach((contact) => {
        const key = contactPubkeyKey(contact.npub);
        if (!key || seen.has(key)) return;
        seen.add(key);
        next.push(contact);
      });
      return next;
    },
    [contactPubkeyKey],
  );

  const buildContactSyncEnvelopeFromNip51 = useCallback(
    (privateContacts: Nip51PrivateContact[], updatedAt: number): ContactSyncEnvelope => {
      return {
        version: 1,
        updatedAt,
        contacts: (privateContacts || []).map((contact) => ({
          id: makeContactId(),
          kind: "nostr",
          npub: formatContactNpub(contact.pubkey),
          relays: contact.relayHint ? [contact.relayHint] : undefined,
          name: contact.petname || undefined,
        })),
      };
    },
    [formatContactNpub, makeContactId],
  );

  const loadLegacyContacts = useCallback(
    async (identity: NostrIdentity, relays: string[]): Promise<Contact[]> => {
      const localContacts = loadContactsFromStorage().filter((contact) => contactHasNpub(contact));
      let legacyFromEvent: Contact[] = [];
      if (nip44?.v2) {
        try {
          const pool = ensureNostrPool();
          const legacyEvent = await pool.get(relays, { kinds: [3], authors: [identity.pubkey] });
          if (legacyEvent?.content?.trim()) {
            const conversationKey = nip44.v2.utils.getConversationKey(hexToBytes(identity.secret), identity.pubkey);
            const plaintext = await nip44.v2.decrypt(legacyEvent.content, conversationKey);
            const parsed = parseContactSyncEnvelope(JSON.parse(plaintext));
            if (parsed) {
              legacyFromEvent = mergeContactsFromSync([], parsed).filter((contact) => contactHasNpub(contact));
            }
          }
        } catch (err) {
          if (walletDebugEnabled) {
            console.warn("[wallet] Failed to read legacy contacts payload", err);
          }
        }
      }
      return mergeContactsByPubkey(localContacts, legacyFromEvent);
    },
    [
      contactHasNpub,
      ensureNostrPool,
      loadContactsFromStorage,
      mergeContactsByPubkey,
      mergeContactsFromSync,
      parseContactSyncEnvelope,
      walletDebugEnabled,
    ],
  );

  const migrateNip51ContactsIfNeeded = useCallback(
    async (options?: { silent?: boolean }) => {
      if (nip51MigrationInFlightRef.current) return;
      if (readNip51ContactsMigrated()) return;
      if (!contactsSyncEnabled) return;
      const identity = ensureNostrIdentity();
      if (!identity) return;
      if (!nip44?.v2) return;
      const relays = defaultNostrRelays
        .map((url) => (typeof url === "string" ? url.trim() : ""))
        .filter(Boolean);
      if (!relays.length) return;

      nip51MigrationInFlightRef.current = true;
      try {
        const legacyContacts = await loadLegacyContacts(identity, relays);
        if (!legacyContacts.length) {
          persistNip51ContactsMigrated(true);
          if (walletDebugEnabled) {
            console.debug("[wallet] NIP-51 migration: no legacy contacts to migrate");
          }
          return;
        }
        const merged = mergeContactsByPubkey(contactsRef.current, legacyContacts);
        if (merged.length !== contactsRef.current.length) {
          setContacts(merged);
          saveContactsToStorage(merged);
          contactsRef.current = merged;
        }

        const pool = ensureNostrPool();
        const nip51Event = await publishNip51PrivateContactsList(pool, relays, merged, {
          privateKeyHex: identity.secret,
          publicKeyHex: identity.pubkey,
        });
        const updatedAt = nip51Event.created_at ? nip51Event.created_at * 1000 : Date.now();
        const fingerprint = computeContactsFingerprint(merged);
        contactsFingerprintRef.current = fingerprint;
        persistContactSyncMeta({
          lastEventId: nip51Event.id,
          lastUpdatedAt: updatedAt,
          fingerprint,
          publicFollows: contactSyncMetaRef.current.publicFollows,
        });
        persistNip51ContactsMigrated(true);
        if (!options?.silent) {
          setContactSyncState({
            status: "success",
            message: "Contacts migrated to NIP-51",
            updatedAt,
          });
        }
        if (walletDebugEnabled) {
          console.debug("[wallet] NIP-51 migration published", nip51Event.id.slice(0, 8));
        }
      } catch (err: any) {
        if (!options?.silent) {
          setContactSyncState((prev) => ({
            status: "error",
            message: err?.message || "Unable to migrate legacy contacts.",
            updatedAt: prev.updatedAt ?? null,
          }));
        }
        if (walletDebugEnabled) {
          console.warn("[wallet] NIP-51 migration failed", err);
        }
      } finally {
        nip51MigrationInFlightRef.current = false;
      }
    },
    [
      computeContactsFingerprint,
      contactSyncMetaRef,
      contactsRef,
      contactsSyncEnabled,
      defaultNostrRelays,
      ensureNostrIdentity,
      ensureNostrPool,
      loadLegacyContacts,
      mergeContactsByPubkey,
      publishNip51PrivateContactsList,
      persistContactSyncMeta,
      persistNip51ContactsMigrated,
      readNip51ContactsMigrated,
      saveContactsToStorage,
      setContacts,
      walletDebugEnabled,
    ],
  );

  const syncContactsFromNostr = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent === true;
      if (!contactsSyncEnabled) {
        contactsPublishQueuedRef.current = false;
        if (!silent) {
          setContactSyncState({
            status: "error",
            message: "Contact sync is disabled in Settings.",
            updatedAt: contactSyncMeta.lastUpdatedAt ?? null,
          });
        }
        return;
      }
      const identity = ensureNostrIdentity();
      if (!identity) {
        if (!silent) {
          setContactSyncState({
            status: "error",
            message: nostrMissingReason || "Add your Taskify Nostr key in Settings → Nostr to sync contacts.",
            updatedAt: contactSyncMeta.lastUpdatedAt ?? null,
          });
        }
        return;
      }
      if (!nip44?.v2) {
        if (!silent) {
          setContactSyncState({
            status: "error",
            message: "NIP-44 v2 support is required to read contacts.",
            updatedAt: contactSyncMeta.lastUpdatedAt ?? null,
          });
        }
        return;
      }
      const relays = defaultNostrRelays
        .map((url) => (typeof url === "string" ? url.trim() : ""))
        .filter(Boolean);
      if (!relays.length) {
        if (!silent) {
          setContactSyncState({
            status: "error",
            message: "Add at least one relay to sync contacts.",
            updatedAt: contactSyncMeta.lastUpdatedAt ?? null,
          });
        }
        return;
      }
      if (!silent) {
        setContactSyncState({
          status: "loading",
          message: "Syncing contacts…",
          updatedAt: contactSyncMeta.lastUpdatedAt ?? null,
        });
      }
      try {
        await migrateNip51ContactsIfNeeded({ silent: true });
        const pool = ensureNostrPool();
        const [publicEvent, privateResult] = await Promise.all([
          pool.get(relays, { kinds: [3], authors: [identity.pubkey] }),
          fetchLatestPrivateContactsList(pool, relays, identity.pubkey, {
            privateKeyHex: identity.secret,
            publicKeyHex: identity.pubkey,
          }),
        ]);

        let publicFollows = contactSyncMeta.publicFollows ?? [];
        if (publicEvent) {
          const existingFollowsByKey = new Map(
            (contactSyncMeta.publicFollows || []).map((follow) => [follow.pubkey.toLowerCase(), follow]),
          );
          const publicFollowsFromTags = extractPublicFollowsFromTags(publicEvent.tags).map((follow) => {
            const existing = existingFollowsByKey.get(follow.pubkey.toLowerCase());
            if (!existing) return follow;
            return { ...existing, ...follow };
          });
          publicFollows = await enrichPublicFollowsWithProfiles(publicFollowsFromTags, relays, pool);
          persistContactSyncMeta({ publicFollows });
        }

        if (!privateResult.event) {
          if (!silent) {
            setContactSyncState({
              status: "idle",
              message: "No private contacts found on relays yet.",
              updatedAt: contactSyncMeta.lastUpdatedAt ?? null,
            });
          }
          return;
        }

        const updatedAt = privateResult.event.created_at ? privateResult.event.created_at * 1000 : Date.now();
        const envelope = buildContactSyncEnvelopeFromNip51(privateResult.contacts, updatedAt);
        const merged = mergeContactsFromSync(contactsRef.current, envelope);
        setContacts(merged);
        saveContactsToStorage(merged);
        const fingerprint = computeContactsFingerprint(merged);
        contactsFingerprintRef.current = fingerprint;
        persistContactSyncMeta({
          lastEventId: privateResult.event.id,
          lastUpdatedAt: updatedAt,
          fingerprint,
          publicFollows,
        });
        contactsPublishQueuedRef.current = false;
        setContactSyncState({
          status: "success",
          message: `Synced ${envelope.contacts.length} contact${envelope.contacts.length === 1 ? "" : "s"}`,
          updatedAt,
        });
      } catch (err: any) {
        if (!silent) {
          setContactSyncState({
            status: "error",
            message: err?.message || "Failed to sync contacts.",
            updatedAt: contactSyncMeta.lastUpdatedAt ?? null,
          });
        }
      }
    },
    [
      contactsSyncEnabled,
      contactSyncMeta.lastUpdatedAt,
      contactSyncMeta.publicFollows,
      contactsRef,
      buildContactSyncEnvelopeFromNip51,
      fetchLatestPrivateContactsList,
      migrateNip51ContactsIfNeeded,
      defaultNostrRelays,
      ensureNostrIdentity,
      ensureNostrPool,
      nostrMissingReason,
      persistContactSyncMeta,
      setContacts,
      saveContactsToStorage,
      mergeContactsFromSync,
      computeContactsFingerprint,
    ],
  );

  const publishContactsToNostr = useCallback(
    async (options?: { silent?: boolean; publicFollowsOverride?: PublicFollow[] }) => {
      const silent = options?.silent === true;
      const meta = contactSyncMetaRef.current;
      if (!contactsSyncEnabled) {
        contactsPublishQueuedRef.current = false;
        setContactsPublishState("idle");
        if (!silent) {
          setContactSyncState({
            status: "error",
            message: "Contact sync is disabled in Settings.",
            updatedAt: meta.lastUpdatedAt ?? null,
          });
        }
        return;
      }
      const identity = ensureNostrIdentity();
      if (!identity) {
        if (!silent) {
          setContactsPublishState("error");
          setContactsPublishMessage(nostrMissingReason || "Add your Taskify Nostr key in Settings → Nostr to sync contacts.");
        }
        return;
      }
      if (!nip44?.v2) {
        setContactsPublishState("error");
        setContactsPublishMessage("NIP-44 v2 support is required to encrypt contacts.");
        return;
      }
      const relays = defaultNostrRelays
        .map((url) => (typeof url === "string" ? url.trim() : ""))
        .filter(Boolean);
      if (!relays.length) {
        setContactsPublishState("error");
        setContactsPublishMessage("Add at least one relay to sync contacts.");
        return;
      }
      const fingerprint = computeContactsFingerprint(contactsRef.current);
      contactsFingerprintRef.current = fingerprint;
      const publicFollows = options?.publicFollowsOverride ?? meta.publicFollows ?? [];
      const shouldPublishPrivateList = !(meta.fingerprint && meta.lastUpdatedAt && meta.fingerprint === fingerprint);
      const shouldPublishPublicFollows = options?.publicFollowsOverride !== undefined || shouldPublishPrivateList;
      if (!shouldPublishPrivateList && !shouldPublishPublicFollows) {
        setContactsPublishState("success");
        setContactsPublishMessage("Contacts already synced");
        if (!silent) {
          setContactSyncState({
            status: "success",
            message: "Contacts already synced",
            updatedAt: meta.lastUpdatedAt,
          });
        }
        contactsPublishQueuedRef.current = false;
        return;
      }
      const updatedAt = Date.now();
      const publicFollowTags = publicFollows
        .map((follow) => {
          const pubkey = (follow.pubkey || "").trim();
          if (!pubkey) return null;
          const relay = (follow.relay || "").trim();
          const petname = (follow.petname || "").trim();
          const tag: string[] = ["p", pubkey];
          if (relay || petname) {
            tag.push(relay);
          }
          if (petname) {
            if (!relay) {
              tag.push("");
            }
            tag.push(petname);
          }
          return tag;
        })
        .filter(Boolean) as string[][];
      try {
        setContactsPublishState("publishing");
        setContactsPublishMessage("");
        const pool = ensureNostrPool();
        const createdAt = Math.floor(updatedAt / 1000);
        let nip51Event: { id: string; created_at?: number } | null = null;
        if (shouldPublishPrivateList) {
          nip51Event = await publishNip51PrivateContactsList(pool, relays, contactsRef.current, {
            privateKeyHex: identity.secret,
            publicKeyHex: identity.pubkey,
          }, {
            createdAt,
          });
          if (walletDebugEnabled) {
            console.debug("[wallet] Published NIP-51 contacts list", nip51Event.id.slice(0, 8));
          }
        }
        if (shouldPublishPublicFollows) {
          const template: EventTemplate = {
            kind: 3,
            content: "",
            tags: publicFollowTags,
            created_at: createdAt,
          };
          if (template.content !== "") {
            throw new Error("Kind:3 content must be empty.");
          }
          const signed = finalizeEvent(template, hexToBytes(identity.secret));
          await safePublish(pool, relays, signed);
          if (walletDebugEnabled) {
            console.debug("[wallet] Published kind:3 follows", signed.id.slice(0, 8));
          }
        }
        if (shouldPublishPrivateList && nip51Event) {
          const publishedAt = nip51Event.created_at ? nip51Event.created_at * 1000 : updatedAt;
          persistContactSyncMeta({
            lastEventId: nip51Event.id,
            lastUpdatedAt: publishedAt,
            fingerprint,
            publicFollows,
          });
          setContactSyncState({
            status: "success",
            message: "Contacts synced",
            updatedAt: publishedAt,
          });
        } else {
          persistContactSyncMeta({ publicFollows });
          if (!silent) {
            setContactSyncState({
              status: "success",
              message: "Public follows synced",
              updatedAt: meta.lastUpdatedAt ?? null,
            });
          }
        }
        setContactsPublishState("success");
        setContactsPublishMessage("Contacts synced to relays");
        contactsPublishQueuedRef.current = false;
      } catch (err: any) {
        const message = err?.message || "Unable to sync contacts.";
        setContactsPublishState("error");
        setContactsPublishMessage(message);
        if (!silent) {
          setContactSyncState((prev) => ({
            status: "error",
            message,
            updatedAt: prev.updatedAt ?? null,
          }));
        }
        contactsPublishQueuedRef.current = false;
      }
    },
    [
      contactsSyncEnabled,
      contactsRef,
      defaultNostrRelays,
      ensureNostrIdentity,
      ensureNostrPool,
      contactSyncMetaRef,
      computeContactsFingerprint,
      nostrMissingReason,
      persistContactSyncMeta,
      safePublish,
      walletDebugEnabled,
      publishNip51PrivateContactsList,
    ],
  );

  const applyContactProfileUpdates = useCallback(
    (
      profilesByHex: Map<string, CachedContactProfile>,
      options?: { persistCache?: boolean; existingCache?: Record<string, CachedContactProfile> },
    ) => {
      if (!profilesByHex.size) return;
      setContacts((prev) => {
        let changed = false;
        const next = prev.map((contact) => {
          const normalizedNpub = normalizeNostrPubkey(contact.npub || "");
          const hex = normalizedNpub ? compressedToRawHex(normalizedNpub).toLowerCase() : null;
          if (!hex) return contact;
          const incoming = profilesByHex.get(hex);
          if (!incoming) return contact;
          const baseline = contact.updatedAt ?? contact.createdAt ?? 0;
          const isNewer = incoming.updatedAt > baseline;
          const fillMissing =
            !contact.picture ||
            !contact.displayName ||
            !contact.username ||
            !contact.address ||
            !contact.nip05 ||
            !contact.about ||
            !contact.name;
          if (!isNewer && !fillMissing) return contact;
          const { profile, updatedAt, pictureDataUrl } = incoming;
          let updatedContact = contact;
          let localChanged = false;
          const preferProfileName = contact.source !== "manual" || !contact.name?.trim();
          const nextName = profile.displayName || profile.username || contact.name;
          if (preferProfileName && nextName && nextName !== contact.name) {
            updatedContact = { ...updatedContact, name: nextName };
            localChanged = true;
          }
          const maybeUpdate = <K extends keyof Contact>(key: K, value: Contact[K] | undefined) => {
            if (!value) return;
            const current = updatedContact[key];
            const shouldUpdate = isNewer || !current || (typeof current === "string" && current.trim() === "");
            if (shouldUpdate && value !== current) {
              updatedContact = { ...updatedContact, [key]: value };
              localChanged = true;
            }
          };
          maybeUpdate("displayName", profile.displayName);
          maybeUpdate(
            "username",
            profile.username ? (sanitizeUsername(profile.username) as Contact["username"]) : updatedContact.username,
          );
          maybeUpdate("address", profile.lud16 as Contact["address"] | undefined);
          maybeUpdate("nip05", profile.nip05 as Contact["nip05"] | undefined);
          maybeUpdate("about", profile.about as Contact["about"] | undefined);
          const nextPictureRaw = typeof profile.picture === "string" ? profile.picture.trim() : "";
          const nextPicture = (pictureDataUrl || nextPictureRaw).trim();
          if (nextPicture && nextPicture !== (updatedContact.picture || "").trim()) {
            updatedContact = { ...updatedContact, picture: nextPicture };
            localChanged = true;
          }
          if (!localChanged) return contact;
          changed = true;
          return { ...updatedContact, updatedAt: isNewer ? updatedAt : baseline };
        });
        return changed ? next : prev;
      });
      if (options?.persistCache) {
        const nextCache = { ...(options.existingCache || {}) };
        profilesByHex.forEach(({ profile, updatedAt, pictureDataUrl }, hex) => {
          const existing = nextCache[hex];
          if (!existing || updatedAt > (existing.updatedAt ?? 0)) {
            nextCache[hex] = { profile, updatedAt, pictureDataUrl };
          } else if (pictureDataUrl && !existing.pictureDataUrl) {
            nextCache[hex] = { ...existing, pictureDataUrl };
          }
        });
        persistContactProfileCache(nextCache);
      }
    },
    [compressedToRawHex, normalizeNostrPubkey, sanitizeUsername],
  );

  const refreshContactProfiles = useCallback(async () => {
    const contactsList = contactsRef.current;
    if (!contactsList.length) return;

    const cachedProfiles = loadContactProfileCache();
    const cachedProfilesByHex = new Map<string, CachedContactProfile>();
    Object.entries(cachedProfiles).forEach(([hex, entry]) => {
      if (!hex || !entry?.profile) return;
      cachedProfilesByHex.set(hex.toLowerCase(), {
        profile: entry.profile,
        updatedAt: entry.updatedAt || 0,
        pictureDataUrl: entry.pictureDataUrl,
      });
    });
    if (cachedProfilesByHex.size) {
      applyContactProfileUpdates(cachedProfilesByHex);
    }

    const authorHexes: string[] = [];
    const seenAuthors = new Set<string>();
    const relays = new Set(
      defaultNostrRelays
        .map((url) => (typeof url === "string" ? url.trim() : ""))
        .filter((url): url is string => !!url),
    );
    contactsList.forEach((contact) => {
      const normalizedNpub = normalizeNostrPubkey(contact.npub);
      if (!normalizedNpub) return;
      const authorHex = compressedToRawHex(normalizedNpub).toLowerCase();
      if (!authorHex) return;
      if (!seenAuthors.has(authorHex)) {
        seenAuthors.add(authorHex);
        authorHexes.push(authorHex);
      }
      if (Array.isArray(contact.relays)) {
        contact.relays.forEach((relay) => {
          const trimmed = typeof relay === "string" ? relay.trim() : "";
          if (trimmed) {
            relays.add(trimmed);
          }
        });
      }
    });
    if (!authorHexes.length) return;
    const relayList = Array.from(relays);
    if (!relayList.length) return;
    try {
      const pool = ensureNostrPool();
      const events = await pool
        .querySync(relayList, { kinds: [0], authors: authorHexes })
        .then((res) => (Array.isArray(res) ? res : []))
        .catch(() => []);
      if (!events.length) return;
      const profilesByHex = new Map<string, CachedContactProfile>();
      const photoCacheTasks: Promise<void>[] = [];
      events.forEach((event) => {
        if (!event?.pubkey || typeof event.content !== "string") return;
        const hex = compressedToRawHex(event.pubkey).toLowerCase();
        if (!hex) return;
        const updatedAt = event.created_at ? event.created_at * 1000 : Date.now();
        const existing = profilesByHex.get(hex);
        if (existing && existing.updatedAt >= updatedAt) return;
        const profile = parseProfileContent(event.content);
        const cachedProfile = cachedProfiles[hex];
        const entry: CachedContactProfile = { profile, updatedAt };
        const pictureUrl = typeof profile.picture === "string" ? profile.picture.trim() : "";
        const cachedPictureUrl = typeof cachedProfile?.profile?.picture === "string"
          ? cachedProfile.profile.picture.trim()
          : "";
        if (pictureUrl) {
          if (isDataUrl(pictureUrl)) {
            entry.pictureDataUrl = pictureUrl;
          } else if (cachedProfile?.pictureDataUrl && pictureUrl === cachedPictureUrl) {
            entry.pictureDataUrl = cachedProfile.pictureDataUrl;
          } else if (shouldCacheProfilePhoto(pictureUrl)) {
            photoCacheTasks.push(
              fetchProfilePhotoDataUrl(pictureUrl).then((dataUrl) => {
                if (!dataUrl) return;
                const current = profilesByHex.get(hex);
                if (current && current.updatedAt === updatedAt) {
                  profilesByHex.set(hex, { ...current, pictureDataUrl: dataUrl });
                }
              }),
            );
          }
        }
        profilesByHex.set(hex, entry);
      });
      if (photoCacheTasks.length) {
        await Promise.allSettled(photoCacheTasks);
      }
      if (!profilesByHex.size) return;
      applyContactProfileUpdates(profilesByHex, { persistCache: true, existingCache: cachedProfiles });
    } catch (err) {
      console.warn("Failed to refresh contact profiles", err);
    }
  }, [
    applyContactProfileUpdates,
    compressedToRawHex,
    contactsRef,
    defaultNostrRelays,
    ensureNostrPool,
    normalizeNostrPubkey,
    parseProfileContent,
  ]);

  const publishProfileMetadata = useCallback(
    async (draft?: Partial<ContactProfile>) => {
      if (!contactsSyncEnabled) {
        setProfileStatus("error");
        setProfileMessage("Contact sync is disabled in Settings.");
        return null;
      }
      const identity = ensureNostrIdentity();
      if (!identity) {
        setProfileStatus("error");
        setProfileMessage(nostrMissingReason || "Add your Taskify Nostr key in Settings → Nostr.");
        return null;
      }
      const relays = defaultNostrRelays
        .map((url) => (typeof url === "string" ? url.trim() : ""))
        .filter(Boolean);
      if (!relays.length) {
        setProfileStatus("error");
        setProfileMessage("Add at least one relay to publish your profile.");
        return null;
      }
      if (!profileEventIdRef.current) {
        profileEventIdRef.current = readProfileEventId(identity.pubkey);
      }
      const currentProfile = profileFormRef.current;
      const username = (draft?.username ?? currentProfile.username ?? "").trim();
      const displayName = (draft?.displayName ?? currentProfile.displayName ?? "").trim();
      const lud16 = (draft?.lud16 ?? currentProfile.lud16 ?? "").trim();
      const nip05 = (draft?.nip05 ?? currentProfile.nip05 ?? "").trim();
      const about = (draft?.about ?? currentProfile.about ?? "").trim();
      const hasDraftPicture = draft && "picture" in draft;
      const picture = (hasDraftPicture ? draft?.picture ?? "" : currentProfile.picture ?? "").trim();
      if (picture && isDataUrl(picture)) {
        setProfilePhotoError("Upload your profile photo before publishing.");
        setProfileStatus("error");
        setProfileMessage("Upload your profile photo before publishing.");
        return null;
      }
      try {
        setProfileStatus("publishing");
        setProfileMessage("");
        const result = await publishMyProfile(
          { username, displayName, lud16, nip05, about, picture },
          {
            signer: identity.secret,
            pubkey: identity.pubkey,
            relays,
            previousIdHint: profileEventIdRef.current,
            reason: "superseded profile metadata",
          },
        );
        const event = result.event;
        const updatedAt = event?.created_at ? event.created_at * 1000 : Date.now();
        profileEventIdRef.current = event.id || null;
        persistProfileEventId(identity.pubkey, event.id || null);
        const nextProfile = { username, displayName, lud16, nip05, about, picture };
        persistProfileMetadataCache(identity.pubkey, {
          profile: nextProfile,
          updatedAt,
          eventId: event.id || null,
        });
        setProfileForm(nextProfile);
        setProfileUpdatedAt(updatedAt);
        setProfileStatus("ready");
        setProfileMessage("Profile saved");
        setProfileSharePayload(formatNpub(identity.pubkey));
        return event;
      } catch (err: any) {
        setProfileStatus("error");
        setProfileMessage(err?.message || "Unable to publish profile.");
        console.warn("[profile] Unable to publish profile metadata", err);
        return null;
      }
    },
    [
      contactsSyncEnabled,
      defaultNostrRelays,
      ensureNostrIdentity,
      formatNpub,
      nostrMissingReason,
      persistProfileEventId,
      persistProfileMetadataCache,
      readProfileEventId,
      setProfilePhotoError,
    ],
  );

  const loadProfileMetadata = useCallback(
    async () => {
      if (!contactsSyncEnabled) {
        setProfileStatus("error");
        setProfileMessage("Contact sync is disabled in Settings.");
        return null;
      }
      const identity = ensureNostrIdentity();
      if (!identity) {
        setProfileStatus("error");
        setProfileMessage(nostrMissingReason || "Add your Taskify Nostr key in Settings → Nostr.");
        return null;
      }
      const relays = defaultNostrRelays
        .map((url) => (typeof url === "string" ? url.trim() : ""))
        .filter(Boolean);
      if (!relays.length) {
        setProfileStatus("error");
        setProfileMessage("Add at least one relay to load your profile.");
        return null;
      }
      if (!profileEventIdRef.current) {
        profileEventIdRef.current = readProfileEventId(identity.pubkey);
      }
      const cached = readProfileMetadataCache(identity.pubkey);
      if (cached?.eventId && !profileEventIdRef.current) {
        profileEventIdRef.current = cached.eventId;
        persistProfileEventId(identity.pubkey, cached.eventId);
      }
      if (cached?.profile) {
        setProfileForm(cached.profile);
        setProfileSharePayload(identity ? formatNpub(identity.pubkey) : null);
        setProfileUpdatedAt(cached.updatedAt ?? null);
        setProfileStatus((prev) => (prev === "publishing" ? prev : "ready"));
        setProfileMessage("Refreshing profile…");
      } else {
        setProfileStatus("loading");
        setProfileMessage("Loading profile…");
      }
      try {
        const event = await loadMyLatestProfileEvent(identity.pubkey, relays, { timeoutMs: 8000 });
        if (event && typeof event.content === "string") {
          const meta = parseProfileContent(event.content);
          const updatedAt = event.created_at ? event.created_at * 1000 : Date.now();
          profileEventIdRef.current = event.id || null;
          persistProfileEventId(identity.pubkey, event.id || null);
          const nextProfile = {
            username: meta.username || profileFormRef.current.username || "",
            displayName: meta.displayName || meta.username || profileFormRef.current.displayName || "",
            lud16: meta.lud16 || profileFormRef.current.lud16 || deriveDefaultLightningAddress(),
            nip05: meta.nip05 || profileFormRef.current.nip05 || "",
            about: meta.about || profileFormRef.current.about || "",
            picture: meta.picture || profileFormRef.current.picture || "",
          };
          setProfileForm(nextProfile);
          setProfileSharePayload(identity ? formatNpub(identity.pubkey) : null);
          setProfileUpdatedAt(updatedAt);
          persistProfileMetadataCache(identity.pubkey, {
            profile: nextProfile,
            updatedAt,
            eventId: event.id || null,
          });
          setProfileStatus("ready");
          setProfileMessage("Profile loaded");
          return meta;
        }
        setProfileStatus("ready");
        setProfileMessage("No profile metadata found yet.");
        return null;
      } catch (err: any) {
        setProfileStatus("error");
        setProfileMessage(err?.message || "Unable to load profile.");
        return null;
      }
    },
    [
      contactsSyncEnabled,
      defaultNostrRelays,
      deriveDefaultLightningAddress,
      ensureNostrIdentity,
      formatNpub,
      nostrMissingReason,
      parseProfileContent,
      persistProfileMetadataCache,
      persistProfileEventId,
      readProfileMetadataCache,
      readProfileEventId,
    ],
  );

  return {
    readNip51ContactsMigrated,
    persistNip51ContactsMigrated,
    contactPubkeyKey,
    mergeContactsByPubkey,
    buildContactSyncEnvelopeFromNip51,
    loadLegacyContacts,
    migrateNip51ContactsIfNeeded,
    syncContactsFromNostr,
    publishContactsToNostr,
    applyContactProfileUpdates,
    refreshContactProfiles,
    publishProfileMetadata,
    loadProfileMetadata,
  };
}
