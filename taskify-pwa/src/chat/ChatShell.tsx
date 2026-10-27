import { lazy, Suspense, type ReactNode } from "react";
import { ChatRuntime, type ChatRuntimeProps } from "./ChatRuntime";

export const loadChatPage = () => import("./ChatPage");
const ChatPage = lazy(loadChatPage);

export type ChatShellProps = Omit<ChatRuntimeProps, "children"> & {
  /** Optional wallet surface, kept inside the runtime so it can reuse Chat contacts later. */
  children?: ReactNode;
};

/**
 * Chat's always-mounted background runtime and its on-demand page. This module itself is loaded
 * asynchronously by App: the normal app shell never waits for Chat, while DM sync starts as soon
 * as the browser has loaded this chunk. The page remains a separate chunk until it is visible.
 */
export function ChatShell({ active, children, ...runtimeProps }: ChatShellProps) {
  return (
    <ChatRuntime active={active} {...runtimeProps}>
      {children}
      {active && (
        <Suspense fallback={null}>
          <ChatPage />
        </Suspense>
      )}
    </ChatRuntime>
  );
}

export default ChatShell;
