import React, { useState, useCallback, useEffect, useRef } from "react";
import { parseBoardSharePayload } from "taskify-core";
import { useToast } from "../../context/ToastContext";
import { Modal } from "../Modal";
import { BoardQrScanner } from "./BoardQrScanner";


export function AddBoardModal({
  onClose,
  onCreateBoard,
  onJoinBoard,
}: {
  onClose: () => void;
  onCreateBoard: (name: string, type: "lists" | "compound", shared: boolean) => string | null;
  onJoinBoard: (nostrId: string, name?: string, relaysCsv?: string) => void;
}) {
  const { show: showToast } = useToast();
  const [newBoardName, setNewBoardName] = useState("");
  const [newBoardType, setNewBoardType] = useState<"lists" | "compound">("lists");
  const [newBoardShared, setNewBoardShared] = useState(true);
  const [joinBoardId, setJoinBoardId] = useState("");
  const [joinStatus, setJoinStatus] = useState<{ tone: "info" | "error"; message: string } | null>(null);
  const [scannerActive, setScannerActive] = useState(false);
  const [scannerStatus, setScannerStatus] = useState<string | null>(null);
  const joinInputRef = useRef<HTMLInputElement | null>(null);
  const [infoOpen, setInfoOpen] = useState<string | null>(null);
  const infoButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const infoPanelRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const pillButtonClass = useCallback(
    (active: boolean) => `${active ? "accent-button" : "ghost-button"} button-sm pressable`,
    [],
  );
  const setInfoButtonRef = useCallback(
    (key: string) => (node: HTMLButtonElement | null) => {
      infoButtonRefs.current[key] = node;
    },
    [],
  );
  const setInfoPanelRef = useCallback(
    (key: string) => (node: HTMLDivElement | null) => {
      infoPanelRefs.current[key] = node;
    },
    [],
  );
  const toggleInfo = useCallback((key: string) => {
    setInfoOpen((prev) => (prev === key ? null : key));
  }, []);

  useEffect(() => {
    if (!infoOpen || typeof document === "undefined") return;
    const handlePointer = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      const panel = infoPanelRefs.current[infoOpen];
      if (panel?.contains(target)) return;
      const button = infoButtonRefs.current[infoOpen];
      if (button?.contains(target)) return;
      setInfoOpen(null);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setInfoOpen(null);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("touchstart", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("touchstart", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [infoOpen]);

  const handleCreateBoard = useCallback(() => {
    const trimmed = newBoardName.trim();
    if (!trimmed) {
      showToast("Enter a board name");
      return;
    }
    const createdId = onCreateBoard(trimmed, newBoardType, newBoardShared);
    if (!createdId) return;
    showToast(newBoardShared ? "Board created & synced" : "Board created (local only)");
    onClose();
  }, [newBoardName, newBoardType, newBoardShared, onCreateBoard, onClose, showToast]);

  const handleJoinBoard = useCallback(() => {
    const parsed = parseBoardSharePayload(joinBoardId);
    if (!parsed) {
      setJoinStatus({ tone: "error", message: "Enter a valid board ID." });
      return;
    }
    setScannerActive(false);
    onJoinBoard(parsed.boardId, parsed.boardName, parsed.relaysCsv);
    showToast(parsed.boardName ? `Joined ${parsed.boardName}` : "Board added");
    onClose();
  }, [joinBoardId, onJoinBoard, onClose, showToast]);

  const handlePasteBoardId = useCallback(async () => {
    try {
      const text = await navigator.clipboard?.readText();
      if (!text || !text.trim()) {
        setJoinStatus({ tone: "error", message: "Clipboard is empty." });
        return;
      }
      const parsed = parseBoardSharePayload(text);
      if (!parsed) {
        setJoinBoardId(text.trim());
        setJoinStatus({ tone: "error", message: "Paste a valid board ID." });
        return;
      }
      setJoinBoardId(parsed.boardId);
      setJoinStatus(parsed.boardName ? { tone: "info", message: `Found "${parsed.boardName}".` } : null);
      joinInputRef.current?.focus();
    } catch {
      showToast("Unable to read clipboard");
    }
  }, [showToast]);

  const handleScanDetected = useCallback(
    async (value: string) => {
      const parsed = parseBoardSharePayload(value);
      if (!parsed) {
        setScannerStatus("Not a Taskify board QR.");
        return false;
      }
      onJoinBoard(parsed.boardId, parsed.boardName, parsed.relaysCsv);
      showToast(parsed.boardName ? `Joined ${parsed.boardName}` : "Board added");
      setScannerActive(false);
      onClose();
      return true;
    },
    [onJoinBoard, onClose, showToast],
  );

  const handleJoinInputChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setJoinBoardId(event.target.value);
    setJoinStatus(null);
    setScannerStatus(null);
  }, []);

  const toggleScanner = useCallback(() => {
    setScannerActive((prev) => !prev);
    setScannerStatus(null);
  }, []);

  const joinStatusClass = joinStatus?.tone === "error" ? "text-rose-400" : "text-secondary";

  return (
    <Modal onClose={onClose} title="Add Board" variant="fullscreen">
      <div className="space-y-2">
        <div className="grid gap-2 sm:grid-cols-2">
          <section className="wallet-section wallet-section--compact add-board-section space-y-2">
            <div className="share-mode-header">
              <div className="text-sm font-medium">Create board</div>
              <button
                type="button"
                className="share-mode-info-button pressable"
                aria-label="About creating boards"
                aria-expanded={infoOpen === "create"}
                aria-controls="add-board-create-info"
                onClick={() => toggleInfo("create")}
                ref={setInfoButtonRef("create")}
              >
                <span className="share-mode-info-button__icon" aria-hidden="true">i</span>
              </button>
              {infoOpen === "create" && (
                <div
                  className="share-mode-info"
                  role="tooltip"
                  id="add-board-create-info"
                  ref={setInfoPanelRef("create")}
                >
                  <div className="share-mode-info__text">
                    Start a fresh board for your tasks. You can rename or share it anytime.
                  </div>
                </div>
              )}
            </div>
            <div className="space-y-1">
              <input
                value={newBoardName}
                onChange={(e) => setNewBoardName(e.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") handleCreateBoard();
                }}
                placeholder="New board name"
                aria-label="Board name"
                className="pill-input w-full"
              />
            </div>
            <div className="space-y-2">
              <div className="share-mode-header">
                <label className="text-xs uppercase tracking-wide text-secondary">Board type</label>
                <button
                  type="button"
                  className="share-mode-info-button pressable"
                  aria-label="Board type details"
                  aria-expanded={infoOpen === "type"}
                  aria-controls="add-board-type-info"
                  onClick={() => toggleInfo("type")}
                  ref={setInfoButtonRef("type")}
                >
                  <span className="share-mode-info-button__icon" aria-hidden="true">i</span>
                </button>
                {infoOpen === "type" && (
                  <div
                    className="share-mode-info"
                    role="tooltip"
                    id="add-board-type-info"
                    ref={setInfoPanelRef("type")}
                  >
                    <div className="share-mode-info__row">
                      <div className="share-mode-info__label">Lists</div>
                      <div className="share-mode-info__text">Custom columns for tasks.</div>
                    </div>
                    <div className="share-mode-info__row">
                      <div className="share-mode-info__label">Compound</div>
                      <div className="share-mode-info__text">Combine multiple list boards into one view.</div>
                    </div>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={pillButtonClass(newBoardType === "lists")}
                  onClick={() => setNewBoardType("lists")}
                >
                  Lists
                </button>
                <button
                  type="button"
                  className={pillButtonClass(newBoardType === "compound")}
                  onClick={() => setNewBoardType("compound")}
                >
                  Compound
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <div className="share-mode-header">
                <label className="text-xs uppercase tracking-wide text-secondary">Storage</label>
                <button
                  type="button"
                  className="share-mode-info-button pressable"
                  aria-label="Storage details"
                  aria-expanded={infoOpen === "storage"}
                  aria-controls="add-board-storage-info"
                  onClick={() => toggleInfo("storage")}
                  ref={setInfoButtonRef("storage")}
                >
                  <span className="share-mode-info-button__icon" aria-hidden="true">i</span>
                </button>
                {infoOpen === "storage" && (
                  <div
                    className="share-mode-info"
                    role="tooltip"
                    id="add-board-storage-info"
                    ref={setInfoPanelRef("storage")}
                  >
                    <div className="share-mode-info__row">
                      <div className="share-mode-info__label">Shared</div>
                      <div className="share-mode-info__text">Synced via Nostr. Recoverable from your nsec on any device.</div>
                    </div>
                    <div className="share-mode-info__row">
                      <div className="share-mode-info__label">Local only</div>
                      <div className="share-mode-info__text">Stored on this device only. Cannot be recovered if lost.</div>
                    </div>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={pillButtonClass(newBoardShared)}
                  onClick={() => setNewBoardShared(true)}
                >
                  Shared
                </button>
                <button
                  type="button"
                  className={pillButtonClass(!newBoardShared)}
                  onClick={() => setNewBoardShared(false)}
                >
                  Local only
                </button>
              </div>
            </div>
            <button
              className="accent-button button-sm pressable w-full justify-center"
              onClick={handleCreateBoard}
              disabled={!newBoardName.trim()}
            >
              Create board
            </button>
          </section>
          <section className="wallet-section wallet-section--compact add-board-section space-y-2">
            <div className="share-mode-header">
              <div className="text-sm font-medium">Join board</div>
              <button
                type="button"
                className="share-mode-info-button pressable"
                aria-label="About joining boards"
                aria-expanded={infoOpen === "join"}
                aria-controls="add-board-join-info"
                onClick={() => toggleInfo("join")}
                ref={setInfoButtonRef("join")}
              >
                <span className="share-mode-info-button__icon" aria-hidden="true">i</span>
              </button>
              {infoOpen === "join" && (
                <div
                  className="share-mode-info"
                  role="tooltip"
                  id="add-board-join-info"
                  ref={setInfoPanelRef("join")}
                >
                  <div className="share-mode-info__text">
                    Paste a Taskify board ID or scan a QR to join a shared board.
                  </div>
                </div>
              )}
            </div>
            <div className="space-y-1">
              <div className="flex gap-2">
                <input
                  ref={joinInputRef}
                  value={joinBoardId}
                  onChange={handleJoinInputChange}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") handleJoinBoard();
                  }}
                  placeholder="Paste shared board ID"
                  aria-label="Board ID"
                  className="pill-input flex-1 min-w-0"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
                <button
                  type="button"
                  className="ghost-button button-sm pressable"
                  onClick={handlePasteBoardId}
                >
                  Paste
                </button>
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                className="accent-button button-sm pressable flex-1 justify-center"
                onClick={handleJoinBoard}
                disabled={!joinBoardId.trim()}
              >
                Join board
              </button>
              <button
                type="button"
                className="ghost-button button-sm pressable flex-1 justify-center"
                onClick={toggleScanner}
              >
                {scannerActive ? "Close scanner" : "Scan QR"}
              </button>
            </div>
            {scannerActive && (
              <div className="rounded-2xl border border-surface bg-surface-muted p-2 space-y-2">
                <div className="share-mode-header">
                  <div className="text-xs uppercase tracking-wide text-secondary">Scanner</div>
                  <button
                    type="button"
                    className="share-mode-info-button pressable"
                    aria-label="About scanning boards"
                    aria-expanded={infoOpen === "scan"}
                    aria-controls="add-board-scan-info"
                    onClick={() => toggleInfo("scan")}
                    ref={setInfoButtonRef("scan")}
                  >
                    <span className="share-mode-info-button__icon" aria-hidden="true">i</span>
                  </button>
                  {infoOpen === "scan" && (
                    <div
                      className="share-mode-info"
                      role="tooltip"
                      id="add-board-scan-info"
                      ref={setInfoPanelRef("scan")}
                    >
                      <div className="share-mode-info__text">
                        Scanning adds the board automatically. If the camera fails, paste the ID instead.
                      </div>
                    </div>
                  )}
                </div>
                <BoardQrScanner
                  active={scannerActive}
                  onDetected={handleScanDetected}
                  onError={setScannerStatus}
                />
                {scannerStatus && <div className="text-xs text-rose-400">{scannerStatus}</div>}
              </div>
            )}
            {joinStatus && <div className={`text-xs ${joinStatusClass}`}>{joinStatus.message}</div>}
          </section>
        </div>
      </div>
    </Modal>
  );
}
