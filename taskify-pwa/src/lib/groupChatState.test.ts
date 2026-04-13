import { describe, expect, test } from "vitest";

import { mergeGroupChats, normalizeGroupChatRecord, type GroupChat } from "./groupChatState";

describe("group chat state", () => {
  test("keeps the newest renamed subject when older messages replay later", () => {
    const renamed: GroupChat = {
      groupId: "group-1",
      name: "Project Alpha",
      members: ["a", "b"],
      createdAt: 100,
      nameUpdatedAt: 250,
    };

    const replayedOlderMessage: GroupChat = {
      groupId: "group-1",
      name: "Old Name",
      members: ["a", "b"],
      createdAt: 100,
      nameUpdatedAt: 150,
    };

    expect(mergeGroupChats(renamed, replayedOlderMessage)).toEqual(renamed);
  });

  test("allows a newer rename to replace the cached name", () => {
    const existing: GroupChat = {
      groupId: "group-1",
      name: "Old Name",
      members: ["a", "b"],
      createdAt: 100,
      nameUpdatedAt: 150,
    };

    const renamed: GroupChat = {
      groupId: "group-1",
      name: "New Name",
      members: ["a", "b"],
      createdAt: 100,
      nameUpdatedAt: 250,
    };

    expect(mergeGroupChats(existing, renamed)).toEqual(renamed);
  });

  test("does not let placeholder metadata overwrite an explicit name", () => {
    const existing: GroupChat = {
      groupId: "group-1",
      name: "Study Group",
      members: ["a", "b"],
      createdAt: 100,
      nameUpdatedAt: 200,
    };

    const placeholderUpdate: GroupChat = {
      groupId: "group-1",
      name: "Group",
      members: ["a", "b"],
      createdAt: 100,
    };

    expect(mergeGroupChats(existing, placeholderUpdate)).toEqual(existing);
  });

  test("normalizes legacy stored records", () => {
    expect(
      normalizeGroupChatRecord({
        groupId: "GROUP-1",
        name: "Friends",
        members: ["B", "a", "A"],
        createdAt: 42.9,
      }),
    ).toEqual({
      groupId: "group-1",
      name: "Friends",
      members: ["a", "b"],
      createdAt: 42,
      nameUpdatedAt: 42,
    });
  });
});
