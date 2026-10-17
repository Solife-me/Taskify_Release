import { useChatRuntime } from "../../chat/ChatRuntime";

/** The wallet's read-only view of the contacts owned by Chat. */
export function useWalletContactsRuntime() {
  return useChatRuntime();
}
