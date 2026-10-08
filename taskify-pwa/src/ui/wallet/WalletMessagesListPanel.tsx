import type { RefObject } from "react";
import type { GroupChat } from "../../lib/groupChatState";
import type {
  DmThreadListEntry,
  WalletDmMessage,
  WalletDmThread,
} from "../../hooks/wallet/useDmState";
import {
  GroupAvatar,
  SwipeableDmThreadRow,
  formatShortDate,
  type GroupAvatarMember,
} from "./walletModalUi";

type DmView = "list" | "thread" | "strangers";
type DmListView = "list" | "strangers";
type PeerLabel = {
  label: string;
  picture?: string;
  subtitle?: string;
  verifiedNip05?: string | null;
};

export interface WalletMessagesListPanelProps {
  dmSearch: string;
  dmView: Exclude<DmView, "thread">;
  setDmView: (view: DmView) => void;
  dmListViewRef: RefObject<DmListView>;
  setActiveThreadPeer: (peer: string | null) => void;
  dmThreadListEntries: DmThreadListEntry[];
  strangerUnreadCount: number;
  groupChats: GroupChat[];
  groupAvatarMembersFor: (
    group: GroupChat | null | undefined,
    thread?: WalletDmThread | null,
    fallbackLabel?: string,
  ) => GroupAvatarMember[];
  peerLabelFor: (peerPubkey: string) => PeerLabel;
  threadUnreadMap: Map<string, number>;
  handleArchiveDmThread: (thread: WalletDmThread) => void;
  handleDeleteDmThread: (thread: WalletDmThread) => void;
  collectUnreadThreadItemEventIds: (
    messages: WalletDmMessage[],
    peerPubkey: string,
  ) => string[];
  onMarkMessagesRead: (eventIds: string[]) => void;
}

export function WalletMessagesListPanel({
  dmSearch,
  dmView,
  setDmView,
  dmListViewRef,
  setActiveThreadPeer,
  dmThreadListEntries,
  strangerUnreadCount,
  groupChats,
  groupAvatarMembersFor,
  peerLabelFor,
  threadUnreadMap,
  handleArchiveDmThread,
  handleDeleteDmThread,
  collectUnreadThreadItemEventIds,
  onMarkMessagesRead,
}: WalletMessagesListPanelProps) {
  return (
    <div className="wallet-messages__list space-y-2">
      {dmView === "strangers" && !dmSearch.trim() && (
        <button
          className="wallet-messages__thread pressable"
          onClick={() => {
            dmListViewRef.current = "list";
            setDmView("list");
            setActiveThreadPeer(null);
          }}
        >
          <div className="wallet-messages__avatar wallet-messages__avatar--stranger">
            &larr;
          </div>
          <div className="wallet-messages__thread-body">
            <div className="wallet-messages__thread-title">Back to everyone</div>
            <div className="wallet-messages__thread-preview">View all conversations</div>
          </div>
        </button>
      )}
      {dmThreadListEntries.map((entry) => {
        if (entry.kind === "strangers") {
          return (
            <button
              key="wallet-strangers-group"
              className="wallet-messages__thread wallet-messages__thread--stranger pressable"
              onClick={() => {
                dmListViewRef.current = "strangers";
                setDmView("strangers");
                setActiveThreadPeer(null);
              }}
            >
              <div className="wallet-messages__avatar wallet-messages__avatar--stranger">
                &#9678;
              </div>
              <div className="wallet-messages__thread-body">
                <div className="wallet-messages__thread-title">
                  Strangers{strangerUnreadCount > 0 ? ` (${strangerUnreadCount})` : ""}
                </div>
                <div className="wallet-messages__thread-preview">{entry.lastPreview}</div>
              </div>
              <div className="wallet-messages__thread-meta">
                <span className="wallet-messages__thread-date">
                  {formatShortDate(entry.lastCreatedAt)}
                </span>
                {strangerUnreadCount > 0 && (
                  <span className="chat-unread-badge">{strangerUnreadCount}</span>
                )}
              </div>
            </button>
          );
        }
        const thread = entry.thread;
        const isGroupThread = !!thread.groupId;
        const groupMeta = isGroupThread
          ? groupChats.find((group) => group.groupId === thread.groupId) ?? null
          : null;
        const groupAvatarMembers = isGroupThread
          ? groupAvatarMembersFor(groupMeta, thread, groupMeta?.name || "Group")
          : [];
        const meta = isGroupThread
          ? {
              label: groupMeta?.name || "Group",
              picture: undefined,
              subtitle: `${groupMeta?.members.length || 0} members`,
              verifiedNip05: null,
            }
          : peerLabelFor(thread.peerPubkey);
        const unreadCount = threadUnreadMap.get(thread.peerPubkey) || 0;
        return (
          <SwipeableDmThreadRow
            key={thread.peerPubkey}
            onArchive={() => handleArchiveDmThread(thread)}
            onDelete={() => handleDeleteDmThread(thread)}
          >
            <button
              className="wallet-messages__thread pressable"
              onClick={() => {
                dmListViewRef.current = dmView === "strangers" ? "strangers" : "list";
                setActiveThreadPeer(thread.peerPubkey);
                setDmView("thread");
                const unreadIds = collectUnreadThreadItemEventIds(
                  thread.messages,
                  thread.peerPubkey,
                );
                if (unreadIds.length) {
                  onMarkMessagesRead(unreadIds);
                }
              }}
            >
              <div
                className={`wallet-messages__avatar${
                  isGroupThread ? " wallet-messages__avatar--group" : ""
                }`}
              >
                {isGroupThread ? (
                  <GroupAvatar members={groupAvatarMembers} />
                ) : meta.picture ? (
                  <img
                    src={meta.picture}
                    alt={meta.label}
                    className="wallet-messages__avatar-img"
                  />
                ) : (
                  <span>{meta.label.slice(0, 2)}</span>
                )}
              </div>
              <div className="wallet-messages__thread-body">
                <div className="wallet-messages__thread-title">{meta.label}</div>
                <div className="wallet-messages__thread-preview">{thread.lastPreview}</div>
              </div>
              <div className="wallet-messages__thread-meta">
                <span className="wallet-messages__thread-date">
                  {formatShortDate(thread.lastCreatedAt)}
                </span>
                {unreadCount > 0 && <span className="chat-unread-badge">{unreadCount}</span>}
              </div>
            </button>
          </SwipeableDmThreadRow>
        );
      })}
      {dmThreadListEntries.length === 0 && (
        <div className="wallet-messages__empty text-secondary text-sm text-center">
          {dmView === "strangers" && !dmSearch.trim()
            ? "No stranger messages yet."
            : "No messages yet. Incoming DMs will appear here."}
        </div>
      )}
    </div>
  );
}
