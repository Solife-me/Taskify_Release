/**
 * Chat: sending and receiving NIP-17 messages, and the attach-a-page flow.
 *
 * The panel is a chat client for the user's existing Taskify account. It talks to the same
 * relays, and uses the same wire format, as the PWA and the native apps, so a message sent from
 * the panel arrives in the PWA, on the phone, and in the agent's inbox.
 */
import { openNip17GiftWrap, type Nip17SignedEvent } from "taskify-core";
import type { NostrEvent } from "nostr-tools";
import { getSession, DEFAULT_RELAYS } from "./session";
import {
  attachmentTags,
  buildMessageWraps,
  decryptAttachment,
  encryptAttachment,
  nip17Account,
  nip17Crypto,
  nip17TimestampSource,
} from "./chatCrypto";
import { downloadFile, uploadEncryptedFile, DEFAULT_FILE_SERVERS, type FileServer } from "./fileUpload";
import { recipientInboxRelays } from "./inbox";

/** The kinds of rumor the panel understands. */
export const NIP17_CHAT_KIND = 14;
export const NIP17_FILE_KIND = 15;
export const NIP17_REACTION_KIND = 7;
export const NIP17_WRAP_KIND = 1059;

export type ChatAttachment = {
  type: "file";
  url: string;
  mimeType: string;
  filename: string;
  size: number;
  keyHex: string;
  nonceHex: string;
  algorithm: string;
  sha256?: string;
};

export type ChatMessage = {
  /** The rumor's id: the same for every recipient, so it identifies the message. */
  id: string;
  /** The outer wrap's id, which differs per recipient. */
  wrapId: string;
  senderPubkey: string;
  content: string;
  createdAt: number;
  kind: number;
  attachment?: ChatAttachment;
  /** True when this account sent the message. */
  outgoing: boolean;
};

function tagValue(tags: string[][], name: string): string | undefined {
  for (const tag of tags) {
    if (tag[0] === name && typeof tag[1] === "string" && tag[1]) return tag[1];
  }
  return undefined;
}

/** The attachment a kind-15 rumor carries, if any. */
function attachmentFromRumor(tags: string[][]): ChatAttachment | undefined {
  const url = tagValue(tags, "x") ?? undefined;
  const keyHex = tagValue(tags, "decryption-key");
  const nonceHex = tagValue(tags, "decryption-nonce");
  if (!keyHex || !nonceHex) return undefined;
  const sizeRaw = tagValue(tags, "size");
  return {
    type: "file",
    // The rumor's content is the URL of the uploaded ciphertext.
    url: "",
    mimeType: tagValue(tags, "file-type") ?? "application/octet-stream",
    filename: tagValue(tags, "filename") ?? "attachment",
    size: sizeRaw ? Number(sizeRaw) || 0 : 0,
    keyHex,
    nonceHex,
    algorithm: tagValue(tags, "encryption-algorithm") ?? "aes-gcm",
    sha256: tagValue(tags, "x"),
  };
}

export type ChatSendOptions = {
  secretKeyHex: string;
  pubkey: string;
  recipientPubkey: string;
  text?: string;
  /** A file to send instead of (or alongside) text. */
  file?: { data: Uint8Array; filename: string; mimeType: string };
  fileServers?: FileServer[];
  onUploadProgress?: (progress: number) => void;
};

/**
 * Sends a message to one peer.
 *
 * A file is encrypted, uploaded, and sent as a kind-15 rumor whose content is the ciphertext's
 * URL. A text message is a kind-14 rumor. The account also gets a copy in its own inbox, so the
 * message shows up in the panel without waiting for a relay round trip.
 */
export async function sendChatMessage(options: ChatSendOptions): Promise<ChatMessage> {
  const account = nip17Account(options.secretKeyHex, options.pubkey);
  const session = await getSession(DEFAULT_RELAYS);

  const inboxRelays = await recipientInboxRelays(options.recipientPubkey, DEFAULT_RELAYS);
  const relays = Array.from(new Set([...inboxRelays, ...DEFAULT_RELAYS]));

  let kind = NIP17_CHAT_KIND;
  let content = options.text?.trim() ?? "";
  let extraTags: string[][] | undefined;

  if (options.file) {
    const { ciphertext, meta } = await encryptAttachment({
      data: options.file.data,
      mimeType: options.file.mimeType,
      filename: options.file.filename,
    });
    options.onUploadProgress?.(0.1);

    let remoteUrl = "";
    const servers = options.fileServers?.length ? options.fileServers : DEFAULT_FILE_SERVERS;
    let lastError: unknown;
    for (const server of servers) {
      try {
        remoteUrl = await uploadEncryptedFile({
          server,
          data: ciphertext,
          filename: options.file.filename,
          mimeType: options.file.mimeType,
          secretKeyHex: options.secretKeyHex,
          onProgress: (progress) => options.onUploadProgress?.(0.1 + progress * 0.8),
        });
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!remoteUrl) {
      throw lastError instanceof Error ? lastError : new Error("The file could not be uploaded.");
    }
    options.onUploadProgress?.(1);

    kind = NIP17_FILE_KIND;
    content = remoteUrl;
    extraTags = attachmentTags(meta);
  }

  if (!content) throw new Error("There is nothing to send.");

  const timestamp = nip17TimestampSource("random");
  const wraps = await buildMessageWraps({
    account,
    senderPubkey: options.pubkey,
    recipientPubkeys: [options.recipientPubkey],
    message: { kind, content, extraTags },
    timestamp,
    signWrap: async (template, key) => {
      const event = await session.prepareEventWith(
        template as never,
        { pubkey: key.pubkey, sign: (t) => key.sign(t) },
        relays,
      );
      return event as unknown as Nip17SignedEvent;
    },
  });

  for (const { wrap } of wraps) {
    await session.publishRaw(wrap as unknown as NostrEvent);
  }

  const selfWrap = wraps.find((entry) => entry.recipient === options.pubkey);
  const opened = selfWrap ? await openNip17GiftWrap(selfWrap.wrap, account, nip17Crypto) : null;
  if (!opened) {
    return {
      id: "",
      wrapId: selfWrap?.wrap.id ?? "",
      senderPubkey: options.pubkey,
      content,
      createdAt: Math.floor(Date.now() / 1000),
      kind,
      outgoing: true,
      ...(kind === NIP17_FILE_KIND ? { attachment: { ...(attachmentFromRumor(extraTags ?? []) as ChatAttachment), url: content } } : {}),
    };
  }

  return messageFromOpened(opened, options.pubkey);
}

function messageFromOpened(
  opened: { wrapId: string; rumor: { id: string; content: string; created_at: number; kind: number; tags: string[][]; pubkey: string }; senderPubkey: string },
  myPubkey: string,
): ChatMessage {
  const attachment = opened.rumor.kind === NIP17_FILE_KIND ? attachmentFromRumor(opened.rumor.tags) : undefined;
  return {
    id: opened.rumor.id,
    wrapId: opened.wrapId,
    senderPubkey: opened.senderPubkey,
    content: opened.rumor.content,
    createdAt: opened.rumor.created_at,
    kind: opened.rumor.kind,
    outgoing: opened.senderPubkey === myPubkey,
    ...(attachment ? { attachment: { ...attachment, url: opened.rumor.content } } : {}),
  };
}

/** Reads the account's inbox: every gift wrap addressed to it. */
export async function fetchInbox(secretKeyHex: string, pubkey: string, limit = 100): Promise<ChatMessage[]> {
  const account = nip17Account(secretKeyHex, pubkey);
  const session = await getSession(DEFAULT_RELAYS);
  const events = await session.fetchEvents(
    [{ kinds: [NIP17_WRAP_KIND], "#p": [pubkey], limit }],
    DEFAULT_RELAYS,
    9000,
  );

  const messages: ChatMessage[] = [];
  for (const event of events) {
    const opened = await openNip17GiftWrap(event as unknown as Nip17SignedEvent, account, nip17Crypto);
    if (opened) messages.push(messageFromOpened(opened, pubkey));
  }
  return messages.sort((left, right) => left.createdAt - right.createdAt);
}

/** Downloads and decrypts an attachment so it can be read or shown. */
export async function readAttachment(attachment: ChatAttachment): Promise<Uint8Array> {
  const ciphertext = await downloadFile(attachment.url);
  return decryptAttachment({
    ciphertext,
    keyHex: attachment.keyHex,
    nonceHex: attachment.nonceHex,
  });
}
