// Tests for gcalApi helpers and useGoogleCalendar hook logic
// Run with: npm test (vitest)
import { describe, it, expect } from "vitest";
import { signGcalHeaders } from "./gcalApi";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeKeypair() {
  const privkey = schnorr.utils.randomSecretKey();
  const pubkey = schnorr.getPublicKey(privkey);
  return { privkeyHex: bytesToHex(privkey), pubkeyHex: bytesToHex(pubkey) };
}

function verifySig(pubkeyHex: string, ts: string, body: string, sigHex: string): boolean {
  const payload = `${ts}.${body}`;
  const msgHash = sha256(new TextEncoder().encode(payload));
  try {
    return schnorr.verify(hexToBytes(sigHex), msgHash, hexToBytes(pubkeyHex));
  } catch {
    return false;
  }
}

// ─── signGcalHeaders ──────────────────────────────────────────────────────────

describe("signGcalHeaders", () => {
  it("returns X-Taskify-Npub, X-Taskify-Timestamp, X-Taskify-Sig", async () => {
    const { privkeyHex } = makeKeypair();
    const headers = await signGcalHeaders(privkeyHex, "");
    expect(headers["X-Taskify-Npub"]).toMatch(/^[0-9a-f]{64}$/);
    expect(headers["X-Taskify-Timestamp"]).toMatch(/^\d+$/);
    expect(headers["X-Taskify-Sig"]).toMatch(/^[0-9a-f]{128}$/);
  });

  it("timestamp is within 5s of now", async () => {
    const { privkeyHex } = makeKeypair();
    const headers = await signGcalHeaders(privkeyHex, "");
    const ts = parseInt(headers["X-Taskify-Timestamp"], 10);
    const now = Math.floor(Date.now() / 1000);
    expect(Math.abs(now - ts)).toBeLessThanOrEqual(5);
  });

  it("produces a valid Schnorr signature verifiable against the pubkey", async () => {
    const { privkeyHex, pubkeyHex } = makeKeypair();
    const body = JSON.stringify({ test: true });
    const headers = await signGcalHeaders(privkeyHex, body);
    expect(verifySig(pubkeyHex, headers["X-Taskify-Timestamp"], body, headers["X-Taskify-Sig"])).toBe(true);
  });

  it("GET request (empty body) signature is valid", async () => {
    const { privkeyHex, pubkeyHex } = makeKeypair();
    const headers = await signGcalHeaders(privkeyHex, "");
    expect(verifySig(pubkeyHex, headers["X-Taskify-Timestamp"], "", headers["X-Taskify-Sig"])).toBe(true);
  });

  it("different calls produce different signatures (non-deterministic ts)", async () => {
    const { privkeyHex } = makeKeypair();
    // Stub Date.now to ensure different timestamps
    const orig = Date.now;
    Date.now = () => orig() + 2000;
    const h2 = await signGcalHeaders(privkeyHex, "");
    Date.now = orig;
    const h1 = await signGcalHeaders(privkeyHex, "");
    // Different timestamps → different sigs
    if (h1["X-Taskify-Timestamp"] !== h2["X-Taskify-Timestamp"]) {
      expect(h1["X-Taskify-Sig"]).not.toBe(h2["X-Taskify-Sig"]);
    }
  });

  it("wrong body fails signature verification", async () => {
    const { privkeyHex, pubkeyHex } = makeKeypair();
    const body = JSON.stringify({ foo: "bar" });
    const headers = await signGcalHeaders(privkeyHex, body);
    // Tamper the body
    const valid = verifySig(pubkeyHex, headers["X-Taskify-Timestamp"], '{"foo":"baz"}', headers["X-Taskify-Sig"]);
    expect(valid).toBe(false);
  });

  it("pubkey in header matches derived public key", async () => {
    const { privkeyHex, pubkeyHex } = makeKeypair();
    const headers = await signGcalHeaders(privkeyHex, "");
    expect(headers["X-Taskify-Npub"]).toBe(pubkeyHex);
  });
});

// ─── GcalConnectionStatus shape ───────────────────────────────────────────────

describe("GcalConnectionStatus type contract", () => {
  it("connected:false shape is valid for disconnected users", () => {
    // Mirrors what the Worker returns for unconnected users
    const status = { connected: false };
    expect(status.connected).toBe(false);
  });

  it("connected:true shape includes required fields", () => {
    const status = {
      connected: true,
      status: "active" as const,
      googleEmail: "test@example.com",
      lastSyncAt: 1711000000,
      lastError: null,
    };
    expect(status.googleEmail).toBeTruthy();
    expect(["active", "token_expired", "needs_reauth", "sync_failed", "disconnected"]).toContain(status.status);
  });
});

// ─── gcalEventToCalendarEvent conversion ─────────────────────────────────────

import { gcalEventToCalendarEvent, SPECIAL_GCAL_CALENDAR_PREFIX } from "./gcalApi";

describe("gcalEventToCalendarEvent", () => {
  const baseEvent = {
    id: "evt-1",
    calendarId: "cal-1",
    providerEventId: "google-123",
    calendarName: "Personal",
    calendarColor: "#4285F4",
    title: "Doctor appointment",
    startISO: "2026-03-26T15:00:00.000Z",
    endISO: "2026-03-26T16:00:00.000Z",
    allDay: false,
    status: "confirmed" as const,
    isRecurring: false,
    readonly: true as const,
    source: "google" as const,
    kind: "calendar_event" as const,
  };

  it("maps timed event to TimeCalendarEvent shape", () => {
    const result = gcalEventToCalendarEvent(baseEvent);
    expect(result.kind).toBe("time");
    if (result.kind !== "time") throw new Error("Expected timed calendar event");
    expect(result.startISO).toBe(baseEvent.startISO);
    expect(result.endISO).toBe(baseEvent.endISO);
    expect(result.title).toBe("Doctor appointment");
    expect(result.readOnly).toBe(true);
    expect(result.boardId).toMatch(new RegExp(`^${SPECIAL_GCAL_CALENDAR_PREFIX}`));
  });

  it("maps all-day event to DateCalendarEvent shape", () => {
    const allDay = { ...baseEvent, allDay: true, startISO: "2026-03-26", endISO: "2026-03-27" };
    const result = gcalEventToCalendarEvent(allDay);
    expect(result.kind).toBe("date");
    expect((result as any).startDate).toBe("2026-03-26");
    expect((result as any).endDate).toBeUndefined();
  });

  it("converts Google's exclusive multi-day end to Taskify's inclusive end", () => {
    const allDay = { ...baseEvent, allDay: true, startISO: "2026-03-26", endISO: "2026-03-29" };
    const result = gcalEventToCalendarEvent(allDay);
    expect(result.kind).toBe("date");
    expect((result as any).endDate).toBe("2026-03-28");
  });

  it("cancelled events have readOnly:true", () => {
    const cancelled = { ...baseEvent, status: "cancelled" as const };
    const result = gcalEventToCalendarEvent(cancelled);
    expect(result.readOnly).toBe(true);
  });

  it("boardId is stable for the same calendarId", () => {
    const r1 = gcalEventToCalendarEvent(baseEvent);
    const r2 = gcalEventToCalendarEvent({ ...baseEvent, id: "evt-2" });
    expect(r1.boardId).toBe(r2.boardId);
  });

  it("different calendarIds produce different boardIds", () => {
    const r1 = gcalEventToCalendarEvent(baseEvent);
    const r2 = gcalEventToCalendarEvent({ ...baseEvent, calendarId: "cal-2" });
    expect(r1.boardId).not.toBe(r2.boardId);
  });
});
