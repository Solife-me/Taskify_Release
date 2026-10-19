import { describe, expect, test, vi } from "vitest";
import type { ShareEnvelope } from "taskify-core";
import { receiveIncomingShare, type IncomingShare, type ShareInboxDeps } from "./shareInboxReceiver";

const ME = "a".repeat(64);
const ALICE = "b".repeat(64);

function deps(overrides: Partial<ShareInboxDeps> = {}) {
  const handled = new Set<string>();
  return {
    viewerPubkey: ME,
    alreadyHandled: (id: string) => handled.has(id),
    markHandled: vi.fn((id: string) => { handled.add(id); }),
    fetchProfile: vi.fn(async () => ({ displayName: "Alice" })),
    addCalendarInvite: vi.fn(),
    applyAssignmentResponse: vi.fn(),
    addInboxItem: vi.fn(),
    ...overrides,
  } satisfies ShareInboxDeps;
}

const share = (item: ShareEnvelope["item"], extra: Partial<IncomingShare> = {}): IncomingShare => ({
  eventId: "wrap-1",
  envelope: { v: 1, kind: "taskify-share", item },
  senderPubkey: ALICE,
  recipientPubkeys: [ME],
  ...extra,
});

describe("receiveIncomingShare", () => {
  test("a shared task goes to the inbox, named after the sender's profile, and is recorded locally only", async () => {
    const d = deps();
    const taken = await receiveIncomingShare(share({ type: "task", title: "Buy milk" } as ShareEnvelope["item"]), d);
    expect(taken).toBe(true);
    expect(d.addInboxItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: "task", title: "Buy milk" }),
      { pubkey: ALICE, name: "Alice", npub: undefined },
      "wrap-1",
    );
    // The receiver has no way to publish: the message stays on the relays for other devices.
    expect(Object.keys(d).sort()).toEqual(
      ["addCalendarInvite", "addInboxItem", "alreadyHandled", "applyAssignmentResponse", "fetchProfile", "markHandled", "viewerPubkey"],
    );
  });

  test("each share is taken once", async () => {
    const d = deps();
    const item = { type: "task", title: "Once" } as ShareEnvelope["item"];
    await receiveIncomingShare(share(item), d);
    expect(await receiveIncomingShare(share(item), d)).toBe(false);
    expect(d.addInboxItem).toHaveBeenCalledTimes(1);
  });

  test("a share addressed to someone else is ignored", async () => {
    const d = deps();
    expect(await receiveIncomingShare(share({ type: "task", title: "x" } as ShareEnvelope["item"], { recipientPubkeys: ["c".repeat(64)] }), d)).toBe(false);
    expect(d.markHandled).not.toHaveBeenCalled();
  });

  test("calendar invites and assignment responses go to their own handlers", async () => {
    const d = deps();
    await receiveIncomingShare(share({ type: "event", eventId: "e1" } as ShareEnvelope["item"], { eventId: "w1" }), d);
    await receiveIncomingShare(share({ type: "task-assignment-response", taskId: "t1", status: "accepted" } as ShareEnvelope["item"], { eventId: "w2" }), d);
    expect(d.addCalendarInvite).toHaveBeenCalledWith(expect.objectContaining({ eventId: "e1" }), expect.anything(), "w1");
    expect(d.applyAssignmentResponse).toHaveBeenCalledWith(expect.objectContaining({ taskId: "t1" }), expect.anything());
    expect(d.addInboxItem).not.toHaveBeenCalled();
  });

  test("a contact shared without a name is named from its profile", async () => {
    const d = deps({ fetchProfile: vi.fn(async (pubkey: string) => (pubkey === "npub1x" ? { displayName: "Carol", nip05: "c@x" } : null)) });
    await receiveIncomingShare(share({ type: "contact", npub: "npub1x" }, { envelope: { v: 1, kind: "taskify-share", item: { type: "contact", npub: "npub1x" }, sender: { name: "Al" } } }), d);
    expect(d.addInboxItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: "contact", npub: "npub1x", displayName: "Carol", nip05: "c@x" }),
      expect.objectContaining({ name: "Al" }),
      "wrap-1",
    );
  });
});
