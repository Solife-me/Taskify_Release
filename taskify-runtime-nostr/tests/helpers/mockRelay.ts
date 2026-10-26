// A minimal Nostr relay for tests: NIP-01 over a hand-rolled WebSocket, NIP-11, NIP-42 and NIP-13.
import { createServer, type IncomingMessage } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import { verifyEvent, type NostrEvent } from "nostr-tools";

export type MockRelayOptions = {
  /** Writes and reads need NIP-42 authentication. */
  requireAuth?: boolean;
  /** Send the challenge only once an unauthenticated client asks for something. */
  lazyChallenge?: boolean;
  /** Refuse every AUTH event with this message (e.g. a whitelist relay). */
  rejectAuth?: string;
  /** NIP-13 difficulty every stored event needs. */
  powDifficulty?: number;
  /** Advertise `powDifficulty` in NIP-11 (otherwise the relay only says so when it refuses). */
  advertisePow?: boolean;
};

export type MockRelay = {
  url: string;
  events: NostrEvent[];
  /** Every EVENT received, accepted or not. */
  received: NostrEvent[];
  authedPubkeys: string[];
  close: () => Promise<void>;
};

function leadingZeroBits(hex: string): number {
  let count = 0;
  for (const character of hex) {
    const value = Number.parseInt(character, 16);
    if (value === 0) { count += 4; continue; }
    return count + Math.clz32(value) - 28;
  }
  return count;
}

function encodeFrame(text: string, opcode = 0x1): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = payload.length < 126
    ? Buffer.from([0x80 | opcode, payload.length])
    : payload.length < 65536
      ? Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff])
      : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(payload.length), 2); return h; })();
  return Buffer.concat([header, payload]);
}

function matches(event: NostrEvent, filter: Record<string, unknown>): boolean {
  if (Array.isArray(filter.kinds) && !filter.kinds.includes(event.kind)) return false;
  if (Array.isArray(filter.authors) && !filter.authors.includes(event.pubkey)) return false;
  if (Array.isArray(filter.ids) && !filter.ids.includes(event.id)) return false;
  if (typeof filter.since === "number" && event.created_at < filter.since) return false;
  if (typeof filter.until === "number" && event.created_at > filter.until) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(values)) continue;
    const name = key.slice(1);
    if (!event.tags.some((tag) => tag[0] === name && values.includes(tag[1]))) return false;
  }
  return true;
}

export async function startMockRelay(options: MockRelayOptions = {}): Promise<MockRelay> {
  const events: NostrEvent[] = [];
  const received: NostrEvent[] = [];
  const authedPubkeys: string[] = [];
  const sockets = new Set<Duplex>();
  const difficulty = options.powDifficulty ?? 0;

  const server = createServer((request, response) => {
    if (String(request.headers.accept || "").includes("application/nostr+json")) {
      response.writeHead(200, { "content-type": "application/nostr+json" });
      response.end(JSON.stringify({
        name: "mock relay",
        supported_nips: [1, 11, 13, 42],
        limitation: {
          auth_required: Boolean(options.requireAuth),
          min_pow_difficulty: options.advertisePow ? difficulty : 0,
        },
      }));
      return;
    }
    response.writeHead(404).end();
  });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);

    const challenge = randomBytes(16).toString("hex");
    let challenged = false;
    let authed = false;
    const send = (message: unknown[]) => { if (!socket.destroyed) socket.write(encodeFrame(JSON.stringify(message))); };
    const challengeOnce = () => {
      if (challenged) return;
      challenged = true;
      send(["AUTH", challenge]);
    };
    if (!options.lazyChallenge) challengeOnce();

    const handle = (message: unknown[]) => {
      const [type] = message;
      if (type === "AUTH") {
        const event = message[1] as NostrEvent;
        const tag = (name: string) => event?.tags?.find((t) => t[0] === name)?.[1];
        if (!event || event.kind !== 22242 || tag("challenge") !== challenge || !verifyEvent(event)) {
          send(["OK", event?.id ?? "", false, "invalid: bad auth event"]);
        } else if (options.rejectAuth) {
          send(["OK", event.id, false, options.rejectAuth]);
        } else {
          authed = true;
          authedPubkeys.push(event.pubkey);
          send(["OK", event.id, true, ""]);
        }
        return;
      }
      if (type === "EVENT") {
        const event = message[1] as NostrEvent;
        received.push(event);
        if (!verifyEvent(event)) return send(["OK", event.id, false, "invalid: bad signature"]);
        if (options.requireAuth && !authed) {
          challengeOnce();
          return send(["OK", event.id, false, "auth-required: authenticate to write"]);
        }
        const work = leadingZeroBits(event.id);
        if (work < difficulty) return send(["OK", event.id, false, `pow: difficulty ${work} is less than ${difficulty}`]);
        const dTag = event.tags.find((t) => t[0] === "d")?.[1];
        const replaceable = event.kind >= 30000 && event.kind < 40000;
        if (replaceable) {
          const index = events.findIndex((e) => e.kind === event.kind && e.pubkey === event.pubkey && e.tags.find((t) => t[0] === "d")?.[1] === dTag);
          if (index >= 0 && events[index].created_at > event.created_at) return send(["OK", event.id, true, "duplicate: have newer"]);
          if (index >= 0) events.splice(index, 1);
        }
        events.push(event);
        return send(["OK", event.id, true, ""]);
      }
      if (type === "REQ") {
        const [, subId, ...filters] = message as [string, string, ...Record<string, unknown>[]];
        if (options.requireAuth && !authed) {
          challengeOnce();
          return send(["CLOSED", subId, "auth-required: authenticate to read"]);
        }
        for (const event of events) {
          if (filters.some((filter) => matches(event, filter))) send(["EVENT", subId, event]);
        }
        return send(["EOSE", subId]);
      }
    };

    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        const maskOffset = offset;
        if (masked) offset += 4;
        if (buffer.length < offset + length) return;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        if (masked) for (let i = 0; i < payload.length; i += 1) payload[i] ^= buffer[maskOffset + (i % 4)];
        buffer = buffer.subarray(offset + length);
        if (opcode === 0x8) { socket.end(encodeFrame("", 0x8)); return; }
        if (opcode === 0x9) { socket.write(encodeFrame(payload.toString("utf8"), 0xa)); continue; }
        if (opcode !== 0x1) continue;
        try { handle(JSON.parse(payload.toString("utf8"))); } catch { /* ignore malformed frames */ }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock relay failed to listen");
  return {
    url: `ws://127.0.0.1:${address.port}/`,
    events,
    received,
    authedPubkeys,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
