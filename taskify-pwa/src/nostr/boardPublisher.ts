/**
 * Publishes shared-board changes (board metadata, tasks, task deletions) to their relays. Owns the
 * ordering rules: a publish reserves a timestamp newer than anything known before any await, a
 * newer local edit of the same task supersedes an older one still in flight, a deletion is
 * remembered across reloads before it is sent, and a board's metadata goes out ahead of its
 * items. Keys, crypto, relays and storage are injected, so all of this is tested without a
 * network.
 */
import { findBoardByCompoundChildId } from "taskify-core";
import type { TaskPublishVersionTracker } from "../domains/tasks/taskMovePersistence";
import type { TaskDocument } from "taskify-core";
import type { Board, Task } from "../domains/tasks/taskTypes";
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
  deriveBoardKeys: (nostrBoardId: string) => Promise<{ sk: Uint8Array | string }>;
  encrypt: (nostrBoardId: string, plaintext: string) => Promise<string>;
  /** Sends a signed event; resolves to the `created_at` the relays hold. */
  publish: (
    relays: string[],
    template: EventTemplate,
    options: { sk: Uint8Array | string; republish?: boolean },
  ) => Promise<number>;
  /** Encrypts and uploads attachments for a shared board; `null` fields mean nothing changed. */
  prepareAttachments: (params: { images?: string[]; documents?: TaskDocument[]; boardId: string }) => Promise<PreparedAttachments>;
  /** The version time stored with a task locally (`_nostrAt`), so a reserve moves past it. */
  storedTaskAt: (taskId: string, board: Board) => number;
  /** Equality cache so unchanged board metadata is not re-sent with every task. */
  metadataFingerprints: { isUnchanged: (key: string, value: unknown) => boolean; record: (key: string, value: unknown) => void };
  onTaskPending: (taskId: string) => void;
  onTaskSettled: (taskId: string) => void;
  /** Called after publishing when uploads replaced a task's local attachments. */
  onAttachmentsUploaded: (original: Task, published: Task, prepared: PreparedAttachments) => void;
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
    const createdAt = await this.deps.publish(
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
    task._nostrAt = optimisticAt;
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
      const createdAt = await this.deps.publish(
        relays,
        {
          kind: TASK_EVENT_KIND,
          tags: taskEventTags(task, board, tag, task.completed ? "done" : "open"),
          content,
          created_at: optimisticAt,
        },
        { sk: keys.sk, republish: options?.republish },
      );
      const confirmedAt = ledger.noteTask(tag, task.id, createdAt);
      task._nostrAt = Math.max(task._nostrAt ?? 0, confirmedAt);
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
      const createdAt = await this.deps.publish(
        relays,
        { kind: TASK_EVENT_KIND, tags: taskEventTags(task, board, tag, "deleted"), content, created_at: optimisticAt },
        { sk: keys.sk },
      );
      ledger.noteTask(tag, task.id, createdAt);
      ledger.recordTombstone(tag, task.id, createdAt);
    } finally {
      if (versions.finish(pendingKey, version)) {
        ledger.settleTask(tag, task.id);
        this.deps.onTaskSettled(task.id);
      }
    }
  }
}
