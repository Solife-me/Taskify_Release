import { normalizeCalendarEventPayload } from "./calendarPayload.js";
import { normalizeTaskRecurrence } from "./shareContracts.js";
function normalizeString(value) {
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}
function normalizePubkey(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    if (!/^[0-9a-f]{64}$/i.test(trimmed))
        return undefined;
    return trimmed.toLowerCase();
}
function normalizeStringArray(value) {
    if (!Array.isArray(value))
        return undefined;
    const out = value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean);
    return out.length ? out : undefined;
}
function normalizeParticipants(value) {
    if (!Array.isArray(value))
        return undefined;
    const out = [];
    value.forEach((entry) => {
        if (!entry || typeof entry !== "object")
            return;
        const pubkey = normalizeString(entry.pubkey);
        if (!pubkey || !/^[0-9a-f]{64}$/i.test(pubkey))
            return;
        const relay = normalizeString(entry.relay) || undefined;
        const role = normalizeString(entry.role) || undefined;
        out.push({ pubkey: pubkey.toLowerCase(), ...(relay ? { relay } : {}), ...(role ? { role } : {}) });
    });
    return out.length ? out : undefined;
}
function normalizeInviteTokens(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const out = {};
    Object.entries(value).forEach(([key, token]) => {
        if (!/^[0-9a-f]{64}$/i.test(key))
            return;
        if (typeof token !== "string" || !token.trim())
            return;
        out[key.toLowerCase()] = token.trim();
    });
    return Object.keys(out).length ? out : undefined;
}
export function parseCalendarCanonicalPayload(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    if (raw.v !== 1)
        return null;
    const eventId = normalizeString(raw.eventId);
    const eventKey = normalizeString(raw.eventKey);
    if (!eventId || !eventKey)
        return null;
    const deleted = raw.deleted === true;
    const kindRaw = raw.kind;
    const kind = kindRaw === "date" || kindRaw === "time" ? kindRaw : undefined;
    const title = normalizeString(raw.title);
    if (!deleted) {
        if (!kind || !title)
            return null;
    }
    const payload = {
        v: 1,
        eventId,
        eventKey,
        ...(deleted ? { deleted: true } : {}),
        ...(kind ? { kind } : {}),
        ...(title ? { title } : {}),
    };
    const createdBy = normalizePubkey(raw.createdBy);
    if (createdBy)
        payload.createdBy = createdBy;
    const lastEditedBy = normalizePubkey(raw.lastEditedBy);
    if (lastEditedBy)
        payload.lastEditedBy = lastEditedBy;
    const summary = normalizeString(raw.summary);
    if (summary)
        payload.summary = summary;
    const description = normalizeString(raw.description);
    if (description)
        payload.description = description;
    if (Array.isArray(raw.documents) && raw.documents.length)
        payload.documents = raw.documents;
    const image = normalizeString(raw.image);
    if (image)
        payload.image = image;
    const geohash = normalizeString(raw.geohash);
    if (geohash)
        payload.geohash = geohash;
    const locations = normalizeStringArray(raw.locations);
    if (locations)
        payload.locations = locations;
    const hashtags = normalizeStringArray(raw.hashtags);
    if (hashtags)
        payload.hashtags = hashtags;
    const references = normalizeStringArray(raw.references);
    if (references)
        payload.references = references;
    const participants = normalizeParticipants(raw.participants);
    if (participants)
        payload.participants = participants;
    const inviteTokens = normalizeInviteTokens(raw.inviteTokens);
    if (inviteTokens)
        payload.inviteTokens = inviteTokens;
    const recurrence = normalizeTaskRecurrence(raw.recurrence);
    if (recurrence?.type !== "none")
        payload.recurrence = recurrence;
    const seriesId = normalizeString(raw.seriesId);
    if (seriesId && recurrence?.type !== "none")
        payload.seriesId = seriesId;
    const core = normalizeCalendarEventPayload(raw);
    if (!core)
        return null;
    if (core.startDate)
        payload.startDate = core.startDate;
    if (core.endDate)
        payload.endDate = core.endDate;
    if (core.startISO)
        payload.startISO = core.startISO;
    if (core.endISO)
        payload.endISO = core.endISO;
    if (core.startTzid)
        payload.startTzid = core.startTzid;
    if (core.endTzid)
        payload.endTzid = core.endTzid;
    return payload;
}
export function parseCalendarViewPayload(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    if (raw.v !== 1)
        return null;
    const eventId = normalizeString(raw.eventId);
    if (!eventId)
        return null;
    const deleted = raw.deleted === true;
    const kindRaw = raw.kind;
    const kind = kindRaw === "date" || kindRaw === "time" ? kindRaw : undefined;
    const title = normalizeString(raw.title);
    if (!deleted) {
        if (!kind || !title)
            return null;
    }
    const payload = {
        v: 1,
        eventId,
        ...(deleted ? { deleted: true } : {}),
        ...(kind ? { kind } : {}),
        ...(title ? { title } : {}),
    };
    const createdBy = normalizePubkey(raw.createdBy);
    if (createdBy)
        payload.createdBy = createdBy;
    const lastEditedBy = normalizePubkey(raw.lastEditedBy);
    if (lastEditedBy)
        payload.lastEditedBy = lastEditedBy;
    const summary = normalizeString(raw.summary);
    if (summary)
        payload.summary = summary;
    const description = normalizeString(raw.description);
    if (description)
        payload.description = description;
    if (Array.isArray(raw.documents) && raw.documents.length)
        payload.documents = raw.documents;
    const image = normalizeString(raw.image);
    if (image)
        payload.image = image;
    const geohash = normalizeString(raw.geohash);
    if (geohash)
        payload.geohash = geohash;
    const locations = normalizeStringArray(raw.locations);
    if (locations)
        payload.locations = locations;
    const hashtags = normalizeStringArray(raw.hashtags);
    if (hashtags)
        payload.hashtags = hashtags;
    const references = normalizeStringArray(raw.references);
    if (references)
        payload.references = references;
    const recurrence = normalizeTaskRecurrence(raw.recurrence);
    if (recurrence?.type !== "none")
        payload.recurrence = recurrence;
    const seriesId = normalizeString(raw.seriesId);
    if (seriesId && recurrence?.type !== "none")
        payload.seriesId = seriesId;
    const core = normalizeCalendarEventPayload(raw);
    if (!core)
        return null;
    if (core.startDate)
        payload.startDate = core.startDate;
    if (core.endDate)
        payload.endDate = core.endDate;
    if (core.startISO)
        payload.startISO = core.startISO;
    if (core.endISO)
        payload.endISO = core.endISO;
    if (core.startTzid)
        payload.startTzid = core.startTzid;
    if (core.endTzid)
        payload.endTzid = core.endTzid;
    return payload;
}
export function parseCalendarRsvpPayload(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    if (raw.v !== 1)
        return null;
    const eventId = normalizeString(raw.eventId);
    if (!eventId)
        return null;
    const inviteToken = normalizeString(raw.inviteToken);
    if (!inviteToken)
        return null;
    const statusRaw = raw.status;
    const status = statusRaw === "accepted" || statusRaw === "declined" || statusRaw === "tentative"
        ? statusRaw
        : null;
    if (!status)
        return null;
    const payload = { v: 1, eventId, status, inviteToken };
    const fbRaw = raw.fb;
    if (fbRaw === "free" || fbRaw === "busy")
        payload.fb = fbRaw;
    const note = normalizeString(raw.note);
    if (note)
        payload.note = note;
    return payload;
}
