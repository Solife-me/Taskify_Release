import { useCallback, useMemo } from "react";
import { createNip17Rumor } from "taskify-core";
import { nip17Crypto } from "taskify-runtime-nostr";
import { LocalKeySigner } from "../../identity/signer";
import { giftWrapNip17Rumor, nip17TimestampSource, recipientInboxRelays } from "../../lib/nip17Messages";
import {
  isImageMime,
  probeImageDimensions,
  encryptAndUploadMessengerAttachment,
  MESSENGER_ATTACHMENT_ALGO,
} from "../../lib/messengerAttachmentCrypto";
import { parseFileServers, findServerEntry, DEFAULT_FILE_STORAGE_SERVER } from "../../lib/fileStorage";
import type { FileServerEntry, FileServerType } from "../../lib/fileStorage";
import type { NostrEvent } from "../chatHelpers";
import type { WalletDmMessage, PendingDmMessage, useDmState } from "./useDmState";
import type { useNostrSession } from "./useNostrSession";
import type { GroupChat } from "../../lib/groupChatState";

type DmState = ReturnType<typeof useDmState>;
type ChatSession = ReturnType<typeof useNostrSession>;

export interface UseDmSendOptions {
  nip17TimestampMode: "now" | "random";
  defaultNostrRelays: string[];
  ensureNostrPool: ChatSession["ensureNostrPool"];
  safePublish: ChatSession["safePublish"];
  readNostrIdentity: ChatSession["readNostrIdentity"];
  handleDmEvent: (event: NostrEvent) => Promise<void>;
  setDmReactions: DmState["setDmReactions"];
  setDmMessageActions: DmState["setDmMessageActions"];
  groupChatsRef: DmState["groupChatsRef"];
  setPendingMessages: DmState["setPendingMessages"];
  fileStorageServer: string;
  fileServers: string;
  encryptedFileStorageServer: string;
  encryptedFileServers: string;
  showToast: (message: string, duration?: number) => void;
}

export function useDmSend({
  nip17TimestampMode,
  defaultNostrRelays,
  ensureNostrPool,
  safePublish,
  readNostrIdentity,
  handleDmEvent,
  setDmReactions,
  setDmMessageActions,
  groupChatsRef,
  setPendingMessages,
  fileStorageServer,
  fileServers,
  encryptedFileStorageServer,
  encryptedFileServers,
  showToast,
}: UseDmSendOptions) {
  const resolveNip17Timestamp = useMemo(() => nip17TimestampSource(nip17TimestampMode), [nip17TimestampMode]);

  const resolveNip17Relays = useCallback(
    (recipientHex: string, fallbackRelays: string[]): Promise<string[]> => recipientInboxRelays(recipientHex, fallbackRelays),
    [],
  );

  const publishNip17Giftwraps = useCallback(
    async (options: {
      relays: string[];
      content: string;
      senderHex: string;
      recipientHex: string;
      senderSecret: string;
      publish: (event: NostrEvent) => Promise<void>;
      kind?: number;
      extraTags?: string[][];
      /** For group messages: all recipient hex pubkeys (excluding sender). */
      recipientHexes?: string[];
    }) => {
      const { content, senderHex, senderSecret, publish, kind, extraTags } = options;
      const account = new LocalKeySigner(senderSecret);
      const normalizedSender = senderHex.toLowerCase();
      if (account.pubkey !== normalizedSender) throw new Error("The sending key does not match this account.");
      const isGroupSend = Array.isArray(options.recipientHexes) && options.recipientHexes.length > 0;
      // The inner rumor carries the canonical message timestamp; group rumors tag every member
      // (taskify-core's createNip17Rumor).
      const rumor = createNip17Rumor(
        {
          sender: normalizedSender,
          recipients: isGroupSend ? options.recipientHexes! : [options.recipientHex],
          content,
          createdAt: Math.floor(Date.now() / 1000),
          kind: typeof kind === "number" ? kind : 14,
          group: isGroupSend,
          extraTags,
        },
        nip17Crypto,
      );
      const wraps = await giftWrapNip17Rumor(rumor, account, options.relays, resolveNip17Timestamp);
      // The self-addressed wrap lets callers show the message at once.
      let selfWrapEvent: NostrEvent | null = null;
      for (const { recipient, wrap } of wraps) {
        await publish(wrap as NostrEvent);
        if (recipient === normalizedSender) selfWrapEvent = wrap as NostrEvent;
      }
      return { selfWrapEvent };
    },
    [resolveNip17Timestamp],
  );
  const handleSendReaction = useCallback(
    async (msg: WalletDmMessage, emoji: string) => {
      try {
        const { identity } = readNostrIdentity();
        if (!identity) return;
        const senderHex = identity.pubkey.toLowerCase();

        // Optimistic update: immediately show the reaction on the sender's side.
        // Key by rumorEventId (the canonical NIP-17 inner event ID) so it matches
        // the key used when the self-wrap is later processed by handleDmEvent.
        const reactionKey = msg.rumorEventId || msg.eventId;
        const tempEventId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        setDmReactions((prev) => {
          const next = new Map(prev);
          const existing = next.get(reactionKey) || [];
          const filtered = existing.filter((r) => r.senderPubkey !== senderHex);
          if (emoji !== "-") filtered.push({ emoji, senderPubkey: senderHex, reactEventId: tempEventId });
          next.set(reactionKey, filtered);
          return next;
        });

        // Close the action panel immediately
        setDmMessageActions(null);

        // Now publish the reaction (for the recipient to see)
        const isGroup = !!msg.groupId;
        const groupMeta = isGroup ? groupChatsRef.current.find((g) => g.groupId === msg.groupId) : null;
        const groupRecipients = groupMeta ? groupMeta.members.filter((m) => m !== senderHex) : [];
        const recipientHex = isGroup ? groupRecipients[0] || "" : msg.peerPubkey.toLowerCase();
        const relayTargets = isGroup ? groupRecipients : [recipientHex];
        const allRelays = new Set<string>();
        for (const target of relayTargets) {
          const relays = await resolveNip17Relays(target, defaultNostrRelays);
          relays.forEach((r) => allRelays.add(r));
        }
        const publishRelays = Array.from(allRelays);
        if (!publishRelays.length) return;
        const pool = ensureNostrPool();
        const publish = (ev: NostrEvent) => safePublish(pool, publishRelays, ev);
        const authorPubkey = msg.senderPubkey || (msg.isIncoming ? msg.peerPubkey : senderHex);
        const { selfWrapEvent } = await publishNip17Giftwraps({
          relays: publishRelays,
          content: emoji,
          senderHex,
          recipientHex,
          senderSecret: identity.secret,
          publish,
          kind: 7,
          // Use rumorEventId (inner NIP-17 rumor ID) so other clients (0xchat, etc.) can match
          // the reaction to the correct message. The outer giftwrap id is ephemeral and differs
          // per recipient, so it cannot be used as the canonical message reference.
          extraTags: [["e", msg.rumorEventId || msg.eventId], ["p", authorPubkey]],
          ...(isGroup ? { recipientHexes: groupRecipients } : {}),
        });
        if (selfWrapEvent) await handleDmEvent(selfWrapEvent);
      } catch (err) {
        console.warn("[chat] reaction send failed", err);
      }
    },
    [defaultNostrRelays, ensureNostrPool, handleDmEvent, publishNip17Giftwraps, readNostrIdentity, resolveNip17Relays, safePublish, groupChatsRef, setDmReactions, setDmMessageActions],
  );
  const handleForwardMessage = useCallback(
    async (msg: WalletDmMessage, targetPeerPubkey: string) => {
      try {
        const { identity } = readNostrIdentity();
        if (!identity) return;
        const senderHex = identity.pubkey.toLowerCase();
        const recipientHex = targetPeerPubkey.toLowerCase();
        const relays = await resolveNip17Relays(recipientHex, defaultNostrRelays);
        if (!relays.length) return;
        const pool = ensureNostrPool();
        const publish = (ev: NostrEvent) => safePublish(pool, relays, ev);
        const { selfWrapEvent } = await publishNip17Giftwraps({
          relays,
          content: msg.content,
          senderHex,
          recipientHex,
          senderSecret: identity.secret,
          publish,
        });
        if (selfWrapEvent) await handleDmEvent(selfWrapEvent);
      } catch (err) {
        console.warn("[chat] forward failed", err);
      }
    },
    [defaultNostrRelays, ensureNostrPool, handleDmEvent, publishNip17Giftwraps, readNostrIdentity, resolveNip17Relays, safePublish],
  );
  const publishGroupSubjectUpdate = useCallback(
    async (group: GroupChat, subject: string) => {
      const { identity } = readNostrIdentity();
      if (!identity) return false;
      const senderHex = identity.pubkey.toLowerCase();
      const groupRecipients = group.members.filter((member) => member !== senderHex);
      if (!groupRecipients.length) return false;

      const allRelays = new Set<string>();
      for (const target of groupRecipients) {
        try {
          const relays = await resolveNip17Relays(target, defaultNostrRelays);
          relays.forEach((relay) => allRelays.add(relay));
        } catch (err) {
          console.warn("[chat] group rename relay resolve failed", err);
        }
      }
      const publishRelays = Array.from(allRelays);
      if (!publishRelays.length) return false;

      const pool = ensureNostrPool();
      const publish = (event: NostrEvent) => safePublish(pool, publishRelays, event);
      const { selfWrapEvent } = await publishNip17Giftwraps({
        relays: publishRelays,
        content: "",
        senderHex,
        recipientHex: groupRecipients[0] || "",
        senderSecret: identity.secret,
        publish,
        extraTags: [["subject", subject]],
        recipientHexes: groupRecipients,
      });
      if (selfWrapEvent) {
        await handleDmEvent(selfWrapEvent);
      }
      return true;
    },
    [defaultNostrRelays, ensureNostrPool, handleDmEvent, publishNip17Giftwraps, readNostrIdentity, resolveNip17Relays, safePublish],
  );

  // Resolve the active file-server entry for encrypted messenger attachments.
  // Mirrors the task EditModal selection pattern so the user's Settings choice
  // (originless / blossom / NIP-96) is honored.
  // Encrypted messenger attachments must go to the ENCRYPTED file server
  // (same one the task EditModal uses). nostr.build (the default public
  // server) content-sniffs uploads and returns 500 on opaque ciphertext.
  // Fall back to the public server only if no encrypted server is set.
  const resolveMessengerServerEntry = useCallback((): FileServerEntry => {
    const primaryUrl = encryptedFileStorageServer || fileStorageServer;
    const primaryServersRaw = encryptedFileServers || fileServers;
    const servers = parseFileServers(primaryServersRaw);
    const match = findServerEntry(servers, primaryUrl);
    if (match) return match;
    // If we have servers but no URL match, infer the type from the URL.
    const inferredType: FileServerType = /originless/i.test(primaryUrl)
      ? "originless"
      : /blossom/i.test(primaryUrl)
        ? "blossom"
        : "nip96";
    return {
      url: primaryUrl || DEFAULT_FILE_STORAGE_SERVER,
      type: inferredType,
    };
  }, [encryptedFileServers, encryptedFileStorageServer, fileServers, fileStorageServer]);

  // Send one or more encrypted file attachments as 0xchat-compatible kind-15
  // gift wraps. Each file produces a separate gift-wrap event (matching how
  // 0xchat sends multi-file batches) and a separate pending bubble so the user
  // sees per-file progress.
  const sendMessengerFileAttachments = useCallback(
    async (files: File[], peerPubkey: string) => {
      const trimmedFiles = files.filter((file) => file && file.size > 0);
      if (!trimmedFiles.length) return;
      const { identity, reason } = readNostrIdentity();
      if (!identity) {
        showToast(reason || "Add your Taskify Nostr key in Settings → Nostr.", 4000);
        return;
      }
      const senderHex = identity.pubkey.toLowerCase();
      // Detect group thread
      const groupMeta = groupChatsRef.current.find((g) => g.groupId === peerPubkey);
      const isGroup = !!groupMeta;
      const groupRecipients = isGroup ? groupMeta.members.filter((m) => m !== senderHex) : [];
      const recipientHex = isGroup ? groupRecipients[0] || "" : peerPubkey.toLowerCase();
      if (!isGroup && !/^[0-9a-f]{64}$/.test(recipientHex)) {
        showToast("Recipient pubkey is invalid.", 4000);
        return;
      }
      const serverEntry = resolveMessengerServerEntry();

      const allRelays = new Set<string>();
      const relayTargets = isGroup ? groupRecipients : [recipientHex];
      for (const target of relayTargets) {
        try {
          const relays = await resolveNip17Relays(target, defaultNostrRelays);
          relays.forEach((r) => allRelays.add(r));
        } catch (err) {
          console.warn("[chat] file attach relay resolve failed", err);
        }
      }
      const publishRelays = Array.from(allRelays);
      if (!publishRelays.length) {
        showToast("No relays available for NIP-17 inbox.", 4000);
        return;
      }
      const pool = ensureNostrPool();
      const publish = (event: NostrEvent) => safePublish(pool, publishRelays, event);

      for (const file of trimmedFiles) {
        const pendingId = crypto.randomUUID();
        const pendingCreatedAt = Math.floor(Date.now() / 1000);
        const mimeType = file.type || "application/octet-stream";
        const filename = file.name || "attachment";
        const previewUrl = isImageMime(mimeType) ? URL.createObjectURL(file) : undefined;

        setPendingMessages((prev) => [
          ...prev,
          {
            id: pendingId,
            content: "",
            peerPubkey: recipientHex,
            createdAt: pendingCreatedAt,
            status: "sending",
            file: {
              filename,
              mimeType,
              size: file.size,
              previewUrl,
              progress: 0,
              phase: "encrypting",
            },
          },
        ]);

        const updatePending = (patch: Partial<PendingDmMessage["file"]> & { status?: PendingDmMessage["status"] }) => {
          setPendingMessages((prev) =>
            prev.map((m) => {
              if (m.id !== pendingId) return m;
              const nextStatus = patch.status ?? m.status;
              const nextFile = m.file
                ? { ...m.file, ...patch, status: undefined as any }
                : m.file;
              if (nextFile) delete (nextFile as any).status;
              return { ...m, status: nextStatus, file: nextFile };
            }),
          );
        };

        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          // Probe image dimensions from the plaintext blob before we lose it.
          const dims = isImageMime(mimeType) ? await probeImageDimensions(file) : null;

          updatePending({ phase: "uploading", progress: 0 });

          const upload = await encryptAndUploadMessengerAttachment({
            data: bytes,
            mimeType,
            filename,
            serverEntry,
            nostrSkHex: identity.secret,
            onProgress: (progress) => updatePending({ progress }),
            width: dims?.width,
            height: dims?.height,
          });

          updatePending({ phase: "sending", progress: 1 });

          // 0xchat-compatible kind-15 rumor tags
          // (see nostr-dart lib/src/nips/nip_017.dart:69-72)
          const extraTags: string[][] = [
            ["file-type", upload.mimeType],
            ["encryption-algorithm", MESSENGER_ATTACHMENT_ALGO],
            ["decryption-key", upload.keyHex],
            ["decryption-nonce", upload.nonceHex],
          ];
          // Bonus metadata tags (ignored by 0xchat, useful for our own UI)
          if (upload.sha256) extraTags.push(["x", upload.sha256]);
          if (upload.size > 0) extraTags.push(["size", String(upload.size)]);
          if (upload.width && upload.height) {
            extraTags.push(["dim", `${upload.width}x${upload.height}`]);
          }
          if (filename) extraTags.push(["filename", filename]);
          if (isGroup && groupMeta?.name) {
            extraTags.push(["subject", groupMeta.name]);
          }

          const { selfWrapEvent } = await publishNip17Giftwraps({
            relays: publishRelays,
            content: upload.remoteUrl,
            senderHex,
            recipientHex,
            senderSecret: identity.secret,
            publish,
            kind: 15,
            extraTags,
            ...(isGroup ? { recipientHexes: groupRecipients } : {}),
          });
          if (selfWrapEvent) {
            await handleDmEvent(selfWrapEvent);
          }

          // Mark sent, then drop the pending entry after a short delay
          // (the real message from the self-wrap will already be in dmMessages).
          updatePending({ status: "sent" });
          setTimeout(() => {
            setPendingMessages((prev) =>
              prev.filter((m) => {
                if (m.id !== pendingId) return true;
                if (m.file?.previewUrl) URL.revokeObjectURL(m.file.previewUrl);
                return false;
              }),
            );
          }, 1500);
        } catch (err: any) {
          console.warn("[chat] file attach send failed", err);
          // Detect the nostr.build "won't accept opaque ciphertext" failure
          // pattern and show an actionable hint instead of the raw server
          // message. nostr.build scans uploads for valid media and rejects
          // encrypted blobs at ingest — users need an originless/blossom
          // server for encrypted attachments.
          const rawMsg = String(err?.message || "");
          const serverUrl = (serverEntry?.url || "").toLowerCase();
          const looksLikeNip96ContentScan =
            serverEntry?.type === "nip96" &&
            (/server error, please try again later/i.test(rawMsg) ||
              /upload failed \(5\d\d\)/i.test(rawMsg));
          const friendlyMessage = looksLikeNip96ContentScan
            ? `${serverUrl.replace(/^https?:\/\//, "") || "This NIP-96 server"} rejected the encrypted file. NIP-96 hosts (like nostr.build) scan uploads for valid media and block opaque ciphertext. Switch your encrypted file server to an originless or blossom host in Settings → Storage.`
            : rawMsg || "Failed to send attachment.";
          showToast(friendlyMessage, 6000);
          setPendingMessages((prev) =>
            prev.filter((m) => {
              if (m.id !== pendingId) return true;
              if (m.file?.previewUrl) URL.revokeObjectURL(m.file.previewUrl);
              return false;
            }),
          );
        }
      }
    },
    [
      defaultNostrRelays,
      ensureNostrPool,
      handleDmEvent,
      publishNip17Giftwraps,
      readNostrIdentity,
      resolveMessengerServerEntry,
      resolveNip17Relays,
      safePublish,
      setPendingMessages,
      showToast,
      groupChatsRef,
    ],
  );

  return {
    resolveNip17Timestamp,
    resolveNip17Relays,
    publishNip17Giftwraps,
    handleSendReaction,
    handleForwardMessage,
    publishGroupSubjectUpdate,
    resolveMessengerServerEntry,
    sendMessengerFileAttachments,
  };
}
