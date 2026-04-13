export type GroupChat = {
  groupId: string;
  name: string;
  members: string[];
  createdAt: number;
  nameUpdatedAt?: number;
};

function normalizeGroupTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeGroupName(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeGroupMembers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((member) => (typeof member === "string" ? member.trim().toLowerCase() : ""))
        .filter(Boolean),
    ),
  ).sort();
}

export function resolveGroupChatNameUpdatedAt(group: Partial<GroupChat> | null | undefined): number {
  const explicit = normalizeGroupTimestamp(group?.nameUpdatedAt);
  if (explicit > 0) return explicit;
  const name = normalizeGroupName(group?.name);
  if (!name || name === "Group") return 0;
  return normalizeGroupTimestamp(group?.createdAt);
}

export function normalizeGroupChatRecord(value: unknown): GroupChat | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<GroupChat>;
  const groupId = typeof candidate.groupId === "string" ? candidate.groupId.trim().toLowerCase() : "";
  const members = normalizeGroupMembers(candidate.members);
  const createdAt = normalizeGroupTimestamp(candidate.createdAt);
  if (!groupId || !members.length || createdAt <= 0) return null;
  const name = normalizeGroupName(candidate.name) || "Group";
  const nameUpdatedAt = resolveGroupChatNameUpdatedAt(candidate);
  return nameUpdatedAt > 0
    ? { groupId, name, members, createdAt, nameUpdatedAt }
    : { groupId, name, members, createdAt };
}

export function mergeGroupChats(existing: GroupChat | null | undefined, incoming: GroupChat): GroupChat {
  const normalizedIncoming = normalizeGroupChatRecord(incoming);
  if (!normalizedIncoming) {
    throw new Error("Incoming group chat record is invalid");
  }
  const normalizedExisting = normalizeGroupChatRecord(existing) ?? null;
  if (!normalizedExisting) return normalizedIncoming;

  const existingNameUpdatedAt = resolveGroupChatNameUpdatedAt(normalizedExisting);
  const incomingNameUpdatedAt = resolveGroupChatNameUpdatedAt(normalizedIncoming);
  const existingName = normalizeGroupName(normalizedExisting.name) || "Group";
  const incomingName = normalizeGroupName(normalizedIncoming.name) || "Group";
  const shouldApplyIncomingName =
    incomingNameUpdatedAt > existingNameUpdatedAt ||
    (incomingNameUpdatedAt === existingNameUpdatedAt && incomingName === existingName);

  const createdAtCandidates = [normalizedExisting.createdAt, normalizedIncoming.createdAt].filter((value) => value > 0);
  const createdAt = createdAtCandidates.length ? Math.min(...createdAtCandidates) : normalizedIncoming.createdAt;
  const name = shouldApplyIncomingName ? incomingName : existingName;
  const nameUpdatedAt = shouldApplyIncomingName ? incomingNameUpdatedAt : existingNameUpdatedAt;

  return nameUpdatedAt > 0
    ? {
        groupId: normalizedIncoming.groupId,
        name,
        members: normalizeGroupMembers([...normalizedExisting.members, ...normalizedIncoming.members]),
        createdAt,
        nameUpdatedAt,
      }
    : {
        groupId: normalizedIncoming.groupId,
        name,
        members: normalizeGroupMembers([...normalizedExisting.members, ...normalizedIncoming.members]),
        createdAt,
      };
}
