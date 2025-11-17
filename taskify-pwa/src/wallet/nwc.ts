import { finalizeEvent, getPublicKey, nip04, nip19, type EventTemplate } from "nostr-tools";

export type ParsedNwcUri = {
  uri: string;
  relayUrls: string[];
  walletPubkey: string; // hex
  walletNpub: string;
  clientSecretHex: string;
  clientSecretBytes: Uint8Array;
  clientPubkey: string; // hex
  clientNpub: string;
  walletName?: string;
  walletLud16?: string;
};

export type NwcResponse<T> = {
  result?: T;
  error?: { code?: string; message?: string };
};

const NWC_EVENT_KIND_REQUEST = 23194;
const NWC_EVENT_KIND_RESPONSE = 23195;

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "");
  if (clean.length % 2 !== 0) throw new Error("Invalid hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = clean.slice(i * 2, i * 2 + 2);
    out[i] = parseInt(byte, 16);
    if (Number.isNaN(out[i])) throw new Error("Invalid hex");
  }
  return out;
}

function normalizeRelay(url: string): string {
  const clean = (input: string) => {
    const parsed = new URL(input);
    const proto = parsed.protocol.toLowerCase();
    if (proto !== "wss:" && proto !== "ws:") throw new Error();
    parsed.hash = "";
    let pathname = parsed.pathname || "/";
    if (!pathname.startsWith("/")) pathname = `/${pathname}`;
    const search = parsed.search || "";
    return `${proto}//${parsed.host}${pathname}${search}`;
  };
  try {
    return clean(url);
  } catch {
    try {
      return clean(`wss://${url}`);
    } catch {
      throw new Error(`Invalid relay URL: ${url}`);
    }
  }
}

function decodePubkey(raw: string): { hex: string; npub: string; relays?: string[] } {
  const cleaned = raw.trim();
  if (!cleaned) throw new Error("Missing wallet pubkey");
  try {
    const decoded = nip19.decode(cleaned);
    if (decoded.type === "npub") {
      return { hex: decoded.data as string, npub: cleaned };
    }
    if (decoded.type === "nprofile") {
      const data = decoded.data as { pubkey: string; relays?: string[] };
      return { hex: data.pubkey, npub: nip19.npubEncode(data.pubkey), relays: data.relays };
    }
    if (decoded.type === "pubkey") {
      const hex = decoded.data as string;
      return { hex, npub: nip19.npubEncode(hex) };
    }
  } catch {}
  const hexMatch = cleaned.match(/^[0-9a-fA-F]{64}$/);
  if (hexMatch) {
    const hex = cleaned.toLowerCase();
    return { hex, npub: nip19.npubEncode(hex) };
  }
  throw new Error("Unsupported wallet pubkey format");
}

function decodeSecret(raw: string | null): { hex: string } {
  if (!raw) throw new Error("NWC secret missing");
  const cleaned = raw.trim();
  if (!cleaned) throw new Error("NWC secret missing");
  try {
    const decoded = nip19.decode(cleaned);
    if (decoded.type === "nsec") {
      return { hex: decoded.data as string };
    }
  } catch {}
  if (/^[0-9a-fA-F]{64}$/.test(cleaned)) {
    return { hex: cleaned.toLowerCase() };
  }
  throw new Error("Unsupported NWC secret format");
}

export function parseNwcUri(input: string): ParsedNwcUri {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter NWC connection URL");
  const prefixMatch = trimmed.match(/^nostr\+walletconnect:\/+(.+)$/i);
  if (!prefixMatch) throw new Error("Invalid NWC URL (must start with nostr+walletconnect://)");
  const remainder = prefixMatch[1];
  const [targetPart, queryPart = ""] = remainder.split("?");
  if (!targetPart) throw new Error("NWC URL missing wallet pubkey");
  const { hex: walletPubkey, npub: walletNpub, relays: relaysFromProfile } = decodePubkey(targetPart);

  const params = new URLSearchParams(queryPart);
  const relayParams = params.getAll("relay").filter(Boolean);
  const relays = new Set<string>();
  for (const r of relaysFromProfile || []) {
    try { relays.add(normalizeRelay(r)); } catch {}
  }
  for (const r of relayParams) {
    try { relays.add(normalizeRelay(r)); } catch {}
  }
  if (!relays.size) throw new Error("NWC URL must include at least one relay");

  const { hex: clientSecretHex } = decodeSecret(params.get("secret"));
  const clientSecretBytes = hexToBytes(clientSecretHex);
  const clientPubkey = getPublicKey(clientSecretBytes);
  const clientNpub = nip19.npubEncode(clientPubkey);

  return {
    uri: trimmed,
    relayUrls: Array.from(relays),
    walletPubkey,
    walletNpub,
    clientSecretHex,
    clientSecretBytes,
    clientPubkey,
    clientNpub,
    walletName: params.get("name") || undefined,
    walletLud16: params.get("lud16") || undefined,
  };
}

export class NwcClient {
  constructor(private readonly connection: ParsedNwcUri) {}

  async request<T = unknown>(method: string, params: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T> {
    const { relayUrls } = this.connection;
    if (!relayUrls.length) throw new Error("No relay configured for NWC connection");
    let lastError: Error | null = null;
    for (const relay of relayUrls) {
      try {
        return await this.requestViaRelay<T>(relay, method, params, opts?.timeoutMs);
      } catch (err: any) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastError || new Error("Failed to contact NWC relay");
  }

  private requestViaRelay<T>(relayUrl: string, method: string, params: Record<string, unknown>, timeoutMs = 20000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let ws: WebSocket | null = null;
      let requestEventId = "";
      const subId = `nwc-${Math.random().toString(36).slice(2, 9)}`;

      const finish = (err: Error | null, value?: T) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
        try {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(["CLOSE", subId]));
          }
        } catch {}
        try { ws?.close(); } catch {}
        ws = null;
        if (err) reject(err);
        else resolve(value as T);
      };

      const handleResponse = async (data: any) => {
        if (!Array.isArray(data)) return;
        const [type, ...rest] = data;
        if (type === "EVENT") {
          const [incomingSubId, ev] = rest as [string, any];
          if (incomingSubId !== subId) return;
          if (!ev || ev.kind !== NWC_EVENT_KIND_RESPONSE) return;
          const eTag = Array.isArray(ev.tags) ? ev.tags.find((t: string[]) => t[0] === "e") : null;
          if (eTag && requestEventId && eTag[1] && eTag[1] !== requestEventId) return;
          try {
            const decrypted = await nip04.decrypt(this.connection.clientSecretHex, this.connection.walletPubkey, ev.content);
            const payload = JSON.parse(decrypted) as NwcResponse<T>;
            if (payload.error) {
              const msg = payload.error.message || payload.error.code || "NWC request failed";
              finish(new Error(msg));
              return;
            }
            finish(null, payload.result as T);
          } catch (err: any) {
            finish(err instanceof Error ? err : new Error(String(err)));
          }
        } else if (type === "NOTICE") {
          const [msg] = rest as [string];
          console.warn("NWC relay notice", relayUrl, msg);
        }
      };

      try {
        ws = new WebSocket(relayUrl);
      } catch (err: any) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      ws.onopen = async () => {
        try {
          const payload = JSON.stringify({ method, params });
          const encrypted = await nip04.encrypt(this.connection.clientSecretHex, this.connection.walletPubkey, payload);
          const template: EventTemplate = {
            kind: NWC_EVENT_KIND_REQUEST,
            created_at: Math.floor(Date.now() / 1000),
            content: encrypted,
            tags: [["p", this.connection.walletPubkey], ["t", "nwc"]],
            pubkey: this.connection.clientPubkey,
          };
          const signed = finalizeEvent(template, this.connection.clientSecretBytes);
          requestEventId = signed.id;
          ws!.send(JSON.stringify(["REQ", subId, { kinds: [NWC_EVENT_KIND_RESPONSE], "#p": [this.connection.clientPubkey] }]));
          ws!.send(JSON.stringify(["EVENT", signed]));
        } catch (err: any) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      };

      ws.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data);
          handleResponse(data);
        } catch {
          // ignore malformed messages
        }
      };
      ws.onerror = () => {
        finish(new Error("NWC relay error"));
      };
      ws.onclose = () => {
        if (!settled) finish(new Error("NWC relay closed connection"));
      };
      timeoutHandle = setTimeout(() => finish(new Error("Timed out waiting for NWC response")), timeoutMs);
    });
  }
}
