import { useState, useCallback, useEffect, useMemo } from "react";
import type { Contact } from "../../lib/contacts";
import { contactPrimaryName } from "../../lib/contacts";
import { ActionSheet } from "../../components/ActionSheet";
import { VerifiedBadgeIcon } from "../icons";

type LockRecipientSelection = {
  value: string;
  label: string;
  contactId?: string;
};

type QuickLockOption = {
  id: string;
  title: string;
  value: string;
  label: string;
  contactId?: string;
};

type Nip05CheckState = {
  status: "pending" | "valid" | "invalid";
  nip05: string;
  npub: string;
  checkedAt: number;
  contactUpdatedAt?: number | null;
};

function contactVerifiedNip05(contact: Contact, cache: Record<string, Nip05CheckState>): string | null {
  const npub = contact.npub?.trim();
  if (!npub) return null;
  const entry = cache[npub];
  if (!entry || entry.status !== "valid") return null;
  return entry.nip05 || null;
}

function startsWithEmoji(str: string): boolean {
  const cp = str.codePointAt(0);
  if (cp === undefined) return false;
  return (cp >= 0x2600 && cp <= 0x27bf) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x1f900 && cp <= 0x1f9ff);
}

function contactInitials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (startsWithEmoji(parts[0])) return [...parts[0]][0] ?? "?";
  if (parts.length >= 2) {
    return `${[...parts[0]][0] ?? ""}${[...parts[parts.length - 1]][0] ?? ""}`.toUpperCase();
  }
  return [...parts[0]].slice(0, 2).join("").toUpperCase();
}

function LockToNpubSheet({
  open,
  onClose,
  contacts,
  quickOptions,
  nip05Cache,
  onSelect,
  selected,
}: {
  open: boolean;
  onClose: () => void;
  contacts: Contact[];
  quickOptions: QuickLockOption[];
  nip05Cache: Record<string, Nip05CheckState>;
  onSelect: (selection: LockRecipientSelection) => void;
  selected?: LockRecipientSelection | null;
}) {
  const [manualValue, setManualValue] = useState("");
  const npubContacts = useMemo(
    () => contacts.filter((contact) => contact.npub.trim().length > 0),
    [contacts],
  );
  useEffect(() => {
    if (!open) {
      setManualValue("");
    }
  }, [open]);

  const shortenNpub = useCallback((value: string) => {
    if (value.length <= 28) return value;
    return `${value.slice(0, 12)}…${value.slice(-6)}`;
  }, []);

  const shortenName = useCallback((value: string) => {
    const trimmed = value.trim();
    if (trimmed.length <= 24) return trimmed;
    return `${trimmed.slice(0, 20)}…`;
  }, []);

  const shortenDisplay = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (trimmed.toLowerCase().startsWith("npub")) return shortenNpub(trimmed);
      return shortenName(trimmed);
    },
    [shortenName, shortenNpub],
  );
  const selectedValue = selected?.value?.trim() || "";

  const handleSelect = useCallback(
    (value: string, label: string, contactId?: string) => {
      onSelect({ value, label, contactId });
      onClose();
    },
    [onClose, onSelect],
  );

  return (
    <ActionSheet open={open} onClose={onClose} title="Lock to npub" stackLevel={90}>
      <div className="wallet-section space-y-4 text-sm">
        {quickOptions.length > 0 && (
          <div className="space-y-2">
            <div className="text-sm font-medium">Quick select</div>
            <div className="flex flex-wrap gap-2 text-xs">
              {quickOptions.map((option) => {
                const optionValue = option.value.trim();
                const isActive = !!selectedValue && selectedValue === optionValue;
                const optionClass = isActive ? "accent-button button-sm pressable" : "ghost-button button-sm pressable";
                const optionLabel = shortenDisplay(option.label);
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={optionClass}
                    onClick={() => handleSelect(optionValue, option.label, option.contactId)}
                    disabled={isActive}
                  >
                    <span className="text-secondary">{option.title}:</span>
                    <span className="font-semibold text-primary">{optionLabel}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Contacts with npub</div>
          </div>
          {npubContacts.length > 0 ? (
            <div className="space-y-2">
              {npubContacts.map((contact) => {
                const trimmed = contact.npub.trim();
                const contactName = contact.name?.trim();
                const verifiedNip05 = contactVerifiedNip05(contact, nip05Cache);
                const labelValue = contactName || contactPrimaryName(contact) || trimmed;
                const primaryDisplay = shortenDisplay(labelValue);
                const subtitleDisplay = verifiedNip05 || shortenNpub(trimmed);
                const initials = contactInitials(labelValue);
                const photo = contact.picture?.trim();
                const isSelected = !!selectedValue && selectedValue === trimmed;
                return (
                  <button
                    key={contact.id}
                    type="button"
                    className={`w-full text-left rounded-2xl border border-surface bg-surface p-3 ${isSelected ? "ring-2 ring-accent/50" : "pressable"}`}
                    onClick={() => handleSelect(trimmed, labelValue, contact.id)}
                    disabled={isSelected}
                    aria-pressed={isSelected}
                    title={trimmed}
                  >
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-full bg-surface-muted text-primary font-semibold flex items-center justify-center uppercase overflow-hidden">
                        {photo ? (
                          <img src={photo} alt={labelValue} className="h-full w-full object-cover" />
                        ) : (
                          initials
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <div className="font-semibold truncate">{primaryDisplay}</div>
                          {isSelected && <div className="text-[11px] font-semibold text-accent">Selected</div>}
                        </div>
                        <div className="text-[11px] text-secondary break-all flex items-center gap-1">
                          <span>{subtitleDisplay}</span>
                          {verifiedNip05 && (
                            <VerifiedBadgeIcon className="contact-nip05__badge" aria-label="Verified NIP-05" />
                          )}
                        </div>
                      </div>
                      <span className="text-secondary">›</span>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="text-secondary text-sm">
              No saved contacts with a npub yet. Add one from the Contacts tab to lock bounties to a teammate.
            </div>
          )}
        </div>
        <div className="space-y-2">
          <div className="text-sm font-medium">Manual input</div>
          <input
            className="pill-input w-full"
            placeholder="npub1… or hex pubkey"
            value={manualValue}
            onChange={(e) => setManualValue(e.target.value)}
          />
          <div className="flex flex-wrap gap-2 text-xs">
            <button
              className="accent-button button-sm pressable"
              type="button"
              onClick={() => {
                const trimmed = manualValue.trim();
                if (!trimmed) return;
                handleSelect(trimmed, shortenNpub(trimmed));
                setManualValue("");
              }}
              disabled={!manualValue.trim()}
            >
              Use npub
            </button>
            <button
              className="ghost-button button-sm pressable"
              type="button"
              onClick={() => setManualValue("")}
            >
              Clear
            </button>
          </div>
        </div>
      </div>
    </ActionSheet>
  );
}

export { LockToNpubSheet };
export type { LockRecipientSelection, QuickLockOption, Nip05CheckState };
