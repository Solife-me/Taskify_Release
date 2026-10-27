// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";

vi.mock("./ChatRuntime", () => ({
  ChatRuntime: ({ active, children }: { active: boolean; children?: React.ReactNode }) => (
    <section data-testid="runtime" data-active={String(active)}>{children}</section>
  ),
}));
vi.mock("./ChatPage", () => ({ default: () => <div data-testid="chat-page">Chat page</div> }));

import { ChatShell } from "./ChatShell";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const props = {
  contactsSyncEnabled: true,
  fileStorageServer: "",
  messageItems: [],
  onAcceptMessage: vi.fn(),
  onMaybeMessage: vi.fn(),
  onDeclineMessage: vi.fn(),
  onDismissMessage: vi.fn(),
  onMarkMessagesRead: vi.fn(),
};

test("the Chat runtime stays mounted off-page while the page loads only when active", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  await act(async () => root.render(
    <ChatShell {...props} active={false}>
      <div data-testid="wallet-child">Wallet child</div>
    </ChatShell>,
  ));
  expect(container.querySelector('[data-testid="runtime"]')?.getAttribute("data-active")).toBe("false");
  expect(container.querySelector('[data-testid="wallet-child"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="chat-page"]')).toBeNull();

  await act(async () => root.render(<ChatShell {...props} active />));
  await vi.waitFor(() => expect(container.querySelector('[data-testid="chat-page"]')).not.toBeNull());
  expect(container.querySelector('[data-testid="runtime"]')?.getAttribute("data-active")).toBe("true");

  await act(async () => root.unmount());
});
