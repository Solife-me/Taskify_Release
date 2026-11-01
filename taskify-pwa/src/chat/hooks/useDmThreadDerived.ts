import { useMemo } from "react";
import type { Contact } from "../../lib/contacts";
import {
  type WalletDmThread,
  type WalletDmMessage,
  type DmThreadListEntry,
} from "./useDmState";
import { projectHermesBotUi } from "../hermesModelPickerState";

export type MessageSearchResult = { thread: WalletDmThread; message: WalletDmMessage };

export interface UseDmThreadDerivedOptions {
  displayDmMessages: WalletDmMessage[];
  contactIndex: Map<string, { name: string; picture?: string }>;
  dmPreviewForMessage: (msg: WalletDmMessage) => string;
  isArchivedDmThread: (thread: WalletDmThread) => boolean;
  matchesDmThreadSearch: (thread: WalletDmThread) => boolean;
  nostrIdentityInfo: any;
  nostrIdentityRef: React.MutableRefObject<any>;
  activeThreadPeer: string | null;
  groupChats: any[];
  dmSearch: string;
  dmView: string;
  visiblePendingMessages: any[];
  contacts: Contact[];
  compressedToRawHex: (pubkey: string) => string;
  normalizeNostrPubkey: (npub: string) => string | null;
}

export function useDmThreadDerived({
  displayDmMessages,
  contactIndex,
  dmPreviewForMessage,
  isArchivedDmThread,
  matchesDmThreadSearch,
  nostrIdentityInfo,
  nostrIdentityRef,
  activeThreadPeer,
  groupChats,
  dmSearch,
  dmView,
  visiblePendingMessages,
  contacts,
  compressedToRawHex,
  normalizeNostrPubkey,
}: UseDmThreadDerivedOptions) {
  const hiddenMessageIds = useMemo(() => {
    const byThread = new Map<string, WalletDmMessage[]>();
    for (const message of displayDmMessages) {
      const key = message.groupId || message.peerPubkey.toLowerCase();
      const messages = byThread.get(key) ?? [];
      messages.push(message);
      byThread.set(key, messages);
    }
    const hidden = new Set<string>();
    for (const messages of byThread.values()) {
      const projection = projectHermesBotUi(messages, true);
      projection.hiddenEventIds.forEach((eventId) => hidden.add(eventId));
    }
    return hidden;
  }, [displayDmMessages]);

  const dmThreads = useMemo(() => {
    if (!displayDmMessages.length) return [] as WalletDmThread[];
    const threads = new Map<string, WalletDmThread>();
    const contactKeys = new Set(Array.from(contactIndex.keys()));
    // Use reactive identity pubkey (falls back to ref) so self-chat is never a stranger
    const ownHex = (nostrIdentityInfo.identity?.pubkey || nostrIdentityRef.current?.pubkey || "").toLowerCase();
    displayDmMessages.forEach((msg) => {
      const isHiddenBotUi = hiddenMessageIds.has(msg.eventId);
      const preview = isHiddenBotUi ? "" : dmPreviewForMessage(msg);
      const threadKey = msg.groupId || msg.peerPubkey.toLowerCase();
      const existing = threads.get(threadKey);
      const base: WalletDmThread =
        existing ??
        {
          peerPubkey: threadKey,
          messages: [],
          lastCreatedAt: 0,
          lastPreview: "",
          isStranger: msg.groupId ? false : !contactKeys.has(threadKey) && (ownHex === "" || threadKey !== ownHex),
          ...(msg.groupId ? { groupId: msg.groupId } : {}),
        };
      base.messages.push(msg);
      if (msg.createdAt > base.lastCreatedAt) {
        base.lastCreatedAt = msg.createdAt;
        if (!isHiddenBotUi) base.lastPreview = preview;
      }
      threads.set(threadKey, base);
    });
    const ordered = Array.from(threads.values()).map((thread) => ({
      ...thread,
      messages: [...thread.messages].sort((a, b) => a.createdAt - b.createdAt),
    }));
    ordered.sort((a, b) => b.lastCreatedAt - a.lastCreatedAt);
    return ordered;
  }, [contactIndex, displayDmMessages, dmPreviewForMessage, hiddenMessageIds, nostrIdentityInfo, nostrIdentityRef]);

  const activeThread = useMemo(
    () => (activeThreadPeer ? dmThreads.find((t) => t.peerPubkey === activeThreadPeer) ?? null : null),
    [activeThreadPeer, dmThreads],
  );

  const activeGroupChat = useMemo(
    () => (activeThread?.groupId ? groupChats.find((group) => group.groupId === activeThread.groupId) ?? null : null),
    [activeThread?.groupId, groupChats],
  );

  const visibleDmThreads = useMemo(
    () => dmThreads.filter((thread) => !isArchivedDmThread(thread)),
    [dmThreads, isArchivedDmThread],
  );

  const contactByHex = useMemo(() => {
    const map = new Map<string, Contact>();
    contacts.forEach((contact) => {
      const normalized = normalizeNostrPubkey(contact.npub || "");
      if (!normalized) return;
      const compressed = normalized.toLowerCase();
      const raw = compressedToRawHex(normalized).toLowerCase();
      map.set(compressed, contact);
      map.set(raw, contact);
    });
    return map;
  }, [compressedToRawHex, contacts, normalizeNostrPubkey]);

  const strangerThreads = useMemo(
    () => visibleDmThreads.filter((thread) => thread.isStranger),
    [visibleDmThreads],
  );

  const dmThreadListEntries = useMemo<DmThreadListEntry[]>(() => {
    if (dmSearch.trim()) {
      return visibleDmThreads
        .filter(matchesDmThreadSearch)
        .map((thread) => ({ kind: "thread" as const, thread, lastCreatedAt: thread.lastCreatedAt }));
    }
    if (dmView === "strangers") {
      return strangerThreads.map((thread) => ({
        kind: "thread" as const,
        thread,
        lastCreatedAt: thread.lastCreatedAt,
      }));
    }
    const entries: DmThreadListEntry[] = visibleDmThreads
      .filter((thread) => !thread.isStranger)
      .map((thread) => ({ kind: "thread", thread, lastCreatedAt: thread.lastCreatedAt }));
    if (strangerThreads.length) {
      const latestStrangerThread = strangerThreads.reduce((latest, thread) =>
        thread.lastCreatedAt > latest.lastCreatedAt ? thread : latest,
      );
      entries.push({
        kind: "strangers",
        lastCreatedAt: latestStrangerThread.lastCreatedAt,
        lastPreview: latestStrangerThread.lastPreview || "New requests",
      });
    }
    entries.sort((a, b) => b.lastCreatedAt - a.lastCreatedAt);
    return entries;
  }, [dmSearch, dmView, matchesDmThreadSearch, strangerThreads, visibleDmThreads]);

  const messageSearchResults = useMemo<MessageSearchResult[]>(() => {
    const q = dmSearch.trim().toLowerCase();
    if (!q) return [];
    const results: MessageSearchResult[] = [];
    for (const thread of visibleDmThreads) {
      for (const msg of thread.messages) {
        if (!hiddenMessageIds.has(msg.eventId) && !msg.eventId.startsWith("draft-") && msg.content.toLowerCase().includes(q)) {
          results.push({ thread, message: msg });
        }
      }
    }
    results.sort((a, b) => b.message.createdAt - a.message.createdAt);
    return results;
  }, [dmSearch, hiddenMessageIds, visibleDmThreads]);

  const activeThreadPendingMessages = useMemo(
    () =>
      activeThread
        ? visiblePendingMessages.filter((message) => message.peerPubkey === activeThread.peerPubkey)
        : [],
    [activeThread, visiblePendingMessages],
  );

  return {
    dmThreads,
    activeThread,
    activeGroupChat,
    visibleDmThreads,
    contactByHex,
    strangerThreads,
    dmThreadListEntries,
    messageSearchResults,
    activeThreadPendingMessages,
  };
}
