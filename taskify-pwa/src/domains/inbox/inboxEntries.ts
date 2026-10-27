/** A shared task, board or contact that arrived by message, as the inbox and chat show it. */
import type { SharedTaskPayload } from "../../lib/shareInbox";

export type InboxEntrySender = {
  name?: string | null;
  npub?: string | null;
  pubkey?: string | null;
  relays?: string[];
  lud16?: string | null;
};

export type InboxEntryContact = {
  npub?: string | null;
  name?: string | null;
  displayName?: string | null;
  username?: string | null;
  address?: string | null;
  nip05?: string | null;
  picture?: string | null;
};

export type InboxEntry = {
  id: string;
  title: string;
  note?: string | null;
  completed?: boolean;
  dmEventId?: string | null;
  type?: "board" | "contact" | "task";
  status?: "pending" | "accepted" | "declined" | "tentative" | "deleted" | "read";
  boardId?: string | null;
  boardName?: string | null;
  contact?: InboxEntryContact | null;
  task?: SharedTaskPayload | null;
  sender?: InboxEntrySender | null;
  receivedAt?: string | null;
};
