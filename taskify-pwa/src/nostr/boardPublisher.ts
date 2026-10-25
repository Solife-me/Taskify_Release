/**
 * Publishes shared-board changes (board metadata, tasks, task deletions) to their relays. Owns the
 * ordering rules: a publish reserves a timestamp newer than anything known before any await, a
 * newer local edit of the same task supersedes an older one still in flight, a deletion is
 * remembered across reloads before it is sent, and a board's metadata goes out ahead of its
 * items. Keys, crypto, relays and storage are injected, so all of this is tested without a
 * network.
 */
import {
  TASKIFY_CALENDAR_EVENT_KIND,
  TASKIFY_CALENDAR_VIEW_KIND,
  calendarAddress,
  findBoardByCompoundChildId,
} from "taskify-core";
import type { TaskPublishVersionTracker } from "../domains/tasks/taskMovePersistence";
import type { TaskDocument } from "taskify-core";
import type { Board, CalendarEvent, Task } from "../domains/tasks/taskTypes";
import { normalizeAgentPubkey } from "../domains/tasks/assignmentUtils";
import type { BoardSyncLedger } from "./boardSyncLedger";
import {
  BOARD_METADATA_KIND,
  TASK_EVENT_KIND,
  boardMetadataEvent,
  sameDocumentList,
  sameStringList,
  taskEventBody,
  taskEventTags,
  taskTombstoneBody,
  taskWithPreparedAttachments,
  type PreparedAttachments,
} from "./boardWire";
import {
  calendarEventPayload,
  calendarEventTags,
  calendarEventWithPreparedAttachments,
  mergeInviteTokens,
  type PreparedEventAttachments,
} from "./calendarWire";

export type EventTemplate = { kind: number; tags: string[][]; content: string; created_at: number };

export type BoardPublisherDeps = {
  ledger: BoardSyncLedger;
  versions: TaskPublishVersionTracker;
  /** The latest boards (compound children resolve through them). */
  boards: () => Board[];
  relaysFor: (board: Board) => string[];
  /** The signed-in user's key as stored on the device, for authorship. */
  actorPubkey: () => string | null | undefined;
  boardTag: (nostrBoardId: string) => string;
  deriveBoardKeys: (nostrBoardId: string) => Promise<{ sk: Uint8Array | string; skHex: string; pk: string }>;
  encrypt: (nostrBoardId: string, plaintext: string) => Promise<string>;
  /** Calendar copies: the canonical one to the board's key, the view one with the event key. */
  encryptCalendarForBoard: (payload: Record<string, unknown>, boardSkHex: string, boardPk: string) => Promise<string>;
  encryptCalendarForInvitees: (payload: Record<string, unknown>, eventKey: string) => Promise<string>;
  /** Sends a signed event; resolves to the `created_at` the relays hold and the event's id. */
  publish: (
    relays: string[],
    template: EventTemplate,
    options: { sk: Uint8Array | string; republish?: boolean },
  ) => Promise<{ createdAt: number; id: string }>;
  /** Encrypts and uploads attachments for a shared board; `null` fields mean nothing changed. */
  prepareAttachments: (params: {
    images?: string[];
    image?: string;
    documents?: TaskDocument[];
    boardId: string;
  }) => Promise<PreparedAttachments & PreparedEventAttachments>;
  /** The version time stored with a task locally (`_nostrAt`), so a reserve moves past it. */
  storedTaskAt: (taskId: string, board: Board) => number;
  /**
   * Stores the version a task's publish carries with the task (`_nostrAt`, and `_nostrId` once
   * signed), through the task store rather than by mutating the object, so it is saved and
   * survives a reload: after one, it is what keeps an equally old relay copy from replacing the
   * local edit, and what decides a same-second tie (C7-3).
   */
  recordTaskVersion: (task: Task, at: number, eventId?: string) => void;
  /** Equality cache so unchanged board metadata is not re-sent with every task. */
  metadataFingerprints: { isUnchanged: (key: string, value: unknown) => boolean; record: (key: string, value: unknown) => void };
  onTaskPending: (taskId: string) => void;
  onTaskSettled: (taskId: string) => void;
  /** Called after publishing when uploads replaced a task's local attachments. */
  onAttachmentsUploaded: (original: Task, published: Task, prepared: PreparedAttachments) => void;
  onEventPending: (eventId: string) => void;
  onEventSettled: (eventId: string) => void;
  /** The event gained an event key or invite tokens; store them before they are published. */
  onEventSecretsMerged: (event: CalendarEvent) => void;
  onEventAttachmentsUploaded: (original: CalendarEvent, published: CalendarEvent, prepared: PreparedEventAttachments) => void;
  now?: () => number;
};

export type PublishTaskOptions = { skipBoardMetadata?: boolean; republish?: boolean };

export class BoardPublisher {
  constructor(private readonly deps: BoardPublisherDeps) {}

  private nowSeconds(): number {
    return Math.floor((this.deps.now?.() ?? Date.now()) / 1000);
  }

  private sharedBoardFor(task: Task, override?: Board): (Board & { nostr: { boardId: string } }) | null {
    const board = override || findBoardByCompoundChildId(this.deps.boards(), task.boardId);
    return board?.nostr?.boardId ? (board as Board & { nostr: { boardId: string } }) : null;
  }

  /**
   * Marks a task as changing locally before any async work, so relay events arriving meanwhile
   * cannot revert it. Returns the timestamp its publish will carry (null for local boards).
   */
  reserveTaskPublish(taskId: string, board: Board | null | undefined): number | null {
    if (!taskId || !board?.nostr?.boardId) return null;
    const at = this.deps.ledger.reserveTaskPublish(
      this.deps.boardTag(board.nostr.boardId),
      taskId,
      this.deps.storedTaskAt(taskId, board),
      this.nowSeconds(),
    );
    this.deps.onTaskPending(taskId);
    return at;
  }

  /** Publishes a board's metadata unless it is unchanged since the last publish. */
  async publishBoardMetadata(board: Board): Promise<void> {
    if (!board.nostr?.boardId) return;
    const relays = this.deps.relaysFor(board);
    const keys = await this.deps.deriveBoardKeys(board.nostr.boardId);
    const tag = this.deps.boardTag(board.nostr.boardId);
    const { tags, payload } = boardMetadataEvent(board, this.deps.boards(), tag);
    const fingerprint = { relays, tags, payload };
    if (this.deps.metadataFingerprints.isUnchanged(tag, fingerprint)) return;
    const content = await this.deps.encrypt(board.nostr.boardId, JSON.stringify(payload));
    const { createdAt } = await this.deps.publish(
      relays,
      { kind: BOARD_METADATA_KIND, tags, content, created_at: this.nowSeconds() },
      { sk: keys.sk },
    );
    this.deps.ledger.noteBoardMeta(tag, createdAt);
    this.deps.metadataFingerprints.record(tag, fingerprint);
  }

  /** Publishes a board's metadata under another shared id and relays (sharing a copy). */
  async publishBoardMetadataAs(board: Board, nostrBoardId: string, relays: string[]): Promise<void> {
    if (!nostrBoardId || !relays.length) return;
    const keys = await this.deps.deriveBoardKeys(nostrBoardId);
    const tag = this.deps.boardTag(nostrBoardId);
    const { tags, payload } = boardMetadataEvent(board, this.deps.boards(), tag);
    const content = await this.deps.encrypt(nostrBoardId, JSON.stringify(payload));
    await this.deps.publish(
      relays,
      { kind: BOARD_METADATA_KIND, tags, content, created_at: this.nowSeconds() },
      { sk: keys.sk },
    );
  }

  /**
   * Metadata ahead of an item publish. It stays durably queued even when no relay accepts it yet,
   * so a failure here never stops the item's own publish.
   */
  async publishBoardMetadataForItem(board: Board): Promise<void> {
    try {
      await this.publishBoardMetadata(board);
    } catch (error) {
      console.warn("[nostr] board metadata not yet delivered; it stays queued", error);
    }
  }

  async publishTask(task: Task, boardOverride?: Board, options?: PublishTaskOptions): Promise<void> {
    const board = this.sharedBoardFor(task, boardOverride);
    if (!board) return;
    const { ledger, versions } = this.deps;
    const relays = this.deps.relaysFor(board);
    const nostrBoardId = board.nostr.boardId;
    const tag = this.deps.boardTag(nostrBoardId);
    const pendingKey = `${tag}::${task.id}`;
    const version = versions.reserve(pendingKey);
    const optimisticAt = this.reserveTaskPublish(task.id, board) ?? this.nowSeconds();
    this.deps.recordTaskVersion(task, optimisticAt);
    try {
      const keys = await this.deps.deriveBoardKeys(nostrBoardId);
      // Attachments are encrypted and uploaded to the file server before the task is published.
      const attachments = await this.deps.prepareAttachments({
        images: task.images,
        documents: task.documents,
        boardId: nostrBoardId,
      });
      const published = taskWithPreparedAttachments(task, attachments);
      const body = taskEventBody(task, { actorPubkey: this.deps.actorPubkey(), attachments });
      if (!versions.isCurrent(pendingKey, version)) return;
      if (!options?.skipBoardMetadata) await this.publishBoardMetadataForItem(board);
      const content = await this.deps.encrypt(nostrBoardId, JSON.stringify(body));
      if (!versions.isCurrent(pendingKey, version)) return;
      const { createdAt, id: eventId } = await this.deps.publish(
        relays,
        {
          kind: TASK_EVENT_KIND,
          tags: taskEventTags(task, board, tag, task.completed ? "done" : "open"),
          content,
          created_at: optimisticAt,
        },
        { sk: keys.sk, republish: options?.republish },
      );
      ledger.noteTask(tag, task.id, createdAt, eventId);
      // Stored with the task while this event is the version the ledger holds; a same-second
      // event with a lower id, already received, stays the winner (C7-3).
      const held = ledger.taskVersion(tag, task.id);
      if (held.createdAt === createdAt && held.id === eventId) this.deps.recordTaskVersion(task, createdAt, eventId);
      if (!sameStringList(published.images, task.images) || !sameDocumentList(published.documents, task.documents)) {
        this.deps.onAttachmentsUploaded(task, published, attachments);
      }
    } finally {
      if (versions.finish(pendingKey, version)) {
        ledger.settleTask(tag, task.id);
        this.deps.onTaskSettled(task.id);
      }
    }
  }

  async publishTaskDeleted(task: Task): Promise<void> {
    const board = this.sharedBoardFor(task);
    if (!board) return;
    const { ledger, versions } = this.deps;
    const relays = this.deps.relaysFor(board);
    const nostrBoardId = board.nostr.boardId;
    const tag = this.deps.boardTag(nostrBoardId);
    const pendingKey = `${tag}::${task.id}`;
    const version = versions.reserve(pendingKey);
    const optimisticAt = this.reserveTaskPublish(task.id, board) ?? this.nowSeconds();
    // Remembered before any await: a reload before the relays confirm still keeps it deleted.
    ledger.recordTombstone(tag, task.id, optimisticAt);
    try {
      const keys = await this.deps.deriveBoardKeys(nostrBoardId);
      if (!versions.isCurrent(pendingKey, version)) return;
      await this.publishBoardMetadataForItem(board);
      const content = await this.deps.encrypt(nostrBoardId, JSON.stringify(taskTombstoneBody(task)));
      if (!versions.isCurrent(pendingKey, version)) return;
      const { createdAt, id: eventId } = await this.deps.publish(
        relays,
        { kind: TASK_EVENT_KIND, tags: taskEventTags(task, board, tag, "deleted"), content, created_at: optimisticAt },
        { sk: keys.sk },
      );
      ledger.noteTask(tag, task.id, createdAt, eventId);
      ledger.recordTombstone(tag, task.id, createdAt);
    } finally {
      if (versions.finish(pendingKey, version)) {
        ledger.settleTask(tag, task.id);
        this.deps.onTaskSettled(task.id);
      }
    }
  }

  // ---- Calendar events ----

  private calendarBoardFor(event: CalendarEvent, override?: Board): (Board & { nostr: { boardId: string } }) | null {
    const targetId = event.originBoardId ?? event.boardId;
    const board = override && override.id === targetId ? override : this.deps.boards().find((b) => b.id === targetId);
    return board?.nostr?.boardId ? (board as Board & { nostr: { boardId: string } }) : null;
  }

  private withAuthors(event: CalendarEvent): CalendarEvent {
    const actor = this.deps.actorPubkey();
    const creator = normalizeAgentPubkey(event.createdBy || actor) ?? undefined;
    const editor = normalizeAgentPubkey(event.lastEditedBy || actor || creator) ?? creator;
    return { ...event, ...(creator ? { createdBy: creator } : {}), ...(editor ? { lastEditedBy: editor } : {}) };
  }

  /** The event key and invite tokens it is published with, stored locally first when new. */
  private withInviteSecrets(event: CalendarEvent): { event: CalendarEvent; eventKey: string } {
    const merged = mergeInviteTokens(event, undefined, this.deps.actorPubkey());
    if (!merged.changed) return { event, eventKey: merged.eventKey };
    const updated = { ...event, eventKey: merged.eventKey, inviteTokens: merged.inviteTokens };
    this.deps.onEventSecretsMerged(updated);
    return { event: updated, eventKey: merged.eventKey };
  }

  private async sendCalendarCopies(
    board: Board & { nostr: { boardId: string } },
    keys: { sk: Uint8Array | string; skHex: string; pk: string },
    event: CalendarEvent,
    eventKey: string,
    payloads: { board: Record<string, unknown>; invitees: Record<string, unknown> },
    republish?: boolean,
  ): Promise<number> {
    const relays = this.deps.relaysFor(board);
    const tag = this.deps.boardTag(board.nostr.boardId);
    const { createdAt } = await this.deps.publish(
      relays,
      {
        kind: TASKIFY_CALENDAR_EVENT_KIND,
        tags: calendarEventTags(event, board, tag),
        content: await this.deps.encryptCalendarForBoard(payloads.board, keys.skHex, keys.pk),
        created_at: this.nowSeconds(),
      },
      { sk: keys.sk, republish },
    );
    await this.deps.publish(
      relays,
      {
        kind: TASKIFY_CALENDAR_VIEW_KIND,
        tags: [["d", event.id], ["a", calendarAddress(TASKIFY_CALENDAR_EVENT_KIND, keys.pk, event.id)]],
        content: await this.deps.encryptCalendarForInvitees(payloads.invitees, eventKey),
        created_at: this.nowSeconds(),
      },
      { sk: keys.sk, republish },
    );
    return createdAt;
  }

  /** Publishes both copies of a calendar event. Generated occurrences are never published. */
  async publishCalendarEvent(event: CalendarEvent, boardOverride?: Board, options?: PublishTaskOptions): Promise<void> {
    if (event.readOnly || event.generated) return;
    const board = this.calendarBoardFor(event, boardOverride);
    if (!board) return;
    const nostrBoardId = board.nostr.boardId;
    const keys = await this.deps.deriveBoardKeys(nostrBoardId);
    const tag = this.deps.boardTag(nostrBoardId);
    this.deps.onEventPending(event.id);
    this.deps.ledger.markEventPending(tag, event.id);
    try {
      if (!options?.skipBoardMetadata) await this.publishBoardMetadataForItem(board);
      const { event: withSecrets, eventKey } = this.withInviteSecrets(this.withAuthors(event));
      const prepared = await this.deps.prepareAttachments({
        boardId: nostrBoardId,
        documents: withSecrets.documents,
        image: withSecrets.image,
      });
      const published = calendarEventWithPreparedAttachments(withSecrets, prepared);
      const actorPubkey = this.deps.actorPubkey();
      const boardPayload = calendarEventPayload(published, { audience: "board", actorPubkey, preparedAttachments: prepared });
      const inviteePayload = calendarEventPayload(published, { audience: "invitees", actorPubkey, preparedAttachments: prepared });
      if (!boardPayload || !inviteePayload) return;
      const createdAt = await this.sendCalendarCopies(
        board,
        keys,
        withSecrets,
        eventKey,
        { board: boardPayload, invitees: inviteePayload },
        options?.republish,
      );
      this.deps.ledger.noteEvent(tag, withSecrets.id, createdAt);
      if (published.image !== withSecrets.image || !sameDocumentList(published.documents, withSecrets.documents)) {
        this.deps.onEventAttachmentsUploaded(withSecrets, published, prepared);
      }
    } finally {
      this.deps.ledger.settleEvent(tag, event.id);
      this.deps.onEventSettled(event.id);
    }
  }

  /** Publishes both copies as deleted, so every device and invitee drops the event. */
  async publishCalendarEventDeleted(event: CalendarEvent): Promise<void> {
    // A generated occurrence was never published, so there is nothing to tombstone.
    if (event.readOnly || event.generated) return;
    const board = this.calendarBoardFor(event);
    if (!board) return;
    const nostrBoardId = board.nostr.boardId;
    const keys = await this.deps.deriveBoardKeys(nostrBoardId);
    const tag = this.deps.boardTag(nostrBoardId);
    this.deps.onEventPending(event.id);
    this.deps.ledger.markEventPending(tag, event.id);
    try {
      await this.publishBoardMetadataForItem(board);
      const { event: withSecrets, eventKey } = this.withInviteSecrets(this.withAuthors(event));
      const actorPubkey = this.deps.actorPubkey();
      const boardPayload = calendarEventPayload(withSecrets, { audience: "board", deleted: true, actorPubkey });
      const inviteePayload = calendarEventPayload(withSecrets, { audience: "invitees", deleted: true, actorPubkey });
      if (!boardPayload || !inviteePayload) return;
      const createdAt = await this.sendCalendarCopies(board, keys, withSecrets, eventKey, {
        board: boardPayload,
        invitees: inviteePayload,
      });
      this.deps.ledger.noteEvent(tag, withSecrets.id, createdAt);
    } finally {
      this.deps.ledger.settleEvent(tag, event.id);
      this.deps.onEventSettled(event.id);
    }
  }
}
