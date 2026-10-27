// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { readStoredNostrIdentity, type NostrIdentityInfo } from "../chatHelpers";
import { TASKIFY_NOSTR_KEY_UPDATED_EVENT } from "../../nostrKeys";
import { useNostrSession, type UseNostrSessionOptions } from "./useNostrSession";

vi.mock("../chatHelpers", () => ({
  readStoredNostrIdentity: vi.fn(),
  EMPTY_NOSTR_IDENTITY_INFO: { identity: null, reason: null },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("identity refresh follows sheet transitions and key events, with listener cleanup", async () => {
  const first: NostrIdentityInfo = { identity: { secret: "first-secret", pubkey: "first-key" }, reason: null };
  const second: NostrIdentityInfo = { identity: { secret: "second-secret", pubkey: "second-key" }, reason: null };
  const read = vi.mocked(readStoredNostrIdentity).mockReturnValue(first);
  let state: ReturnType<typeof useNostrSession>;
  const closeRef = { current: null };
  function Harness({ keys }: { keys: UseNostrSessionOptions["identityRefreshKeys"] }) {
    state = useNostrSession({ debug: false, fileStorageServer: "", dmSubscriptionCloseRef: closeRef,
      identityEnabled: true, identityRefreshKeys: keys });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Harness keys={[false, null, null]} />));
    expect(state!.nostrIdentityRef.current).toEqual(first.identity);
    read.mockClear().mockReturnValue(second);
    await act(async () => root.render(<Harness keys={[false, null, null]} />));
    expect(read).not.toHaveBeenCalled();
    for (const keys of [[true, null, null], [true, "receive", null], [true, "receive", "send"]] as const) {
      await act(async () => root.render(<Harness keys={keys} />));
    }
    expect(read).toHaveBeenCalledTimes(3);
    expect(state!.nostrIdentityRef.current).toEqual(second.identity);
    read.mockReturnValue(first);
    await act(async () => { window.dispatchEvent(new Event(TASKIFY_NOSTR_KEY_UPDATED_EVENT)); });
    expect(state!.nostrIdentityRef.current).toEqual(first.identity);
  } finally {
    await act(async () => root.unmount());
  }
  read.mockClear();
  window.dispatchEvent(new Event(TASKIFY_NOSTR_KEY_UPDATED_EVENT));
  expect(read).not.toHaveBeenCalled();
});

test("disabled identity stays unloaded and stopping a subscription releases it only once", async () => {
  const read = vi.mocked(readStoredNostrIdentity).mockClear();
  const release = vi.fn();
  const closeRef = { current: release as (() => void) | null };
  let state: ReturnType<typeof useNostrSession>;
  function Harness() {
    state = useNostrSession({ debug: false, fileStorageServer: "", dmSubscriptionCloseRef: closeRef,
      identityEnabled: false });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Harness />));
    expect(read).not.toHaveBeenCalled();
    expect(state!.nostrIdentityInfo.identity).toBeNull();
    state!.stopDmSubscription();
    state!.stopDmSubscription();
    expect(release).toHaveBeenCalledOnce();
    expect(closeRef.current).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
