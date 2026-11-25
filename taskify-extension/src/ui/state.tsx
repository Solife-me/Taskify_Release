/**
 * The panel's shared state: the account, the boards, the tasks and the chat.
 *
 * One React context holds it all, so the tabs read from the same place and a capture taken in the
 * chat tab is visible to the boards tab straight away.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Board, NostrAppBackupBoard, Task } from "taskify-core";
import { loadAccountBoards, boardRelays, type AccountBoards } from "../lib/account";
import { syncBoard, toBoard } from "../lib/boards";
import { clearIdentity, loadIdentity, parseSecretKey, saveIdentity, type StoredIdentity } from "../lib/identity";
import { getSession, DEFAULT_RELAYS } from "../lib/session";

export type PanelTab = "boards" | "upcoming" | "chat" | "settings";

export type AppState = {
  /** The account, once the user has signed in. */
  identity: StoredIdentity | null;
  /** The boards the account has, as they came from the account backup. */
  boards: Board[];
  /** The tasks of every board that has been read. */
  tasks: Task[];
  /** The board currently being shown. */
  currentBoardId: string | null;
  /** The account's relays, for boards that name none. */
  accountRelays: string[];
  /** True while the first load is running. */
  loading: boolean;
  /** The last error, shown as a banner. */
  error: string | null;
  /** A short-lived message shown at the bottom. */
  toast: string | null;
};

export type AppActions = {
  signIn: (secretKeyInput: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  selectBoard: (boardId: string) => void;
  refresh: () => Promise<void>;
  setToast: (message: string | null) => void;
  setError: (message: string | null) => void;
  setTasks: (updater: (tasks: Task[]) => Task[]) => void;
};

const AppContext = createContext<(AppState & AppActions) | null>(null);

export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp needs the panel's AppProvider.");
  return value;
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [identity, setIdentity] = useState<StoredIdentity | null>(null);
  const [boards, setBoards] = useState<Board[]>([]);
  const [tasks, setTasksState] = useState<Task[]>([]);
  const [currentBoardId, setCurrentBoardId] = useState<string | null>(null);
  const [accountRelays, setAccountRelays] = useState<string[]>([...DEFAULT_RELAYS]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((message: string | null) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    if (message) {
      toastTimer.current = window.setTimeout(() => setToast(null), 3200);
    }
  }, []);

  const setTasks = useCallback((updater: (tasks: Task[]) => Task[]) => {
    setTasksState((previous) => updater(previous));
  }, []);

  /** Reads the account's boards and the tasks of each. */
  const loadEverything = useCallback(
    async (account: StoredIdentity) => {
      setLoading(true);
      setError(null);
      try {
        const accountBoards: AccountBoards = await loadAccountBoards(account.secretKeyHex!, account.pubkey);
        const relays = accountBoards.defaultRelays.length ? accountBoards.defaultRelays : [...DEFAULT_RELAYS];
        setAccountRelays(relays);

        const entries: NostrAppBackupBoard[] = accountBoards.boards;
        const built = entries
          .map((entry) => toBoard(entry, relays))
          .filter((board): board is Board => board !== null);

        setBoards(built);
        setCurrentBoardId((previous) => {
          if (previous && built.some((board) => board.id === previous)) return previous;
          return built[0]?.id ?? null;
        });

        // The account's boards come from the backup; their tasks are read from each board's own
        // relays, one board at a time so one slow relay cannot hold up the rest.
        const collected: Task[] = [];
        for (const board of built) {
          try {
            const result = await syncBoard(board);
            collected.push(...result.tasks);
          } catch (err) {
            console.warn(`[taskify] could not read the board "${board.name}"`, err);
          }
        }
        setTasksState(collected);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // On mount: read the stored account, and if there is one, load everything.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await loadIdentity();
      if (cancelled) return;
      setIdentity(stored);
      if (stored?.secretKeyHex) await loadEverything(stored);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadEverything]);

  const signIn = useCallback(
    async (secretKeyInput: string) => {
      const parsed = parseSecretKey(secretKeyInput);
      if (!parsed) {
        showToast("That is not a valid nsec or 64-character key.");
        return false;
      }
      try {
        await saveIdentity(parsed.secretKeyHex, parsed.pubkey);
        const account: StoredIdentity = { pubkey: parsed.pubkey, secretKeyHex: parsed.secretKeyHex };
        setIdentity(account);
        showToast("Signed in. Loading your boards…");
        await loadEverything(account);
        return true;
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [loadEverything, showToast],
  );

  const signOut = useCallback(async () => {
    await clearIdentity();
    setIdentity(null);
    setBoards([]);
    setTasksState([]);
    setCurrentBoardId(null);
    showToast("Signed out on this device.");
  }, [showToast]);

  const refresh = useCallback(async () => {
    if (!identity?.secretKeyHex) return;
    await loadEverything(identity);
  }, [identity, loadEverything]);

  const value = useMemo<AppState & AppActions>(
    () => ({
      identity,
      boards,
      tasks,
      currentBoardId,
      accountRelays,
      loading,
      error,
      toast,
      signIn,
      signOut,
      selectBoard: setCurrentBoardId,
      refresh,
      setToast: showToast,
      setError,
      setTasks,
    }),
    [
      identity,
      boards,
      tasks,
      currentBoardId,
      accountRelays,
      loading,
      error,
      toast,
      signIn,
      signOut,
      refresh,
      showToast,
      setTasks,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export { getSession };
