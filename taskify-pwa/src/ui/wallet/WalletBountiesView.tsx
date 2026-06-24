// Wallet → Bounties page body, extracted from App.tsx
// (Item #10, post-`@ts-nocheck` page-component extraction series).
//
// Shows three tabs (Pinned / Funded / Open) over the user's bounty-bearing
// tasks. The local `walletBountiesTab` state lives here because it's only
// read inside this view. The three task lists are computed upstream
// (`fundedBountyTasks`, `pinnedBountyTasks`, `openBountyTasks`) and passed
// pre-flattened as `tasks`.

import { useCallback, useMemo, useState } from "react";
import { TaskTitle } from "../task/TaskTitle";
import type { Board, Task } from "../../domains/tasks/taskTypes";
import type { WalletDenominationDisplay } from "../../domains/tasks/settingsTypes";
import { taskHasBountyList, bountyStateLabel, PINNED_BOUNTY_LIST_KEY } from "../../domains/tasks/taskUtils";
import type { EditingState } from "../../domains/tasks/taskTypes";
import {
  formatSatAmount,
  normalizeWalletDenominationDisplay,
} from "../../wallet/denomination";

type WalletBountiesTab = "open" | "funded" | "pinned";

export type WalletBountiesViewProps = {
  fundedBountyTasks: Task[];
  pinnedBountyTasks: Task[];
  openBountyTasks: Task[];
  boardMap: Map<string, Board>;
  toNpub: (hex: string) => string;
  setEditing: (state: EditingState) => void;
  addTaskToBountyList: (taskId: string) => void;
  removeTaskFromBountyList: (taskId: string) => void;
  walletDenominationDisplay: WalletDenominationDisplay;
};

export function WalletBountiesView({
  fundedBountyTasks,
  pinnedBountyTasks,
  openBountyTasks,
  boardMap,
  toNpub,
  setEditing,
  addTaskToBountyList,
  removeTaskFromBountyList,
  walletDenominationDisplay,
}: WalletBountiesViewProps) {
  const [walletBountiesTab, setWalletBountiesTab] = useState<WalletBountiesTab>("pinned");
  const normalizedWalletDenominationDisplay = normalizeWalletDenominationDisplay(walletDenominationDisplay);
  const satFormatter = useMemo(() => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }), []);
  const formatBountyAmount = useCallback(
    (amount: number) => formatSatAmount(amount, satFormatter, normalizedWalletDenominationDisplay),
    [normalizedWalletDenominationDisplay, satFormatter],
  );

  const visibleTasks =
    walletBountiesTab === "funded"
      ? fundedBountyTasks
      : walletBountiesTab === "pinned"
      ? pinnedBountyTasks
      : openBountyTasks;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="wallet-section space-y-3">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={walletBountiesTab === "pinned" ? "accent-button button-sm pressable" : "ghost-button button-sm pressable"}
            onClick={() => setWalletBountiesTab("pinned")}
          >
            Pinned
          </button>
          <button
            type="button"
            className={walletBountiesTab === "funded" ? "accent-button button-sm pressable" : "ghost-button button-sm pressable"}
            onClick={() => setWalletBountiesTab("funded")}
          >
            Funded
          </button>
          <button
            type="button"
            className={walletBountiesTab === "open" ? "accent-button button-sm pressable" : "ghost-button button-sm pressable"}
            onClick={() => setWalletBountiesTab("open")}
          >
            Open
          </button>
        </div>
        <div className="text-xs text-secondary">
          {walletBountiesTab === "open"
            ? "All tasks with an active bounty."
            : walletBountiesTab === "funded"
              ? "Tasks where you funded the bounty."
              : "Tasks you pinned for quick access."}
        </div>
      </div>
      <div className="surface-panel board-column p-4">
        {visibleTasks.length === 0 ? (
          <div className="text-sm text-secondary">
            No {walletBountiesTab === "open" ? "open bounties" : walletBountiesTab === "funded" ? "funded bounties" : "pinned tasks"} yet.
          </div>
        ) : (
          <ul className="space-y-2">
            {visibleTasks.map((task) => {
              const boardName = boardMap.get(task.boardId)?.name || "Board";
              const bounty = task.bounty;
              const creatorNpub = toNpub(task.createdBy || "");
              const lastEditorNpub = toNpub(task.lastEditedBy || task.completedBy || task.createdBy || "");
              const parsedDue = new Date(task.dueISO);
              const dueLabel = Number.isNaN(parsedDue.getTime())
                ? ""
                : parsedDue.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
              const amountLabel =
                bounty && typeof bounty.amount === "number"
                  ? formatBountyAmount(bounty.amount)
                  : "Amount unknown";
              return (
                <li
                  key={task.id}
                  className="task-card space-y-2"
                  data-form="stacked"
                  data-agent-entity="task"
                  data-agent-creator-npub={creatorNpub || undefined}
                  data-agent-last-editor-npub={lastEditorNpub || undefined}
                >
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium leading-[1.2]">
                        <TaskTitle key={`${task.id}:${task.priority ?? "none"}`} task={task} />
                      </div>
                      <div className="text-xs text-secondary">
                        {boardName}
                        {dueLabel ? ` • ${dueLabel}` : ""}
                      </div>
                      {bounty ? (
                        <div className="mt-1 text-xs text-secondary">
                          {amountLabel} • {bountyStateLabel(bounty)}
                        </div>
                      ) : (
                        <div className="mt-1 text-xs text-secondary">No bounty attached yet.</div>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1 justify-end">
                      <button
                        type="button"
                        className="ghost-button button-sm pressable"
                        onClick={() => setEditing({ type: "task", originalType: "task", originalId: task.id, task })}
                      >
                        Open task
                      </button>
                      <button
                        type="button"
                        className="ghost-button button-sm pressable"
                        onClick={() => {
                          if (taskHasBountyList(task, PINNED_BOUNTY_LIST_KEY)) {
                            removeTaskFromBountyList(task.id);
                          } else {
                            addTaskToBountyList(task.id);
                          }
                        }}
                      >
                        {taskHasBountyList(task, PINNED_BOUNTY_LIST_KEY) ? "Unpin" : "Pin"}
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
