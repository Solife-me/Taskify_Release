// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";

vi.mock("../../context/ToastContext", () => ({
  useToast: () => ({ show: vi.fn() }),
}));
vi.mock("./BoardsSection", () => ({ BoardsSection: () => <div>Boards body</div> }));
vi.mock("./ViewSection", () => ({ ViewSection: () => <div>View body</div> }));
vi.mock("./ChatSection", () => ({ ChatSection: () => <div>Chat body</div> }));
vi.mock("./BibleSection", () => ({ BibleSection: () => <div>Bible body</div> }));
vi.mock("./PushSection", () => ({ PushSection: () => <div>Push body</div> }));
vi.mock("./NostrSection", () => ({ NostrSection: () => <div>Nostr body</div> }));
vi.mock("./StorageSection", () => ({ StorageSection: () => <div>Storage body</div> }));
vi.mock("./BackupSection", () => ({ BackupSection: () => <div>Backup body</div> }));
vi.mock("./SupportSection", () => ({ SupportSection: () => <div>Support body</div> }));
vi.mock("./ManageBoardModal", () => ({ ManageBoardModal: () => null }));

import { SettingsModal } from "./SettingsModal";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function renderSettings(container: HTMLElement, root: ReturnType<typeof createRoot>) {
  return act(async () => root.render(
    <SettingsModal
      embedded
      settings={{ pushNotifications: {} } as any}
      boards={[]}
      currentBoardId=""
      setSettings={vi.fn()}
      setBoards={vi.fn()}
      setTasks={vi.fn()}
      changeBoard={vi.fn()}
      shouldReloadForNavigation={() => false}
      defaultRelays={[]}
      setDefaultRelays={vi.fn()}
      pubkeyHex=""
      onGenerateKey={vi.fn()}
      onSetKey={vi.fn()}
      onShareBoard={vi.fn()}
      onJoinBoard={vi.fn()}
      onRegenerateBoardId={vi.fn()}
      onBoardChanged={vi.fn()}
      onResyncBoardHistory={vi.fn()}
      onClose={vi.fn()}
      pushWorkState="idle"
      pushError={null}
      onEnablePush={vi.fn().mockResolvedValue(undefined)}
      onDisablePush={vi.fn().mockResolvedValue(undefined)}
      chatPushBusy={false}
      onEnableChatPush={vi.fn().mockResolvedValue(undefined)}
      onDisableChatPush={vi.fn().mockResolvedValue(undefined)}
      workerBaseUrl=""
      vapidPublicKey=""
      onResetWalletTokenTracking={vi.fn()}
    />,
  ));
}

function groupButton(container: HTMLElement, title: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>(".settings-accordion__header")]
    .find((candidate) => candidate.textContent?.includes(title));
  if (!button) throw new Error(`Settings group not found: ${title}`);
  return button;
}

test("every settings group starts collapsed, expands independently, and resets on remount", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  await renderSettings(container, root);
  const groups = [...container.querySelectorAll<HTMLButtonElement>(".settings-accordion__header")];
  expect(groups).toHaveLength(11);
  expect(groups.every((button) => button.getAttribute("aria-expanded") === "false")).toBe(true);
  expect(container.textContent).not.toContain("View body");

  await act(async () => groupButton(container, "View").click());
  expect(groupButton(container, "View").getAttribute("aria-expanded")).toBe("true");
  expect(container.textContent).toContain("View body");
  expect(groupButton(container, "Chat").getAttribute("aria-expanded")).toBe("false");

  await act(async () => root.unmount());
  const remounted = createRoot(container);
  await renderSettings(container, remounted);
  expect(
    [...container.querySelectorAll<HTMLButtonElement>(".settings-accordion__header")]
      .every((button) => button.getAttribute("aria-expanded") === "false"),
  ).toBe(true);
  await act(async () => remounted.unmount());
});
