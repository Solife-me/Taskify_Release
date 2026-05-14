import { useCallback, useEffect, useMemo, useState } from "react";
import type { CalendarEvent, Task } from "../../domains/tasks/taskTypes";

export function useSelectionMode({
  calendarEvents,
  tasks,
}: {
  calendarEvents: CalendarEvent[];
  tasks: Task[];
}) {
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [selectionMoveSheetOpen, setSelectionMoveSheetOpen] = useState(false);
  const [selectionMoveStep, setSelectionMoveStep] = useState<"board" | "column">("board");
  const [selectionMoveBoardId, setSelectionMoveBoardId] = useState<string | null>(null);

  const selectedItemIdSet = useMemo(() => new Set(selectedItemIds), [selectedItemIds]);
  const selectedTasks = useMemo(
    () => tasks.filter((task) => selectedItemIdSet.has(task.id)),
    [tasks, selectedItemIdSet],
  );
  const selectedEvents = useMemo(
    () => calendarEvents.filter((event) => selectedItemIdSet.has(event.id)),
    [calendarEvents, selectedItemIdSet],
  );
  const selectedCount = selectedTasks.length + selectedEvents.length;

  const clearSelection = useCallback(() => {
    setSelectedItemIds([]);
  }, []);

  const exitSelectionMode = useCallback(() => {
    setIsSelectionMode(false);
    setSelectedItemIds([]);
    setSelectionMoveSheetOpen(false);
  }, []);

  const toggleItemSelection = useCallback((id: string) => {
    setSelectedItemIds((prev) => (
      prev.includes(id) ? prev.filter((itemId) => itemId !== id) : [...prev, id]
    ));
  }, []);

  useEffect(() => {
    const handleToggle = () => {
      setSelectionMoveSheetOpen(false);
      setIsSelectionMode((prev) => {
        setSelectedItemIds([]);
        return !prev;
      });
    };
    window.addEventListener("toggleSelectionMode", handleToggle);
    return () => window.removeEventListener("toggleSelectionMode", handleToggle);
  }, []);

  useEffect(() => {
    if (!isSelectionMode) return;
    setSelectedItemIds((prev) =>
      prev.filter((id) => tasks.some((task) => task.id === id) || calendarEvents.some((event) => event.id === id)),
    );
  }, [calendarEvents, isSelectionMode, tasks]);

  useEffect(() => {
    if (!isSelectionMode || selectedCount > 0) return;
    setSelectionMoveSheetOpen(false);
  }, [isSelectionMode, selectedCount]);

  return {
    clearSelection,
    exitSelectionMode,
    isSelectionMode,
    selectedCount,
    selectedEvents,
    selectedItemIds,
    selectedItemIdSet,
    selectedTasks,
    selectionMoveBoardId,
    selectionMoveSheetOpen,
    selectionMoveStep,
    setIsSelectionMode,
    setSelectedItemIds,
    setSelectionMoveBoardId,
    setSelectionMoveSheetOpen,
    setSelectionMoveStep,
    toggleItemSelection,
  };
}
