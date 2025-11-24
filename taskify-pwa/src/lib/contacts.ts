import { LS_LIGHTNING_CONTACTS } from "../localStorageKeys";

export type Contact = {
  id: string;
  name: string;
  address: string;
  paymentRequest: string;
  npub: string;
};

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function makeContactId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function normalizeContact(raw: any): Contact | null {
  if (!raw || typeof raw !== "object") return null;
  const name = normalizeString(raw.name);
  const address = normalizeString(raw.address);
  const paymentRequest = normalizeString(raw.paymentRequest);
  const npub = normalizeString(raw.npub);
  if (!name.trim() && !address.trim() && !paymentRequest.trim() && !npub.trim()) {
    return null;
  }
  const id = typeof raw.id === "string" && raw.id ? raw.id : makeContactId();
  return { id, name, address, paymentRequest, npub };
}

export function loadContactsFromStorage(): Contact[] {
  try {
    const saved = localStorage.getItem(LS_LIGHTNING_CONTACTS);
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => normalizeContact(entry)).filter(Boolean) as Contact[];
  } catch {
    return [];
  }
}

export function saveContactsToStorage(contacts: Contact[]): void {
  try {
    localStorage.setItem(LS_LIGHTNING_CONTACTS, JSON.stringify(contacts));
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("taskify:contacts-updated"));
    }
  } catch (error) {
    console.warn("Unable to save contacts", error);
  }
}

export function contactDisplayLabel(contact: Contact): string {
  return (
    contact.name?.trim() ||
    contact.address?.trim() ||
    contact.paymentRequest?.trim() ||
    contact.npub?.trim() ||
    "Contact"
  );
}

export function contactHasNpub(contact: Contact): boolean {
  return contact.npub.trim().length > 0;
}
