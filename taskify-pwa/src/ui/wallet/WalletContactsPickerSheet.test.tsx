// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
const runtime = vi.hoisted(() => {
  const contact = {
    id: "contact-1",
    kind: "nostr",
    name: "Alice",
    address: "alice@example.com",
    paymentRequest: "",
    npub: "npub1example",
  };
  return {
    contactsOpen: true,
    contactsContext: "lightning",
    visibleContacts: [contact],
    contactSubtitle: vi.fn(),
    isNip05VerifiedForRef: { current: vi.fn() },
    normalizeNip05: vi.fn(),
    contactInitials: vi.fn(),
    truncateContactName: vi.fn(),
  };
});

vi.mock("../../chat/ChatRuntime", () => ({
  useChatRuntime: () => runtime,
}));

vi.mock("../../components/ActionSheet", () => ({
  ActionSheet: ({ open, title, onClose, children }: any) => (
    <section data-open={String(open)} data-title={title}>
      <button type="button" onClick={onClose}>Close</button>
      {children}
    </section>
  ),
}));

vi.mock("./WalletContactsListPanel", () => ({
  WalletContactsListPanel: ({ context, contacts, onSelectContact }: any) => (
    <button
      type="button"
      data-testid="contacts-panel"
      data-context={context}
      data-contact-count={contacts.length}
      onClick={() => onSelectContact(contacts[0])}
    >
      Select first contact
    </button>
  ),
}));

import { WalletContactsPickerSheet } from "./WalletContactsPickerSheet";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test("the wallet contact picker uses the shared Chat runtime and only supplies the wallet callback", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const onClose = vi.fn();
  const onSelectContact = vi.fn();

  await act(async () => root.render(
    <WalletContactsPickerSheet onClose={onClose} onSelectContact={onSelectContact} />,
  ));

  const section = container.querySelector("section");
  const panel = container.querySelector('[data-testid="contacts-panel"]');
  expect(section?.getAttribute("data-open")).toBe("true");
  expect(section?.getAttribute("data-title")).toBe("Lightning contacts");
  expect(panel?.getAttribute("data-context")).toBe("lightning");
  expect(panel?.getAttribute("data-contact-count")).toBe("1");

  await act(async () => panel?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(onSelectContact).toHaveBeenCalledWith(runtime.visibleContacts[0]);

  const closeButton = container.querySelector("button");
  await act(async () => closeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(onClose).toHaveBeenCalledOnce();

  await act(async () => root.unmount());
});
