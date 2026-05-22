import type { EventTemplate, NostrEvent } from "nostr-tools";
import { normalizeRelayUrls } from "taskify-runtime-nostr";
import { NostrSession, type NostrPublishSigner } from "./NostrSession";

export type ProfileMetadataDraft = {
  username?: string;
  displayName?: string;
  about?: string;
  picture?: string;
  lud16?: string;
  lightning_address?: string;
  nip05?: string;
  banner?: string;
  website?: string;
};


function buildProfileContent(draft: ProfileMetadataDraft): Record<string, string> {
  const content: Record<string, string> = {};

  const setField = (key: string, value: string | undefined) => {
    if (value === undefined) return;
    content[key] = value.trim();
  };

  setField("name", draft.username);
  setField("display_name", draft.displayName);
  setField("about", draft.about);
  setField("picture", draft.picture);
  setField("banner", draft.banner);
  setField("website", draft.website);

  const lightning = draft.lud16 || draft.lightning_address;
  setField("lud16", lightning);
  setField("lightning_address", lightning);

  setField("nip05", draft.nip05);

  return content;
}

export async function loadMyLatestProfileEvent(
  pubkey: string,
  relays: string[],
  opts?: { timeoutMs?: number },
): Promise<NostrEvent | null> {
  const relayList = normalizeRelayUrls(relays);
  if (!pubkey || !relayList.length) return null;
  const session = await NostrSession.init(relayList);
  const fetchPromise = session.fetchEvents(
    [{ kinds: [0], authors: [pubkey], limit: 1 }],
    relayList,
  );
  const timeoutMs = opts?.timeoutMs ?? 8000;
  const events = await Promise.race<NostrEvent[]>([
    fetchPromise,
    new Promise<NostrEvent[]>((resolve) => setTimeout(() => resolve([]), timeoutMs)),
  ]).catch(() => []);
  if (!events.length) return null;
  return events.reduce((latest, ev) => {
    if (!latest) return ev;
    const prev = latest.created_at || 0;
    const next = ev.created_at || 0;
    return next > prev ? ev : latest;
  }, events[0] as NostrEvent);
}

export async function publishMyProfile(
  profileDraft: ProfileMetadataDraft,
  opts: {
    signer: NostrPublishSigner;
    pubkey: string;
    relays: string[];
    timeoutMs?: number;
    previousIdHint?: string | null;
    reason?: string;
  },
): Promise<{ event: NostrEvent; previous?: NostrEvent | null; deletedIds: string[] }> {
  const relayList = normalizeRelayUrls(opts.relays);
  if (!opts.pubkey) {
    throw new Error("Missing Nostr pubkey for profile publish.");
  }
  if (!relayList.length) {
    throw new Error("Add at least one relay to publish your profile.");
  }

  const session = await NostrSession.init(relayList);
  let previous: NostrEvent | null = null;
  try {
    previous = await loadMyLatestProfileEvent(opts.pubkey, relayList, { timeoutMs: opts.timeoutMs });
  } catch (err) {
    console.warn("[profile] Unable to load previous profile event", err);
  }

  const template: EventTemplate = {
    kind: 0,
    content: JSON.stringify(buildProfileContent(profileDraft)),
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
  };

  const result = await session.publish(template, {
    relayUrls: relayList,
    signer: opts.signer,
    returnEvent: true,
    debounceMs: 0,
    skipIfIdentical: false,
  });

  if (!result || typeof result !== "object" || !("event" in result)) {
    throw new Error("Failed to publish profile metadata.");
  }

  const event = (result as { event: NostrEvent }).event;
  if (!event?.id) {
    throw new Error("Invalid profile event.");
  }

  const deletionTargets = new Set<string>();
  if (previous?.id && previous.id !== event.id) {
    deletionTargets.add(previous.id);
  }
  if (opts.previousIdHint && opts.previousIdHint !== event.id) {
    deletionTargets.add(opts.previousIdHint);
  }

  const deletedIds: string[] = [];
  if (deletionTargets.size) {
    const deleteTemplate: EventTemplate = {
      kind: 5,
      content: opts.reason || "superseded profile metadata",
      tags: [...Array.from(deletionTargets).map((id) => ["e", id]), ["k", "0"]],
      created_at: Math.floor(Date.now() / 1000),
    };
    try {
      await session.publish(deleteTemplate, {
        relayUrls: relayList,
        signer: opts.signer,
        debounceMs: 0,
        skipIfIdentical: false,
      });
      deletedIds.push(...deletionTargets);
      console.info("[profile] Published profile deletion", { ids: Array.from(deletionTargets), relays: relayList });
    } catch (err) {
      console.warn("[profile] Failed to publish profile deletion", err);
    }
  }

  console.info("[profile] Published kind:0 profile", { id: event.id, relays: relayList });
  return { event, previous: previous ?? null, deletedIds };
}

export async function publishFileServerPreference(
  servers: string[],
  opts: { signer: NostrPublishSigner; relays: string[] },
): Promise<NostrEvent | null> {
  const relayList = normalizeRelayUrls(opts.relays);
  if (!relayList.length) {
    throw new Error("Add at least one relay to publish file server preference.");
  }
  const serverList = Array.from(new Set((servers || []).map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean)));
  const session = await NostrSession.init(relayList);
  const template: EventTemplate = {
    kind: 10096,
    content: "",
    tags: serverList.map((server) => ["server", server]),
    created_at: Math.floor(Date.now() / 1000),
  };
  const result = await session.publish(template, {
    relayUrls: relayList,
    signer: opts.signer,
    returnEvent: true,
    debounceMs: 0,
    skipIfIdentical: false,
  });
  if (result && typeof result === "object" && "event" in result) {
    console.info("[nostr] Published file storage servers", { servers: serverList, relays: relayList, id: (result as any).event?.id });
    return (result as any).event as NostrEvent;
  }
  return null;
}
