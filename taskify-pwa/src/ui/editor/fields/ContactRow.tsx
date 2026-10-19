/** One contact in the editors' pickers: initials, name and npub, with a check when chosen. */
import type { Contact } from "../../../lib/contacts";
import { contactPrimaryName, formatContactNpub } from "../../../lib/contacts";
import { contactInitials } from "../../../domains/tasks/contactUtils";

export function ContactRow({
  contact,
  onClick,
  selected,
  selectedLabel = "Selected",
  disabled = false,
}: {
  contact: Contact;
  onClick: () => void;
  /** Omit for a plain choice; true or false for a toggle. */
  selected?: boolean;
  selectedLabel?: string;
  disabled?: boolean;
}) {
  const label = contactPrimaryName(contact);
  const subtitle = formatContactNpub(contact.npub);
  return (
    <button
      type="button"
      className="contact-row pressable"
      onClick={onClick}
      aria-pressed={selected}
      disabled={disabled}
    >
      <div className="contact-avatar">{contactInitials(label)}</div>
      <div className="contact-row__text">
        <div className="contact-row__name flex items-center gap-2">
          <span className="min-w-0 truncate">{label}</span>
          {selected ? (
            <span className="text-xs text-secondary" aria-label={selectedLabel}>
              ✓
            </span>
          ) : null}
        </div>
        {subtitle ? (
          <div className="contact-row__meta">
            <span className="contact-row__meta-text">{subtitle}</span>
          </div>
        ) : null}
      </div>
    </button>
  );
}
