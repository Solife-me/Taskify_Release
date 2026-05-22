import {
  compressedToRawHex,
  normalizeTaskAssignmentStatus,
  type TaskAssignee,
  type TaskAssigneeStatus,
} from "taskify-core";
import { normalizeNostrPubkey } from "../../lib/nostr";

export function normalizeNostrPubkeyHex(value: string | null | undefined): string | null {
  const trimmed = (value || "").trim();
  if (!trimmed) return null;
  const normalized = normalizeNostrPubkey(trimmed);
  const raw = compressedToRawHex(normalized ?? trimmed).toLowerCase();
  return /^[0-9a-f]{64}$/.test(raw) ? raw : null;
}

export function normalizeAgentPubkey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return normalizeNostrPubkeyHex(value) ?? undefined;
}

export function normalizeTaskAssignees(value: unknown): TaskAssignee[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized: TaskAssignee[] = [];
  const seen = new Set<string>();
  value.forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    const pubkey = normalizeNostrPubkeyHex((entry as any).pubkey);
    if (!pubkey || seen.has(pubkey)) return;
    seen.add(pubkey);
    const relay = typeof (entry as any).relay === "string" ? (entry as any).relay.trim() : "";
    const status = normalizeTaskAssignmentStatus((entry as any).status) as TaskAssigneeStatus | undefined;
    const respondedAtRaw = Number((entry as any).respondedAt);
    const respondedAt =
      Number.isFinite(respondedAtRaw) && respondedAtRaw > 0 ? Math.round(respondedAtRaw) : undefined;
    normalized.push({
      pubkey,
      ...(relay ? { relay } : {}),
      ...(status ? { status } : {}),
      ...(respondedAt ? { respondedAt } : {}),
    });
  });
  return normalized.length ? normalized : undefined;
}

export function mergeTaskAssigneeResponse(
  assignees: TaskAssignee[] | undefined,
  responderPubkey: string,
  status: TaskAssigneeStatus,
  respondedAtMs: number,
): TaskAssignee[] | undefined {
  const normalizedResponder = normalizeNostrPubkeyHex(responderPubkey);
  if (!normalizedResponder || !Array.isArray(assignees) || !assignees.length) return assignees;
  let changed = false;
  const next = assignees.map((assignee) => {
    const assigneePubkey = normalizeNostrPubkeyHex(assignee.pubkey);
    if (!assigneePubkey || assigneePubkey !== normalizedResponder) return assignee;
    const nextStatus = status;
    const nextRespondedAt = respondedAtMs > 0 ? respondedAtMs : Date.now();
    const prevStatus = assignee.status ?? "pending";
    const prevRespondedAt = typeof assignee.respondedAt === "number" ? assignee.respondedAt : 0;
    if (prevStatus === nextStatus && prevRespondedAt === nextRespondedAt) return assignee;
    changed = true;
    return {
      ...assignee,
      status: nextStatus,
      respondedAt: nextRespondedAt,
    };
  });
  return changed ? next : assignees;
}
