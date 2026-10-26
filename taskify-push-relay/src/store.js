import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const TASK_EVENT_KINDS = new Set([30_300, 30_301])
const HEX_EVENT_ID = /^[0-9a-f]{64}$/
const HEX_PUBLIC_KEY = /^[0-9a-f]{64}$/
const PREVIEW_TOKEN = /^[A-Za-z0-9_-]{43}$/
const SCHEMA_VERSION = 1

function registrationUsesPreview(registration) {
  return registration != null && !['watchos', 'macos', 'web'].includes(registration.platform)
}

function deletionTargets(event) {
  if (event?.kind !== 5 || !HEX_PUBLIC_KEY.test(event.pubkey?.toLowerCase() ?? '')) {
    throw new Error('Invalid kind 5 deletion request')
  }
  const eventIDs = new Set()
  const addresses = new Set()
  for (const tag of event.tags ?? []) {
    if (!Array.isArray(tag) || (tag[0] !== 'e' && tag[0] !== 'a')) continue
    if (tag[0] === 'e') {
      if (!HEX_EVENT_ID.test(tag[1] ?? '')) throw new Error('Invalid deletion event ID')
      eventIDs.add(tag[1])
      continue
    }
    const match = /^(\d+):([0-9a-f]{64}):(.*)$/.exec(tag[1] ?? '')
    if (!match || match[2] !== event.pubkey.toLowerCase()) {
      throw new Error('Invalid deletion event address')
    }
    addresses.add(tag[1])
  }
  if (eventIDs.size + addresses.size === 0) {
    throw new Error('Deletion request must identify at least one event')
  }
  if (eventIDs.size + addresses.size > 100) {
    throw new Error('Deletion request has too many targets')
  }
  return { eventIDs, addresses }
}

function taskEventCoordinate(event) {
  if (!TASK_EVENT_KINDS.has(event?.kind) || typeof event.pubkey !== 'string') return null
  const identifiers = event.tags?.filter(
    (tag) => Array.isArray(tag) && tag[0] === 'd' && typeof tag[1] === 'string' && tag[1] !== '',
  ) ?? []
  if (identifiers.length !== 1) return null
  return `${event.kind}:${event.pubkey.toLowerCase()}:${identifiers[0][1]}`
}

function replacesTaskEvent(candidate, current) {
  if (candidate.created_at !== current.created_at) return candidate.created_at > current.created_at
  // NIP-01 uses the lowest event id as the deterministic winner for equal timestamps.
  return candidate.id < current.id
}

function boardTagOf(event) {
  return event.tags?.find((tag) => tag[0] === 'b')?.[1]?.toLowerCase() ?? null
}

// Every row is written by this store, but an ordinary SQLite file can still be edited by hand;
// a row that no longer parses is treated as absent rather than failing every read.
function parseStored(json) {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS registrations (
    key TEXT PRIMARY KEY,
    pubkey TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    device_token TEXT NOT NULL,
    environment TEXT,
    platform TEXT NOT NULL,
    application TEXT NOT NULL,
    web_push TEXT,
    updated_at INTEGER NOT NULL,
    last_push_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS registrations_pubkey ON registrations(pubkey);
  CREATE INDEX IF NOT EXISTS registrations_installation ON registrations(installation_id);
  CREATE INDEX IF NOT EXISTS registrations_device_token ON registrations(device_token);
  CREATE INDEX IF NOT EXISTS registrations_updated ON registrations(updated_at);

  -- Gift wraps. The event is kept as the JSON it was stored as; the columns beside it exist only
  -- to find, order and bound rows without parsing it.
  CREATE TABLE IF NOT EXISTS events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    recipient TEXT NOT NULL,
    author TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    stored_at INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_recipient ON events(recipient, stored_at, sequence);
  CREATE INDEX IF NOT EXISTS events_stored ON events(stored_at, sequence);
  CREATE INDEX IF NOT EXISTS events_author ON events(author);

  -- Count and bytes of every wrap, kept by triggers so the total budget never sums the table.
  CREATE TABLE IF NOT EXISTS event_totals (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    count INTEGER NOT NULL,
    bytes INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO event_totals (singleton, count, bytes)
    SELECT 1, COUNT(*), COALESCE(SUM(bytes), 0) FROM events;
  CREATE TRIGGER IF NOT EXISTS events_total_insert AFTER INSERT ON events BEGIN
    UPDATE event_totals SET count = count + 1, bytes = bytes + NEW.bytes WHERE singleton = 1;
  END;
  CREATE TRIGGER IF NOT EXISTS events_total_delete AFTER DELETE ON events BEGIN
    UPDATE event_totals SET count = count - 1, bytes = bytes - OLD.bytes WHERE singleton = 1;
  END;

  CREATE TABLE IF NOT EXISTS preferences (
    pubkey TEXT PRIMARY KEY,
    id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    json TEXT NOT NULL
  );

  -- The Watch task cache: only the public coordinate, the signed ciphertext event and when it was
  -- last observed. No account, device, relay or board-secret column, by design.
  CREATE TABLE IF NOT EXISTS task_events (
    coordinate TEXT PRIMARY KEY,
    author TEXT NOT NULL,
    board_tag TEXT,
    kind INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    id TEXT NOT NULL,
    json TEXT NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS task_events_author ON task_events(author);
  CREATE INDEX IF NOT EXISTS task_events_seen ON task_events(last_seen_at, created_at);

  -- Count of cached task events, kept by triggers for the same reason as event_totals.
  CREATE TABLE IF NOT EXISTS task_event_totals (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    count INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO task_event_totals (singleton, count) SELECT 1, COUNT(*) FROM task_events;
  CREATE TRIGGER IF NOT EXISTS task_events_total_insert AFTER INSERT ON task_events BEGIN
    UPDATE task_event_totals SET count = count + 1 WHERE singleton = 1;
  END;
  CREATE TRIGGER IF NOT EXISTS task_events_total_delete AFTER DELETE ON task_events BEGIN
    UPDATE task_event_totals SET count = count - 1 WHERE singleton = 1;
  END;

  -- A job or preview goes with the wrap it points at and the registration it alerts.
  CREATE TABLE IF NOT EXISTS push_jobs (
    id TEXT NOT NULL UNIQUE,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    pubkey TEXT NOT NULL,
    registration_key TEXT NOT NULL REFERENCES registrations(key) ON DELETE CASCADE,
    attempts INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    preview_token TEXT
  );
  CREATE INDEX IF NOT EXISTS push_jobs_due ON push_jobs(next_attempt_at);
  CREATE INDEX IF NOT EXISTS push_jobs_registration ON push_jobs(registration_key, attempts);
  CREATE INDEX IF NOT EXISTS push_jobs_event ON push_jobs(event_id);

  CREATE TABLE IF NOT EXISTS previews (
    token TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    registration_key TEXT NOT NULL REFERENCES registrations(key) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS previews_event ON previews(event_id);
  CREATE INDEX IF NOT EXISTS previews_registration ON previews(registration_key);
  CREATE INDEX IF NOT EXISTS previews_expiry ON previews(expires_at);
`

/**
 * The relay's durable state in SQLite (`relay.sqlite` in the data directory).
 *
 * Each change writes only its own rows, in one transaction, so cost no longer grows with
 * everything stored (C13-1). The journal is WAL with `synchronous = NORMAL`: a commit is not
 * flushed to disk on its own, so a power loss can roll back the last few commits but never
 * corrupts the file, and no per-message fsync is paid. The first start after an upgrade imports
 * the former `state.json` and renames it.
 */
export class RelayStore {
  constructor({
    dataDirectory,
    eventTTLSeconds = 30 * 24 * 60 * 60,
    maxEventsPerRecipient = 500,
    maxEventsTotal = 100_000,
    maxBytesPerRecipient = 8 * 1024 * 1024,
    maxBytesTotal = 128 * 1024 * 1024,
    taskEventTTLSeconds = 30 * 24 * 60 * 60,
    maxTaskEventsPerAuthor = 2_000,
    maxTaskEventsTotal = 100_000,
    maxRegistrationsPerPubkey = 10,
    maxRegistrationsTotal = 100_000,
    // The apps re-register on every launch or activation, so a registration nobody has
    // refreshed in this long belongs to an app that is gone or never opened.
    registrationTTLSeconds = 90 * 24 * 60 * 60,
    // Reads prune at most this often; writes still prune every time.
    readPruneIntervalSeconds = 10,
    previewTTLSeconds = 15 * 60,
    minimumPushIntervalSeconds = 10,
    now = () => Math.floor(Date.now() / 1000),
  }) {
    this.dataDirectory = dataDirectory
    this.databasePath = path.join(dataDirectory, 'relay.sqlite')
    this.legacyStatePath = path.join(dataDirectory, 'state.json')
    this.eventTTLSeconds = eventTTLSeconds
    this.maxEventsPerRecipient = maxEventsPerRecipient
    this.maxEventsTotal = maxEventsTotal
    this.maxBytesPerRecipient = maxBytesPerRecipient
    this.maxBytesTotal = maxBytesTotal
    this.taskEventTTLSeconds = taskEventTTLSeconds
    this.maxTaskEventsPerAuthor = maxTaskEventsPerAuthor
    this.maxTaskEventsTotal = maxTaskEventsTotal
    this.maxRegistrationsPerPubkey = maxRegistrationsPerPubkey
    this.maxRegistrationsTotal = maxRegistrationsTotal
    this.registrationTTLSeconds = registrationTTLSeconds
    this.readPruneIntervalSeconds = readPruneIntervalSeconds
    this.lastPrunedAt = Number.NEGATIVE_INFINITY
    this.previewTTLSeconds = previewTTLSeconds
    this.minimumPushIntervalSeconds = minimumPushIntervalSeconds
    this.now = now
    this.db = null
    this.transactionDepth = 0
  }

  async load() {
    mkdirSync(this.dataDirectory, { recursive: true, mode: 0o700 })
    const created = !existsSync(this.databasePath)
    this.db = new DatabaseSync(this.databasePath)
    // Registrations hold device tokens: readable by the relay's own user only. SQLite gives its
    // -wal and -shm files the database file's permissions.
    if (created) chmodSync(this.databasePath, 0o600)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(SCHEMA)
    this.db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
    this.prepareStatements()
    this.importLegacyState()
    this.prune()
  }

  /// Closes the database. The store is unusable afterwards.
  close() {
    this.db?.close()
    this.db = null
  }

  prepareStatements() {
    const db = this.db
    const statement = (sql) => db.prepare(sql)
    this.sql = {
      registrationByKey: statement('SELECT * FROM registrations WHERE key = ?'),
      registrationsFor: statement('SELECT * FROM registrations WHERE pubkey = ? ORDER BY rowid'),
      registrationsTouching: statement(
        'SELECT * FROM registrations WHERE key = ? OR installation_id = ? OR device_token = ? ORDER BY rowid',
      ),
      registrationCount: statement('SELECT COUNT(*) AS count FROM registrations'),
      registrationCountFor: statement('SELECT COUNT(*) AS count FROM registrations WHERE pubkey = ?'),
      stalestRegistration: statement(
        'SELECT key FROM registrations WHERE pubkey <> ? ORDER BY updated_at, rowid LIMIT 1',
      ),
      insertRegistration: statement(`INSERT INTO registrations
        (key, pubkey, installation_id, device_token, environment, platform, application, web_push, updated_at, last_push_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`),
      updateRegistration: statement(`UPDATE registrations SET device_token = ?, environment = ?, platform = ?,
        application = ?, web_push = ?, updated_at = ?, last_push_at = NULL WHERE key = ?`),
      followDeviceToken: statement('UPDATE registrations SET device_token = ?, environment = ? WHERE key = ?'),
      deleteRegistration: statement('DELETE FROM registrations WHERE key = ?'),
      setLastPushAt: statement('UPDATE registrations SET last_push_at = ? WHERE key = ?'),
      hasRegistration: statement('SELECT 1 FROM registrations WHERE pubkey = ? LIMIT 1'),
      hasPreference: statement('SELECT 1 FROM preferences WHERE pubkey = ? LIMIT 1'),

      eventExists: statement('SELECT 1 FROM events WHERE id = ?'),
      insertEvent: statement(`INSERT INTO events (id, recipient, author, created_at, stored_at, bytes, json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`),
      insertEventWithSequence: statement(`INSERT INTO events (sequence, id, recipient, author, created_at, stored_at, bytes, json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
      eventsFor: statement('SELECT json FROM events WHERE recipient = ? ORDER BY created_at, sequence'),
      eventsAfter: statement(
        'SELECT sequence, json FROM events WHERE recipient = ? AND sequence > ? ORDER BY sequence LIMIT ?',
      ),
      eventJSON: statement('SELECT json FROM events WHERE id = ?'),
      recipientTotals: statement('SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM events WHERE recipient = ?'),
      oldestForRecipient: statement('SELECT id, bytes FROM events WHERE recipient = ? ORDER BY stored_at, sequence LIMIT ?'),
      eventTotals: statement('SELECT count, bytes FROM event_totals WHERE singleton = 1'),
      oldestEvents: statement('SELECT id, bytes FROM events ORDER BY stored_at, sequence LIMIT ?'),
      deleteEvent: statement('DELETE FROM events WHERE id = ?'),
      expireEvents: statement('DELETE FROM events WHERE stored_at < ?'),
      deleteOldestEvents: statement(
        'DELETE FROM events WHERE sequence IN (SELECT sequence FROM events ORDER BY stored_at, sequence LIMIT ?)',
      ),
      deleteWrapsByAuthor: statement(
        'DELETE FROM events WHERE author = ? AND id IN (SELECT value FROM json_each(?))',
      ),

      preference: statement('SELECT id, created_at FROM preferences WHERE pubkey = ?'),
      deletePreference: statement('DELETE FROM preferences WHERE pubkey = ?'),
      insertPreference: statement('INSERT INTO preferences (pubkey, id, created_at, json) VALUES (?, ?, ?, ?)'),
      allPreferences: statement('SELECT json FROM preferences ORDER BY rowid'),
      preferencesFor: statement(
        'SELECT json FROM preferences WHERE pubkey IN (SELECT value FROM json_each(?)) ORDER BY rowid',
      ),
      deletePreferencesByAuthor: statement(`DELETE FROM preferences WHERE pubkey = ? AND (
        id IN (SELECT value FROM json_each(?))
        OR ('10050:' || pubkey || ':' IN (SELECT value FROM json_each(?)) AND created_at <= ?))`),

      taskEvent: statement('SELECT id, created_at, last_seen_at FROM task_events WHERE coordinate = ?'),
      insertTaskEvent: statement(`INSERT INTO task_events
        (coordinate, author, board_tag, kind, created_at, id, json, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
      replaceTaskEvent: statement(`UPDATE task_events SET author = ?, board_tag = ?, kind = ?, created_at = ?, id = ?,
        json = ?, last_seen_at = ? WHERE coordinate = ?`),
      touchTaskEvent: statement('UPDATE task_events SET last_seen_at = ? WHERE coordinate = ?'),
      expireTaskEvents: statement('DELETE FROM task_events WHERE last_seen_at < ?'),
      taskEventCountFor: statement('SELECT COUNT(*) AS count FROM task_events WHERE author = ?'),
      evictTaskEventsFor: statement(`DELETE FROM task_events WHERE coordinate IN (
        SELECT coordinate FROM task_events WHERE author = ? ORDER BY last_seen_at, created_at, rowid LIMIT ?)`),
      taskEventCount: statement('SELECT count FROM task_event_totals WHERE singleton = 1'),
      evictTaskEvents: statement(`DELETE FROM task_events WHERE coordinate IN (
        SELECT coordinate FROM task_events ORDER BY last_seen_at, created_at, rowid LIMIT ?)`),
      taskEventsFor: statement(`SELECT json, board_tag, author FROM task_events
        WHERE author IN (SELECT value FROM json_each(?))
        ORDER BY kind DESC, created_at DESC, id DESC`),
      deleteTaskEventsByAuthor: statement(`DELETE FROM task_events WHERE author = ? AND (
        id IN (SELECT value FROM json_each(?))
        OR (coordinate IN (SELECT value FROM json_each(?)) AND created_at <= ?))`),

      jobByID: statement('SELECT * FROM push_jobs WHERE id = ?'),
      waitingJob: statement('SELECT rowid, * FROM push_jobs WHERE registration_key = ? AND attempts = 0 ORDER BY rowid LIMIT 1'),
      insertJob: statement(`INSERT INTO push_jobs
        (id, event_id, pubkey, registration_key, attempts, next_attempt_at, created_at, preview_token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
      repointJob: statement('UPDATE push_jobs SET id = ?, event_id = ?, preview_token = ? WHERE rowid = ?'),
      dueJobs: statement('SELECT * FROM push_jobs WHERE next_attempt_at <= ? ORDER BY rowid LIMIT ?'),
      deleteJob: statement('DELETE FROM push_jobs WHERE id = ?'),
      retryJob: statement('UPDATE push_jobs SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ?'),

      insertPreview: statement('INSERT INTO previews (token, event_id, registration_key, expires_at) VALUES (?, ?, ?, ?)'),
      previewByToken: statement('SELECT * FROM previews WHERE token = ?'),
      deletePreview: statement('DELETE FROM previews WHERE token = ?'),
      expirePreviews: statement('DELETE FROM previews WHERE expires_at < ?'),
      dropPreviewsWithoutUse: statement(`DELETE FROM previews WHERE registration_key IN (
        SELECT key FROM registrations WHERE platform IN ('watchos', 'macos', 'web'))`),
      expireRegistrations: statement('DELETE FROM registrations WHERE updated_at < ?'),
    }
  }

  /// Runs `work` in one transaction: all of its writes land, or none do. Nested calls join the
  /// outer transaction.
  transaction(work) {
    if (this.transactionDepth > 0) return work()
    this.db.exec('BEGIN IMMEDIATE')
    this.transactionDepth = 1
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.transactionDepth = 0
    }
  }

  /// Everything the store keeps, as one canonical JSON string: for checks that an operation
  /// left nothing behind, and for diagnostics. Not a backup format.
  snapshot() {
    const rows = (table, order) => this.db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()
    return JSON.stringify({
      registrations: rows('registrations', 'key'),
      events: rows('events', 'sequence'),
      preferences: rows('preferences', 'pubkey'),
      taskEvents: rows('task_events', 'coordinate'),
      pushJobs: rows('push_jobs', 'id'),
      previews: rows('previews', 'token'),
    })
  }

  // ---- Registrations ----

  registrationFromRow(row) {
    if (!row) return null
    return {
      key: row.key,
      pubkey: row.pubkey,
      installationID: row.installation_id,
      deviceToken: row.device_token,
      environment: row.environment ?? undefined,
      platform: row.platform,
      application: row.application,
      ...(row.web_push != null ? { webPush: parseStored(row.web_push) } : {}),
      updatedAt: row.updated_at,
      ...(row.last_push_at != null ? { lastPushAt: row.last_push_at } : {}),
    }
  }

  registrationKey(pubkey, installationID) {
    return `${pubkey.toLowerCase()}:${installationID}`
  }

  registrationsFor(pubkey) {
    return this.sql.registrationsFor.all(pubkey.toLowerCase()).map((row) => this.registrationFromRow(row))
  }

  registrationByKey(key) {
    return this.registrationFromRow(this.sql.registrationByKey.get(key))
  }

  /// Whether `pubkey` uses this relay as an inbox: it has a device registered here or has
  /// published its inbox preference here. Gift wraps for anyone else are not stored.
  hasInbox(pubkey) {
    const normalized = pubkey.toLowerCase()
    return this.sql.hasRegistration.get(normalized) != null || this.sql.hasPreference.get(normalized) != null
  }

  async putRegistration(
    pubkey,
    installationID,
    { deviceToken, environment, platform = 'ios', application = 'taskify', webPush = null },
  ) {
    const normalizedPubkey = pubkey.toLowerCase()
    const key = this.registrationKey(normalizedPubkey, installationID)
    // APNs tokens are hex, compared without case; FCM tokens and Web Push endpoints are
    // case-sensitive. A web registration's token is its subscription endpoint.
    const token = ['ios', 'watchos', 'macos'].includes(platform) ? deviceToken.toLowerCase() : deviceToken
    const webPushJSON = platform === 'web' ? JSON.stringify(webPush) : null
    return this.transaction(() => {
      // Snapstr keeps several profiles on one phone and alerts for all of them, so its other
      // profiles on this installation stay registered, following the device's current token.
      // Taskify has one account per installation: registering another replaces it. Either way, a
      // registration elsewhere with this token is a stale install of the same app and is dropped.
      const keepsOtherProfiles = application === 'snapstr'
      const followers = []
      const dropped = []
      let exists = false
      for (const candidate of this.sql.registrationsTouching.all(key, installationID, token)) {
        if (candidate.key === key) {
          exists = true
        } else if (
          keepsOtherProfiles
          && candidate.installation_id === installationID
          && candidate.application === application
        ) {
          followers.push(candidate.key)
        } else {
          dropped.push(candidate)
        }
      }
      const droppedForPubkey = dropped.filter((candidate) => candidate.pubkey === normalizedPubkey).length
      const resultingForPubkey = this.sql.registrationCountFor.get(normalizedPubkey).count
        - droppedForPubkey + (exists ? 0 : 1)
      if (resultingForPubkey > this.maxRegistrationsPerPubkey) {
        throw new Error('Device registration limit exceeded')
      }
      for (const candidate of dropped) this.sql.deleteRegistration.run(candidate.key)
      for (const followerKey of followers) this.sql.followDeviceToken.run(token, environment ?? null, followerKey)
      if (!exists && this.sql.registrationCount.get().count + 1 > this.maxRegistrationsTotal) {
        // Full: make room by dropping the registration refreshed longest ago, rather than
        // refusing every new user. A live app that is dropped re-registers on its next launch.
        const stalest = this.sql.stalestRegistration.get(normalizedPubkey)
        if (!stalest) throw new Error('Device registration limit exceeded')
        this.sql.deleteRegistration.run(stalest.key)
      }
      const updatedAt = this.now()
      if (exists) {
        this.sql.updateRegistration.run(token, environment ?? null, platform, application, webPushJSON, updatedAt, key)
      } else {
        this.sql.insertRegistration.run(
          key, normalizedPubkey, installationID, token, environment ?? null, platform, application, webPushJSON, updatedAt,
        )
      }
      return this.registrationByKey(key)
    })
  }

  async removeRegistration(pubkey, installationID) {
    const key = this.registrationKey(pubkey, installationID)
    return this.sql.deleteRegistration.run(key).changes > 0
  }

  async removeRegistrationByKey(key) {
    const registration = this.registrationByKey(key)
    if (!registration) return false
    return this.removeRegistration(registration.pubkey, registration.installationID)
  }

  // ---- Gift wraps ----

  eventsFor(pubkey) {
    this.pruneForRead()
    return this.sql.eventsFor.all(pubkey.toLowerCase()).map((row) => parseStored(row.json)).filter(Boolean)
  }

  eventsAfter(pubkey, sequence = 0, limit = 100) {
    this.pruneForRead()
    const normalizedLimit = Math.max(1, Math.min(500, Number.isInteger(limit) ? limit : 100))
    const rows = this.sql.eventsAfter.all(pubkey.toLowerCase(), sequence, normalizedLimit + 1)
    const page = rows.slice(0, normalizedLimit)
    return {
      events: page.map((row) => parseStored(row.json)).filter(Boolean),
      nextSequence: page.at(-1)?.sequence ?? sequence,
      hasMore: rows.length > page.length,
    }
  }

  /// `application` names the app the publishing socket signed in as. Only that app's devices are
  /// alerted: Taskify cannot hide an alert for a wrap it cannot preview, so a Snapstr message would
  /// otherwise appear as a Taskify notification, and the reverse.
  registrationsToNotify(recipient, application) {
    const registrations = this.registrationsFor(recipient)
    const matching = registrations.filter(
      (registration) => (registration.application ?? 'taskify') === application,
    )
    // An unnamed sender is Taskify, another NIP-17 client, or a Snapstr build from before Snapstr
    // named itself. An account with only Snapstr devices still gets its alert rather than none.
    if (application === 'taskify' && matching.length === 0) return registrations
    return matching
  }

  async putGiftWrap(event, { notify, application = 'taskify' }) {
    return this.transaction(() => {
      this.prune()
      if (this.sql.eventExists.get(event.id)) return false
      const recipient = event.tags.find((tag) => tag[0] === 'p')[1].toLowerCase()
      const storedAt = this.now()
      const json = JSON.stringify(event)
      this.sql.insertEvent.run(
        event.id, recipient, event.pubkey.toLowerCase(), event.created_at, storedAt, Buffer.byteLength(json), json,
      )
      this.enforceEventBounds(recipient)
      // A wrap the budgets evicted at once is still reported stored, but alerts nobody.
      if (notify && this.sql.eventExists.get(event.id)) {
        for (const registration of this.registrationsToNotify(recipient, application)) {
          const id = `${event.id}:${registration.key}`
          if (this.sql.jobByID.get(id)) continue
          // Watch and Mac fetch the wrap themselves, and the web app shows a generic alert, so none
          // needs a preview link.
          const previewToken = !registrationUsesPreview(registration)
            ? null
            : randomBytes(32).toString('base64url')
          // One unsent alert per device at a time, and a minimum gap after the last one sent,
          // so a burst of wraps (from anyone) becomes a few alerts rather than one per wrap.
          // The waiting job is repointed at the newest wrap so its preview shows the latest.
          const waiting = this.sql.waitingJob.get(registration.key)
          if (waiting) {
            if (waiting.preview_token) this.sql.deletePreview.run(waiting.preview_token)
            this.sql.repointJob.run(id, event.id, previewToken, waiting.rowid)
          } else {
            this.sql.insertJob.run(
              id,
              event.id,
              recipient,
              registration.key,
              0,
              Math.max(storedAt, (registration.lastPushAt ?? 0) + this.minimumPushIntervalSeconds),
              storedAt,
              previewToken,
            )
          }
          if (previewToken) {
            this.sql.insertPreview.run(previewToken, event.id, registration.key, storedAt + this.previewTTLSeconds)
          }
        }
      }
      return true
    })
  }

  async putPreference(event) {
    const pubkey = event.pubkey.toLowerCase()
    return this.transaction(() => {
      const current = this.sql.preference.get(pubkey)
      if (current && (
        current.created_at > event.created_at
        || (current.created_at === event.created_at && current.id <= event.id)
      )) return false
      // Deleted and inserted rather than updated: preferences list in the order they arrived.
      this.sql.deletePreference.run(pubkey)
      this.sql.insertPreference.run(pubkey, event.id, event.created_at, JSON.stringify(event))
      return true
    })
  }

  /// Applies a NIP-09 request only to events signed by the same key. Deleting an event also
  /// removes any notification job or preview that could still reveal the deleted ciphertext.
  async applyDeletionRequest(event) {
    const { eventIDs, addresses } = deletionTargets(event)
    const author = event.pubkey.toLowerCase()
    const ids = JSON.stringify([...eventIDs])
    const coordinates = JSON.stringify([...addresses])
    return this.transaction(() => {
      // Gift wraps have no address (kind 1059), so only their ids can name them.
      const wraps = this.sql.deleteWrapsByAuthor.run(author, ids).changes
      const preferences = this.sql.deletePreferencesByAuthor.run(author, ids, coordinates, event.created_at).changes
      const taskEvents = this.sql.deleteTaskEventsByAuthor.run(author, ids, coordinates, event.created_at).changes
      return wraps + preferences + taskEvents
    })
  }

  // ---- Watch task cache ----

  /// Caches only the latest signed replaceable board/task event per public Nostr coordinate.
  /// Entries intentionally have no account, device, requested-relay, or board-secret field, so
  /// the durable cache cannot reconstruct which Taskify identity requested a public ciphertext.
  async putTaskEvents(events) {
    const observedAt = this.now()
    return this.transaction(() => {
      let changed = false
      const authors = new Set()
      for (const event of events) {
        const coordinate = taskEventCoordinate(event)
        if (!coordinate) continue
        const author = event.pubkey.toLowerCase()
        const current = this.sql.taskEvent.get(coordinate)
        const columns = [author, boardTagOf(event), event.kind, event.created_at, event.id, JSON.stringify(event), observedAt]
        if (!current) {
          this.sql.insertTaskEvent.run(coordinate, ...columns)
          authors.add(author)
          changed = true
          continue
        }
        if (event.id === current.id) {
          // Refresh at most hourly: an actively used entry is kept without a write for every
          // foreground Watch refresh.
          if (current.last_seen_at <= observedAt - 60 * 60) {
            this.sql.touchTaskEvent.run(observedAt, coordinate)
            changed = true
          }
          continue
        }
        if (replacesTaskEvent(event, current)) {
          this.sql.replaceTaskEvent.run(...columns, coordinate)
          changed = true
        }
      }
      if (this.enforceTaskEventBounds(authors)) changed = true
      return changed
    })
  }

  taskEventsFor(authors, limit = 1_000, boardTagsByAuthor = null) {
    this.pruneForRead()
    const normalized = [...new Set(authors.map((author) => author.toLowerCase()))]
    const boundedLimit = Math.max(1, Math.min(1_000, Number.isInteger(limit) ? limit : 1_000))
    const matches = []
    for (const row of this.sql.taskEventsFor.iterate(JSON.stringify(normalized))) {
      if (boardTagsByAuthor && boardTagsByAuthor.get(row.author) !== row.board_tag) continue
      const event = parseStored(row.json)
      if (event) matches.push(event)
      if (matches.length === boundedLimit) break
    }
    // Read newest first to stop at the limit; returned oldest first, as callers expect.
    return matches.reverse()
  }

  preferencesFor(authors = []) {
    const normalized = [...new Set(authors.map((author) => author.toLowerCase()))]
    const rows = normalized.length === 0
      ? this.sql.allPreferences.all()
      : this.sql.preferencesFor.all(JSON.stringify(normalized))
    return rows.map((row) => parseStored(row.json)).filter(Boolean)
  }

  // ---- Push jobs and previews ----

  jobFromRow(row) {
    return {
      id: row.id,
      eventID: row.event_id,
      pubkey: row.pubkey,
      registrationKey: row.registration_key,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
      createdAt: row.created_at,
      previewToken: row.preview_token ?? undefined,
    }
  }

  duePushJobs(nowSeconds = this.now(), limit = 100) {
    return this.sql.dueJobs.all(nowSeconds, limit).map((row) => this.jobFromRow(row))
  }

  previewForToken(token) {
    return this.previewEntryForToken(token)?.event ?? null
  }

  /// The gift wrap a preview token points at, and the account it was sent to.
  previewEntryForToken(token) {
    // Unauthenticated: never a full prune per request. Expiry is checked here directly.
    this.pruneForRead()
    const preview = this.sql.previewByToken.get(token)
    if (!preview || preview.expires_at < this.now()) return null
    const row = this.sql.eventJSON.get(preview.event_id)
    const event = row ? parseStored(row.json) : null
    if (!event) return null
    return { event, recipient: this.registrationByKey(preview.registration_key)?.pubkey ?? null }
  }

  /// Preview URLs work once: the notification extension fetches each a single time.
  async consumePreview(token) {
    this.sql.deletePreview.run(token)
  }

  /// `delivered` marks an alert Apple accepted, which starts the device's minimum push gap.
  async completePushJob(id, { retainPreview = false, delivered = false } = {}) {
    this.transaction(() => {
      const completed = this.sql.jobByID.get(id)
      if (!completed) return
      this.sql.deleteJob.run(id)
      if (!retainPreview && completed.preview_token) this.sql.deletePreview.run(completed.preview_token)
      if (delivered) this.sql.setLastPushAt.run(this.now(), completed.registration_key)
    })
  }

  async retryPushJob(id, { delaySeconds }) {
    this.sql.retryJob.run(this.now() + delaySeconds, id)
  }

  /// Writes are committed as they happen; kept for callers that wait for durability.
  async flush() {}

  // ---- Retention ----

  pruneForRead() {
    if (this.now() - this.lastPrunedAt >= this.readPruneIntervalSeconds) this.prune()
  }

  prune() {
    this.transaction(() => {
      const now = this.now()
      this.lastPrunedAt = now
      // Jobs and previews of an expired registration or wrap go with it (ON DELETE CASCADE).
      this.sql.expireRegistrations.run(now - this.registrationTTLSeconds)
      this.sql.expireEvents.run(now - this.eventTTLSeconds)
      this.sql.expirePreviews.run(now)
      this.sql.dropPreviewsWithoutUse.run()
      const { count } = this.sql.eventTotals.get()
      if (count > this.maxEventsTotal) this.sql.deleteOldestEvents.run(count - this.maxEventsTotal)
      this.enforceTaskEventBounds()
    })
  }

  /// Evicts the oldest wraps until `recipient` is within its count and byte budgets, then until
  /// all wraps are within the total byte budget.
  enforceEventBounds(recipient) {
    const totals = this.sql.recipientTotals.get(recipient)
    let count = totals.count
    let bytes = totals.bytes
    if (count > this.maxEventsPerRecipient || bytes > this.maxBytesPerRecipient) {
      for (const row of this.sql.oldestForRecipient.all(recipient, count)) {
        if (count <= this.maxEventsPerRecipient && bytes <= this.maxBytesPerRecipient) break
        this.sql.deleteEvent.run(row.id)
        count -= 1
        bytes -= row.bytes
      }
    }
    let totalBytes = this.sql.eventTotals.get().bytes
    while (totalBytes > this.maxBytesTotal) {
      const batch = this.sql.oldestEvents.all(64)
      if (batch.length === 0) break
      for (const row of batch) {
        if (totalBytes <= this.maxBytesTotal) break
        this.sql.deleteEvent.run(row.id)
        totalBytes -= row.bytes
      }
    }
    this.prune()
  }

  /// Expires task-cache entries, then evicts the least recently observed beyond the per-author
  /// budget of each author in `authors` and beyond the total budget. Only an insert raises an
  /// author's count, so only the authors just written need checking; nothing here scans the table.
  enforceTaskEventBounds(authors = []) {
    let changed = this.sql.expireTaskEvents.run(this.now() - this.taskEventTTLSeconds).changes > 0
    for (const author of authors) {
      const { count } = this.sql.taskEventCountFor.get(author)
      if (count > this.maxTaskEventsPerAuthor) {
        this.sql.evictTaskEventsFor.run(author, count - this.maxTaskEventsPerAuthor)
        changed = true
      }
    }
    const { count } = this.sql.taskEventCount.get()
    if (count > this.maxTaskEventsTotal) {
      this.sql.evictTaskEvents.run(count - this.maxTaskEventsTotal)
      changed = true
    }
    return changed
  }

  // ---- Upgrade from state.json ----

  /// Imports the whole-file state of releases before C13-1 into the new database, then renames
  /// the file (`state.json.imported`) so it is kept but never read again. The import is one
  /// transaction: if it fails, nothing is imported and the file is left where it was.
  importLegacyState() {
    if (!existsSync(this.legacyStatePath)) return
    if (this.db.prepare("SELECT 1 FROM meta WHERE key = 'imported_state_json'").get()) return
    const parsed = JSON.parse(readFileSync(this.legacyStatePath, 'utf8'))
    const loadedAt = this.now()
    const list = (value) => (Array.isArray(value) ? value : [])
    const importRegistration = this.db.prepare(`INSERT INTO registrations
      (key, pubkey, installation_id, device_token, environment, platform, application, web_push, updated_at, last_push_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    this.transaction(() => {
      const registrationsByKey = new Map()
      for (const registration of list(parsed.registrations)) {
        if (typeof registration?.key !== 'string' || typeof registration.pubkey !== 'string') continue
        if (registrationsByKey.has(registration.key)) continue
        registrationsByKey.set(registration.key, registration)
        importRegistration.run(
          registration.key,
          registration.pubkey.toLowerCase(),
          String(registration.installationID ?? ''),
          String(registration.deviceToken ?? ''),
          registration.environment ?? null,
          registration.platform ?? 'ios',
          registration.application ?? 'taskify',
          registration.platform === 'web' && registration.webPush ? JSON.stringify(registration.webPush) : null,
          Number.isInteger(registration.updatedAt) ? registration.updatedAt : loadedAt,
          Number.isInteger(registration.lastPushAt) ? registration.lastPushAt : null,
        )
      }

      // Wraps keep their sequence numbers, so a Watch paging with `eventsAfter` never sees one
      // reused; those without one are numbered after the rest, in the order they were stored.
      let nextSequence = Number.isSafeInteger(parsed.nextEventSequence) ? parsed.nextEventSequence : 1
      const entries = list(parsed.events)
        .filter((entry) => typeof entry?.event?.id === 'string' && typeof entry.recipient === 'string')
        .sort((left, right) => (left.storedAt ?? 0) - (right.storedAt ?? 0))
      for (const entry of entries) {
        if (Number.isSafeInteger(entry.sequence) && entry.sequence >= 1) nextSequence = Math.max(nextSequence, entry.sequence + 1)
      }
      const seenEventIDs = new Set()
      for (const entry of entries) {
        if (seenEventIDs.has(entry.event.id)) continue
        seenEventIDs.add(entry.event.id)
        let sequence = entry.sequence
        if (!Number.isSafeInteger(sequence) || sequence < 1) {
          sequence = nextSequence
          nextSequence += 1
        }
        const json = JSON.stringify(entry.event)
        this.sql.insertEventWithSequence.run(
          sequence,
          entry.event.id,
          entry.recipient.toLowerCase(),
          String(entry.event.pubkey ?? '').toLowerCase(),
          Number.isInteger(entry.event.created_at) ? entry.event.created_at : 0,
          Number.isInteger(entry.storedAt) ? entry.storedAt : loadedAt,
          Buffer.byteLength(json),
          json,
        )
      }
      // The next wrap stored is numbered after every sequence the old store handed out.
      this.db.prepare("DELETE FROM sqlite_sequence WHERE name = 'events'").run()
      this.db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('events', ?)").run(nextSequence - 1)

      for (const entry of list(parsed.preferences)) {
        const event = entry?.event
        if (typeof event?.id !== 'string' || typeof entry.pubkey !== 'string') continue
        this.sql.deletePreference.run(entry.pubkey.toLowerCase())
        this.sql.insertPreference.run(entry.pubkey.toLowerCase(), event.id, event.created_at ?? 0, JSON.stringify(event))
      }

      for (const entry of list(parsed.taskEvents)) {
        const coordinate = taskEventCoordinate(entry?.event)
        if (!coordinate || this.sql.taskEvent.get(coordinate)) continue
        const event = entry.event
        this.sql.insertTaskEvent.run(
          coordinate, event.pubkey.toLowerCase(), boardTagOf(event), event.kind, event.created_at, event.id,
          JSON.stringify(event), Number.isInteger(entry.lastSeenAt) ? entry.lastSeenAt : loadedAt,
        )
      }

      // A pending job from before preview tokens gets one, as loading such a file always did.
      const previews = list(parsed.previews)
      for (const job of list(parsed.pushJobs)) {
        if (typeof job?.id !== 'string' || !seenEventIDs.has(job.eventID)) continue
        const registration = registrationsByKey.get(job.registrationKey)
        if (!registration || this.sql.jobByID.get(job.id)) continue
        let previewToken = null
        if (registrationUsesPreview(registration)) {
          previewToken = PREVIEW_TOKEN.test(job.previewToken ?? '') ? job.previewToken : randomBytes(32).toString('base64url')
        }
        this.sql.insertJob.run(
          job.id, job.eventID, String(job.pubkey ?? registration.pubkey).toLowerCase(), job.registrationKey,
          Number.isInteger(job.attempts) ? job.attempts : 0,
          Number.isInteger(job.nextAttemptAt) ? job.nextAttemptAt : loadedAt,
          Number.isInteger(job.createdAt) ? job.createdAt : loadedAt,
          previewToken,
        )
        if (previewToken && !previews.some((preview) => preview?.token === previewToken)) {
          previews.push({ token: previewToken, eventID: job.eventID, registrationKey: job.registrationKey, expiresAt: loadedAt + this.previewTTLSeconds })
        }
      }
      const imported = new Set()
      for (const preview of previews) {
        if (!PREVIEW_TOKEN.test(preview?.token ?? '') || imported.has(preview.token)) continue
        if (!seenEventIDs.has(preview.eventID) || !registrationsByKey.has(preview.registrationKey)) continue
        this.sql.insertPreview.run(preview.token, preview.eventID, preview.registrationKey, Number.isInteger(preview.expiresAt) ? preview.expiresAt : 0)
        imported.add(preview.token)
      }
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('imported_state_json', ?)").run(String(loadedAt))
    })
    renameSync(this.legacyStatePath, `${this.legacyStatePath}.imported`)
  }
}
