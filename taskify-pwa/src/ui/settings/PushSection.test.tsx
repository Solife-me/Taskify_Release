// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { PushSection } from "./PushSection";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function render(pushPrefs: Record<string, unknown>) {
  const onEnableChatPush = vi.fn(async () => {});
  const onDisableChatPush = vi.fn(async () => {});
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(
    <PushSection
      pushPrefs={{ platform: "android", ...pushPrefs } as never}
      pushWorkState="idle"
      pushError={null}
      onEnablePush={async () => {}}
      onDisablePush={async () => {}}
      chatPushBusy={false}
      onEnableChatPush={onEnableChatPush}
      onDisableChatPush={onDisableChatPush}
      workerBaseUrl="https://worker.example"
      vapidPublicKey="key"
    />,
  ));
  const button = (label: string) =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label)!;
  return { container, button, onEnableChatPush, onDisableChatPush };
}

test("chat alerts are offered only once push is on", async () => {
  const off = await render({ enabled: false });
  expect(off.container.textContent).not.toContain("Chat messages");
  const on = await render({ enabled: true, deviceId: "d1" });
  expect(on.container.textContent).toContain("Chat messages");
});

test("the chat toggle turns alerts on and off", async () => {
  const view = await render({ enabled: true, deviceId: "d1", chatEnabled: false });
  await act(async () => view.button("On").click());
  expect(view.onEnableChatPush).toHaveBeenCalledOnce();
  const enabled = await render({ enabled: true, deviceId: "d1", chatEnabled: true });
  await act(async () => enabled.button("Off").click());
  expect(enabled.onDisableChatPush).toHaveBeenCalledOnce();
  await act(async () => enabled.button("On").click());
  expect(enabled.onEnableChatPush).not.toHaveBeenCalled();
});
