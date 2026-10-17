// @ts-nocheck -- the chat UI moved unchanged from CashuWalletModal; typing is tracked in the review.
/**
 * The Chat page: conversations, a conversation, new messages and groups, contacts and the user's
 * card. Everything it shows and does comes from `ChatRuntime` (`useChatRuntime`). Loaded when
 * Chat is first opened. On a mouse desktop the conversation list stays beside the open
 * conversation (`chat-page--two-pane`).
 *
 * The root keeps the `wallet-modal--chat` class names its styles were written for; renaming them
 * is cosmetic and left for the stylesheet cleanup.
 */
// TODO: Continue breaking up this still-large wallet surface. Extract more custom hooks
// (wallet state, mint management, send/receive flows, payment requests, NWC,
// nostr DM redemption, lightning, swaps) into src/hooks/wallet/ and split
// sub-views into smaller components to reduce this file's size.
import React from "react";



























import { useChatRuntime } from "./ChatRuntime";
import { ChatThreadsView } from "./views/ChatThreadsView";
import { ChatConversationView } from "./views/ChatConversationView";
import { ChatContactsView } from "./views/ChatContactsView";
import { ChatOverlays } from "./views/ChatOverlays";
import { ChatGroupInfoView, ChatGroupMembersView, ChatGroupNameView, ChatNewGroupMembersView, ChatNewGroupNameView } from "./views/ChatGroupViews";

export default function ChatPage() {
  const {
    chatView,
    isChatPage,
  } = useChatRuntime();
  const inConversation = chatView === "conversation";
  // Phones hide the tab bar outside the conversation list; desktop keeps the rail (desktop-layout.css).
  const hideAppTabSwitcher = chatView !== "threads";
  const rootClass = `wallet-modal wallet-modal--chat${hideAppTabSwitcher ? " wallet-modal--app-nav-hidden" : " wallet-modal--with-nav"}${inConversation ? " wallet-modal--chat-convo" : ""}`;

  return (
    <div className={rootClass}>
{isChatPage && (
        <div className="chat-page">
          {chatView === "threads" && <ChatThreadsView />}
          <ChatConversationView />

          <ChatGroupInfoView />

          <ChatGroupMembersView />

          <ChatGroupNameView />

          <ChatContactsView />

          {/* ── New Group: Member Selection ──────────────────────────────── */}
          <ChatNewGroupMembersView />

          <ChatNewGroupNameView />

        </div>
      )}
      <ChatOverlays />
    </div>
  );
}
