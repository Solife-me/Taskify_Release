// @ts-nocheck
import React, { useState, useEffect, useCallback, useMemo } from "react";
import { getPublicKey, nip19 } from "nostr-tools";
import {
  LS_LIGHTNING_CONTACTS,
} from "../../localStorageKeys";
import { normalizeNostrPubkey } from "../../lib/nostr";
import { DEFAULT_NOSTR_RELAYS } from "../../lib/relays";
import {
  buildBoardShareEnvelope,
  sendShareMessage,
} from "../../lib/shareInbox";
import type { Contact } from "../../lib/contacts";
import {
  contactPrimaryName,
  formatContactNpub,
  loadContactsFromStorage,
  contactHasNpub,
} from "../../lib/contacts";
import { appendWalletHistoryEntry } from "../../domains/backup/backupUtils";
import type { Settings, PushPlatform } from "../../domains/tasks/settingsTypes";
import type { Board, Task } from "../../domains/tasks/taskTypes";
import { useCashu } from "../../context/CashuContext";
import { useToast } from "../../context/ToastContext";
import { ActionSheet } from "../../components/ActionSheet";
import { Modal } from "../Modal";
import { contactInitials, hexToBytes } from "./settingsConstants";
import { BoardsSection } from "./BoardsSection";
import { ViewSection } from "./ViewSection";
import { WalletSection } from "./WalletSection";
import { BibleSection } from "./BibleSection";
import { PushSection } from "./PushSection";
import { NostrSection } from "./NostrSection";
import { BackupSection } from "./BackupSection";
import { GoogleCalendarSection } from "./GoogleCalendarSection";
import type { GcalCalendar, GcalConnectionStatus } from "../../hooks/useGoogleCalendar";
import { ManageBoardModal } from "./ManageBoardModal";


export function SettingsModal({
  embedded,
  settings,
  boards,
  currentBoardId,
  setSettings,
  setBoards,
  setTasks,
  changeBoard,
  shouldReloadForNavigation,
  defaultRelays,
  setDefaultRelays,
  pubkeyHex,
  onGenerateKey,
  onSetKey,
  onShareBoard,
  onJoinBoard,
  onRegenerateBoardId,
  onBoardChanged,
  onClose,
  pushWorkState,
  pushError,
  onEnablePush,
  onDisablePush,
  workerBaseUrl,
  vapidPublicKey,
  onResetWalletTokenTracking,
  gcalStatus,
  gcalCalendars,
  gcalLoading,
  onGcalConnect,
  onGcalDisconnect,
  onGcalToggleCalendar,
  onGcalSync,
}: {
  embedded?: boolean;
  settings: Settings;
  boards: Board[];
  currentBoardId: string;
  setSettings: (s: Partial<Settings>) => void;
  setBoards: React.Dispatch<React.SetStateAction<Board[]>>;
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  changeBoard: (id: string) => void;
  shouldReloadForNavigation: () => boolean;
  defaultRelays: string[];
  setDefaultRelays: (rls: string[]) => void;
  pubkeyHex: string;
  onGenerateKey: () => void;
  onSetKey: (hex: string) => void;
  onShareBoard: (boardId: string, relaysCsv?: string) => void;
  onJoinBoard: (nostrId: string, name?: string, relaysCsv?: string) => void;
  onRegenerateBoardId: (boardId: string) => void;
  onBoardChanged: (
    boardId: string,
    options?: { republishTasks?: boolean; board?: Board },
  ) => void;
  onClose: () => void;
  pushWorkState: "idle" | "enabling" | "disabling";
  pushError: string | null;
  onEnablePush: (platform: PushPlatform) => Promise<void>;
  onDisablePush: () => Promise<void>;
  workerBaseUrl: string;
  vapidPublicKey: string;
  onResetWalletTokenTracking: () => void;
  gcalStatus: GcalConnectionStatus;
  gcalCalendars: GcalCalendar[];
  gcalLoading: boolean;
  onGcalConnect: () => void;
  onGcalDisconnect: () => void;
  onGcalToggleCalendar: (id: string, selected: boolean) => void;
  onGcalSync: () => void;
}) {
  const { show: showToast } = useToast();
  const { mintUrl, payInvoice } = useCashu();

  // ─── Cross-cutting state ────────────────────────────────────────────────────
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [manageBoardId, setManageBoardId] = useState<string | null>(null);
  const manageBoard = boards.find(b => b.id === manageBoardId);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Share board picker
  const [contacts, setContacts] = useState<Contact[]>(() => loadContactsFromStorage());
  const [shareBoardPickerOpen, setShareBoardPickerOpen] = useState(false);
  const [shareBoardTarget, setShareBoardTarget] = useState<Board | null>(null);
  const [shareBoardStatus, setShareBoardStatus] = useState<string | null>(null);
  const [shareBoardBusy, setShareBoardBusy] = useState(false);

  // Donate
  const [donateAmt, setDonateAmt] = useState("");
  const [donateComment, setDonateComment] = useState("");
  const [donateState, setDonateState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [donateMsg, setDonateMsg] = useState("");

  // AI import
  const taskifyAiInstructionBlock = useMemo(() => [
    "When I ask \"create a Taskify task/event\", return JSON Taskify can import.",
    "",
    "Rules:",
    "- Use conversation context.",
    "- If date/time/timezone is missing, make a reasonable assumption.",
    "- Output JSON only (no explanation text).",
    "- Use plain ASCII double quotes only (\") and valid JSON.",
    "- Escape quotes inside string values (or write 1.5 in instead of 1.5\").",
    "- Do not include app-generated fields: id, boardId, column, columnId, createdAt, createdBy, completed.",
    "- Root format must be one of: {\"items\":[...]}, [...], or a single object.",
    "",
    "Task template:",
    "{\"type\":\"task\",\"title\":\"...\",\"note\":\"...\",\"priority\":1,\"dueISO\":\"2026-03-01T15:00:00.000Z\",\"dueDateEnabled\":true,\"dueTimeEnabled\":true,\"dueTimeZone\":\"America/New_York\",\"reminders\":[\"15m\"],\"reminderTime\":\"09:00\",\"subtasks\":[{\"title\":\"...\",\"completed\":false}],\"recurrence\":{\"type\":\"daily\"}}",
    "",
    "Timed event template:",
    "{\"type\":\"event\",\"kind\":\"time\",\"title\":\"...\",\"description\":\"...\",\"startISO\":\"2026-03-01T16:00:00.000Z\",\"endISO\":\"2026-03-01T16:30:00.000Z\",\"startTzid\":\"America/New_York\",\"endTzid\":\"America/New_York\",\"reminders\":[\"15m\"],\"recurrence\":{\"type\":\"weekly\",\"days\":[1,3,5]}}",
    "",
    "All-day event template:",
    "{\"type\":\"event\",\"kind\":\"date\",\"title\":\"...\",\"startDate\":\"2026-03-01\",\"endDate\":\"2026-03-03\",\"reminderTime\":\"09:00\"}",
    "",
    "Reminder IDs: \"0h\",\"5m\",\"15m\",\"30m\",\"1h\",\"1d\",\"1w\",\"0d\", or \"custom-<signed_minutes>\" (for example: \"custom--30\" or \"custom-90\").",
    "Recurrence: {\"type\":\"none\"}, {\"type\":\"daily\"}, or {\"type\":\"weekly\",\"days\":[0-6]} with optional \"untilISO\".",
  ].join("\n"), []);

  // ─── Derived ────────────────────────────────────────────────────────────────
  const currentBoard = useMemo(
    () => boards.find((board) => board.id === currentBoardId) || null,
    [boards, currentBoardId],
  );
  const shareableContacts = useMemo(
    () => contacts.filter((contact) => contactHasNpub(contact)),
    [contacts],
  );

  // ─── Effects ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const refreshContacts = () => setContacts(loadContactsFromStorage());
    const handleStorage = (event: StorageEvent) => {
      if (event.key === LS_LIGHTNING_CONTACTS) {
        refreshContacts();
      }
    };
    window.addEventListener("taskify:contacts-updated", refreshContacts);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("taskify:contacts-updated", refreshContacts);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  useEffect(() => {
    if (manageBoard?.nostr) return;
    if (shareBoardPickerOpen) setShareBoardPickerOpen(false);
    setShareBoardTarget(null);
    setShareBoardStatus(null);
    setShareBoardBusy(false);
  }, [manageBoard?.nostr, shareBoardPickerOpen]);

  // ─── Callbacks ──────────────────────────────────────────────────────────────
  const onReloadNeeded = useCallback(() => {
    setReloadNeeded(true);
  }, []);

  const readNostrSecret = useCallback((): string | null => {
    const { kvStorage } = require("../../storage/kvStorage");
    const { LS_NOSTR_SK } = require("../../nostrKeys");
    try {
      const raw = kvStorage.getItem(LS_NOSTR_SK);
      if (raw && /^[0-9a-fA-F]{64}$/.test(raw.trim())) {
        return raw.trim().toLowerCase();
      }
    } catch {}
    return null;
  }, []);

  const handleShareBoardToContact = useCallback(
    async (contact: Contact) => {
      if (!shareBoardTarget?.nostr) {
        setShareBoardStatus("Enable sharing first.");
        return;
      }
      const recipient = normalizeNostrPubkey(contact.npub);
      if (!recipient) {
        setShareBoardStatus("Contact is missing a valid npub.");
        return;
      }
      const secret = readNostrSecret();
      if (!secret) {
        setShareBoardStatus("Add your Nostr secret key first.");
        return;
      }
      const relaySource = Array.isArray(shareBoardTarget.nostr.relays)
        ? shareBoardTarget.nostr.relays
        : defaultRelays.length
          ? defaultRelays
          : Array.from(DEFAULT_NOSTR_RELAYS);
      const relayList = relaySource
        .map((r) => (typeof r === "string" ? r.trim() : ""))
        .filter(Boolean);
      let senderNpub: string | null = null;
      try {
        const pubkey = getPublicKey(hexToBytes(secret));
        senderNpub = nip19.npubEncode(hexToBytes(pubkey));
      } catch {
        senderNpub = null;
      }
      setShareBoardBusy(true);
      setShareBoardStatus(null);
      try {
        const envelope = buildBoardShareEnvelope(
          shareBoardTarget.nostr.boardId,
          shareBoardTarget.name,
          relayList,
          senderNpub ? { npub: senderNpub } : undefined,
        );
        await sendShareMessage(envelope, recipient, secret, relayList);
        setShareBoardPickerOpen(false);
        showToast(`Board sent to ${contactPrimaryName(contact)}`);
      } catch (err: any) {
        setShareBoardStatus(err?.message || "Unable to share board.");
      } finally {
        setShareBoardBusy(false);
      }
    },
    [defaultRelays, readNostrSecret, shareBoardTarget, showToast],
  );

  const handleCopyTaskifyAiInstructions = useCallback(async () => {
    try {
      await navigator.clipboard?.writeText(taskifyAiInstructionBlock);
      showToast("Taskify AI instructions copied", 2000);
    } catch {
      showToast("Unable to copy instructions", 2000);
    }
  }, [showToast, taskifyAiInstructionBlock]);



  async function handleDonate() {
    setDonateState("sending");
    setDonateMsg("");
    try {
      const amtSat = Math.max(0, Math.floor(Number(donateAmt) || 0));
      if (!amtSat) throw new Error("Enter amount in sats");
      if (!mintUrl) throw new Error("Set a Cashu mint in Wallet first");

      const lnAddress = "dev@solife.me";
      const [name, domain] = lnAddress.split("@");
      const infoRes = await fetch(`https://${domain}/.well-known/lnurlp/${name}`);
      if (!infoRes.ok) throw new Error("Unable to fetch LNURL pay info");
      const info = await infoRes.json();

      const minSat = Math.ceil((info?.minSendable || 0) / 1000);
      const maxSat = Math.floor((info?.maxSendable || Infinity) / 1000);
      if (amtSat < minSat) throw new Error(`Minimum is ${minSat} sats`);
      if (amtSat > maxSat) throw new Error(`Maximum is ${maxSat} sats`);

      const commentAllowed: number = Number(info?.commentAllowed || 0) || 0;
      const comment = (donateComment || "").trim();
      if (comment && commentAllowed > 0 && comment.length > commentAllowed) {
        throw new Error(`Comment too long (max ${commentAllowed} chars)`);
      }

      const params = new URLSearchParams({ amount: String(amtSat * 1000) });
      if (comment) params.set("comment", comment);
      const invRes = await fetch(`${info.callback}?${params.toString()}`);
      if (!invRes.ok) throw new Error("Failed to get invoice");
      const inv = await invRes.json();
      if (inv?.status === "ERROR") throw new Error(inv?.reason || "Invoice error");

      const invoice = inv.pr;
      const paymentResult = await payInvoice(invoice);
      const donationSummary = comment
        ? `Donated ${amtSat} sats to ${lnAddress} • ${comment}`
        : `Donated ${amtSat} sats to ${lnAddress}`;

      appendWalletHistoryEntry({
        id: `donate-${Date.now()}`,
        summary: donationSummary,
        detail: invoice,
        detailKind: "invoice",
        type: "lightning",
        direction: "out",
        amountSat: amtSat,
        feeSat: paymentResult?.feeReserveSat ?? undefined,
        mintUrl: paymentResult?.mintUrl ?? mintUrl ?? undefined,
      });

      setDonateState("done");
      setDonateMsg("Thank you for your support! - The Solife team");
      setDonateAmt("");
      setDonateComment("");
    } catch (e: any) {
      setDonateState("error");
      setDonateMsg(e?.message || String(e));
    }
  }

  const handleClose = useCallback(() => {
    onClose();
    if (reloadNeeded) {
      setTimeout(() => window.location.reload(), 150);
    }
  }, [onClose, reloadNeeded]);

  const handleOpenSharePicker = useCallback((board: Board) => {
    setShareBoardTarget(board);
    setShareBoardStatus(null);
    setShareBoardPickerOpen(true);
  }, []);

  // ─── Render ─────────────────────────────────────────────────────────────────
  const settingsBody = (
    <div className="space-y-2">

        {/* Boards & Columns */}
        <BoardsSection
          boards={boards}
          currentBoardId={currentBoardId}
          setBoards={setBoards}
          setTasks={setTasks}
          changeBoard={changeBoard}
          shouldReloadForNavigation={shouldReloadForNavigation}
          onJoinBoard={onJoinBoard}
          onBoardChanged={onBoardChanged}
          onManageBoard={(id) => setManageBoardId(id)}
          onClose={handleClose}
        />

        {/* View */}
        <ViewSection
          settings={settings}
          setSettings={setSettings}
          boards={boards}
        />

        {/* Wallet */}
        <WalletSection
          settings={settings}
          setSettings={setSettings}
          defaultRelays={defaultRelays}
          onReloadNeeded={onReloadNeeded}
          onResetWalletTokenTracking={onResetWalletTokenTracking}
        />

        {/* Bible */}
        <BibleSection
          settings={settings}
          setSettings={setSettings}
          boards={boards}
          currentBoard={currentBoard}
        />

        {/* Push notifications */}
        <PushSection
          pushPrefs={settings.pushNotifications}
          pushWorkState={pushWorkState}
          pushError={pushError}
          onEnablePush={onEnablePush}
          onDisablePush={onDisablePush}
          workerBaseUrl={workerBaseUrl}
          vapidPublicKey={vapidPublicKey}
        />

        {/* Connected Calendars */}
        <GoogleCalendarSection
          connectionStatus={gcalStatus}
          calendars={gcalCalendars}
          loading={gcalLoading}
          onConnect={onGcalConnect}
          onDisconnect={onGcalDisconnect}
          onSync={onGcalSync}
        />

        {/* Nostr */}
        <NostrSection
          settings={settings}
          setSettings={setSettings}
          defaultRelays={defaultRelays}
          setDefaultRelays={setDefaultRelays}
          pubkeyHex={pubkeyHex}
          onGenerateKey={onGenerateKey}
          onSetKey={onSetKey}
          showAdvanced={showAdvanced}
          setShowAdvanced={setShowAdvanced}
        />

        {/* Backup & Restore */}
        <BackupSection
          settings={settings}
          setSettings={setSettings}
          workerBaseUrl={workerBaseUrl}
          onReloadNeeded={onReloadNeeded}
        />

        {/* AI prompts */}
        <section className="wallet-section space-y-3">
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium">AI prompts</div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="text-sm font-medium">Task/event import prompt</div>
              <button
                className="ghost-button button-sm pressable ml-auto"
                onClick={handleCopyTaskifyAiInstructions}
              >
                Copy instructions
              </button>
            </div>
            <div className="text-xs text-secondary">
              Paste this prompt into your AI app, ask it to make Taskify tasks/events, then paste the JSON response into any
              board&apos;s add box.
            </div>
            <textarea
              readOnly
              value={taskifyAiInstructionBlock}
              className="pill-textarea w-full min-h-[16rem] font-mono text-[11px] leading-relaxed"
              spellCheck={false}
            />
          </div>


        </section>

        {/* Development donation */}
        <section className="wallet-section space-y-3">
          <div className="text-sm font-medium mb-2">Support development</div>
          <div className="text-xs text-secondary mb-3">Donate from your internal wallet to dev@solife.me</div>
          <div className="flex gap-2 mb-2 w-full">
            <input
              className="pill-input flex-1 min-w-[7rem]"
              placeholder="Amount (sats)"
              value={donateAmt}
              onChange={(e)=>setDonateAmt(e.target.value)}
              inputMode="numeric"
            />
            <button
              className="accent-button button-sm pressable shrink-0 whitespace-nowrap"
              onClick={handleDonate}
              disabled={!mintUrl || donateState === 'sending'}
            >Donate now</button>
          </div>
          <input
            className="pill-input w-full"
            placeholder="Comment (optional)"
            value={donateComment}
            onChange={(e)=>setDonateComment(e.target.value)}
          />
          <div className="mt-2 text-xs text-secondary">
            {donateState === 'sending' && <span>Sending…</span>}
            {donateState === 'done' && <span className="text-accent">{donateMsg}</span>}
            {donateState === 'error' && <span className="text-rose-400">{donateMsg}</span>}
          </div>
        </section>

        {/* Feedback / Feature requests */}
        <section className="wallet-section space-y-2 text-xs text-secondary">
          <div>
            Please submit feedback or feature requests to{' '}
            <button
              className="link-accent"
              onClick={async ()=>{ try { await navigator.clipboard?.writeText('dev@solife.me'); showToast('Copied dev@solife.me'); } catch {} }}
            >dev@solife.me</button>{' '}or share Board ID{' '}
            <button
              className="link-accent"
              onClick={async ()=>{ try { await navigator.clipboard?.writeText('c3db0d84-ee89-43df-a31e-edb4c75be32b'); showToast('Copied Board ID'); } catch {} }}
            >c3db0d84-ee89-43df-a31e-edb4c75be32b</button>
          </div>
        </section>

        {!embedded && (
          <div className="flex justify-end">
            <button className="ghost-button button-sm pressable" onClick={handleClose}>Close</button>
          </div>
        )}
      </div>
  );

  return (
    <>
      {embedded ? (
        <div className="modal-panel modal-panel--embedded">
          <div className="modal-panel__body modal-panel__body--embedded">
            {settingsBody}
          </div>
        </div>
      ) : (
        <Modal onClose={handleClose} title="Settings">
          {settingsBody}
        </Modal>
      )}
      {manageBoard && (
        <ManageBoardModal
          board={manageBoard}
          boards={boards}
          setBoards={setBoards}
          setTasks={setTasks}
          defaultRelays={defaultRelays}
          showAdvanced={showAdvanced}
          setShowAdvanced={setShowAdvanced}
          onShareBoard={onShareBoard}
          onBoardChanged={onBoardChanged}
          onRegenerateBoardId={onRegenerateBoardId}
          shouldReloadForNavigation={shouldReloadForNavigation}
          changeBoard={changeBoard}
          currentBoardId={currentBoardId}
          onClose={() => setManageBoardId(null)}
          onOpenSharePicker={handleOpenSharePicker}
        />
      )}
      <ActionSheet
        open={shareBoardPickerOpen}
        onClose={() => {
          if (shareBoardBusy) return;
          setShareBoardPickerOpen(false);
          setShareBoardStatus(null);
          setShareBoardTarget(null);
        }}
        title="Send board ID"
        stackLevel={75}
      >
        {shareBoardTarget ? (
          <div className="text-sm text-secondary mb-2">
            Choose a contact to send <span className="font-semibold">{shareBoardTarget.name}</span>.
          </div>
        ) : (
          <div className="text-sm text-secondary mb-2">Select a board to share first.</div>
        )}
        {shareBoardStatus && (
          <div className="text-sm text-rose-400 mb-2">{shareBoardStatus}</div>
        )}
        {shareableContacts.length ? (
          <div className="space-y-2">
            {shareableContacts.map((contact) => {
              const label = contactPrimaryName(contact);
              const subtitle = formatContactNpub(contact.npub);
              return (
                <button
                  key={contact.id}
                  type="button"
                  className="contact-row pressable"
                  disabled={shareBoardBusy || !shareBoardTarget}
                  onClick={() => shareBoardTarget && handleShareBoardToContact(contact)}
                >
                  <div className="contact-avatar">{contactInitials(label)}</div>
                  <div className="contact-row__text">
                    <div className="contact-row__name">{label}</div>
                    {subtitle ? (
                      <div className="contact-row__meta">
                        <span className="contact-row__meta-text">{subtitle}</span>
                      </div>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="text-sm text-secondary">Add a contact with an npub to share.</div>
        )}
        <div className="flex gap-2 mt-3">
          <button
            type="button"
            className="ghost-button button-sm pressable flex-1 justify-center"
            onClick={() => {
              if (shareBoardBusy) return;
              setShareBoardPickerOpen(false);
              setShareBoardStatus(null);
              setShareBoardTarget(null);
            }}
            disabled={shareBoardBusy}
          >
            Cancel
          </button>
        </div>
      </ActionSheet>
    </>
  );
}
