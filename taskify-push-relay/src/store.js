import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

const EMPTY_STATE = Object.freeze({
  version: 3,
  nextEventSequence: 1,
  registrations: [],
  events: [],
  preferences: [],
  taskEvents: [],
  pushJobs: [],
  previews: [],
})

const TASK_EVENT_KINDS = new Set([30_300, 30_301])
const HEX_EVENT_ID = /^[0-9a-f]{64}$/
const HEX_PUBLIC_KEY = /^[0-9a-f]{64}$/

function eventCoordinate(event) {
  const pubkey = event?.pubkey?.toLowerCase()
  if (!HEX_PUBLIC_KEY.test(pubkey ?? '')) return null
  if (event.kind === 0 || event.kind === 3 || (event.kind >= 10_000 && event.kind < 20_000)) {
    return `${event.kind}:${pubkey}:`
  }
  if (event.kind < 30_000 || event.kind >= 40_000) return null
  const identifiers = event.tags?.filter(
    (tag) => Array.isArray(tag) && tag[0] === 'd' && typeof tag[1] === 'string',
  ) ?? []
  if (identifiers.length !== 1) return null
  return `${event.kind}:${pubkey}:${identifiers[0][1]}`
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

function cloneEmptyState() {
  return JSON.parse(JSON.stringify(EMPTY_STATE))
}

export class RelayStore {
  constructor({
    dataDirectory,
    eventTTLSeconds = 30 * 24 * 60 * 60,
    maxEventsPerRecipient = 500,
    maxEventsTotal = 100_000,
    // Byte budgets keep the whole-file state small enough to rewrite quickly and well below
    // the engine's maximum string size, however many keys a sender uses.
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
    this.statePath = path.join(dataDirectory, 'state.json')
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
    this.state = cloneEmptyState()
    this.writeChain = Promise.resolve()
  }

  async load() {
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 })
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8'))
      this.state = {
        version: 3,
        nextEventSequence: Number.isSafeInteger(parsed.nextEventSequence)
          ? parsed.nextEventSequence
          : 1,
        registrations: Array.isArray(parsed.registrations) ? parsed.registrations : [],
        events: Array.isArray(parsed.events) ? parsed.events : [],
        preferences: Array.isArray(parsed.preferences) ? parsed.preferences : [],
        taskEvents: Array.isArray(parsed.taskEvents) ? parsed.taskEvents : [],
        pushJobs: Array.isArray(parsed.pushJobs) ? parsed.pushJobs : [],
        previews: Array.isArray(parsed.previews) ? parsed.previews : [],
      }
      let nextSequence = this.state.nextEventSequence
      for (const entry of this.state.events.sort((left, right) => left.storedAt - right.storedAt)) {
        if (!Number.isInteger(entry.bytes)) entry.bytes = Buffer.byteLength(JSON.stringify(entry.event))
        if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 1) {
          entry.sequence = nextSequence
          nextSequence += 1
        } else {
          nextSequence = Math.max(nextSequence, entry.sequence + 1)
        }
      }
      this.state.nextEventSequence = nextSequence
      const loadedAt = this.now()
      for (const registration of this.state.registrations) {
        if (!Number.isInteger(registration.updatedAt)) registration.updatedAt = loadedAt
      }
      this.state.taskEvents = this.state.taskEvents.filter((entry) => {
        if (!taskEventCoordinate(entry.event)) return false
        if (!Number.isInteger(entry.lastSeenAt)) entry.lastSeenAt = loadedAt
        return true
      })
      for (const job of this.state.pushJobs) {
        const registration = this.registrationByKey(job.registrationKey)
        if (registration?.platform === 'watchos') {
          delete job.previewToken
          continue
        }
        if (!/^[A-Za-z0-9_-]{43}$/.test(job.previewToken ?? '')) {
          job.previewToken = randomBytes(32).toString('base64url')
        }
        if (!this.state.previews.some((preview) => preview.token === job.previewToken)) {
          this.state.previews.push({
            token: job.previewToken,
            eventID: job.eventID,
            registrationKey: job.registrationKey,
            expiresAt: loadedAt + this.previewTTLSeconds,
          })
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      this.state = cloneEmptyState()
    }
    this.prune()
    await this.persist()
  }

  registrationKey(pubkey, installationID) {
    return `${pubkey.toLowerCase()}:${installationID}`
  }

  registrationsFor(pubkey) {
    return this.state.registrations.filter((registration) => registration.pubkey === pubkey.toLowerCase())
  }

  registrationByKey(key) {
    return this.state.registrations.find((registration) => registration.key === key) ?? null
  }

  /// Whether `pubkey` uses this relay as an inbox: it has a device registered here or has
  /// published its inbox preference here. Gift wraps for anyone else are not stored.
  hasInbox(pubkey) {
    const normalized = pubkey.toLowerCase()
    return this.state.registrations.some((registration) => registration.pubkey === normalized)
      || this.state.preferences.some((preference) => preference.pubkey === normalized)
  }

  async putRegistration(
    pubkey,
    installationID,
    { deviceToken, environment, platform = 'ios', application = 'taskify' },
  ) {
    const normalizedPubkey = pubkey.toLowerCase()
    const key = this.registrationKey(normalizedPubkey, installationID)
    const registration = {
      key,
      pubkey: normalizedPubkey,
      installationID,
      deviceToken: deviceToken.toLowerCase(),
      environment,
      platform,
      application,
      updatedAt: this.now(),
    }
    // Snapstr keeps several profiles on one phone and alerts for all of them, so its other
    // profiles on this installation stay registered, following the device's current token.
    // Taskify has one account per installation: registering another replaces it. Either way, a
    // registration elsewhere with this token is a stale install of the same app and is dropped.
    const keepsOtherProfiles = application === 'snapstr'
    const retainedRegistrations = []
    for (const candidate of this.state.registrations) {
      if (candidate.key === key) {
        retainedRegistrations.push(candidate)
      } else if (
        keepsOtherProfiles
        && candidate.installationID === installationID
        && candidate.application === application
      ) {
        retainedRegistrations.push({
          ...candidate,
          deviceToken: registration.deviceToken,
          environment: registration.environment,
        })
      } else if (
        candidate.installationID !== installationID
        && candidate.deviceToken !== registration.deviceToken
      ) {
        retainedRegistrations.push(candidate)
      }
    }
    const existingIndex = retainedRegistrations.findIndex((candidate) => candidate.key === key)
    const resultingTotal = retainedRegistrations.length + (existingIndex >= 0 ? 0 : 1)
    const resultingForPubkey = retainedRegistrations.filter(
      (candidate) => candidate.pubkey === normalizedPubkey,
    ).length + (existingIndex >= 0 ? 0 : 1)
    if (resultingForPubkey > this.maxRegistrationsPerPubkey) {
      throw new Error('Device registration limit exceeded')
    }
    if (resultingTotal > this.maxRegistrationsTotal) {
      // Full: make room by dropping the registration refreshed longest ago, rather than
      // refusing every new user. A live app that is dropped re-registers on its next launch.
      let stalest = -1
      for (let index = 0; index < retainedRegistrations.length; index += 1) {
        const candidate = retainedRegistrations[index]
        if (candidate.pubkey === normalizedPubkey) continue
        if (stalest < 0 || candidate.updatedAt < retainedRegistrations[stalest].updatedAt) stalest = index
      }
      if (stalest < 0) throw new Error('Device registration limit exceeded')
      const [evicted] = retainedRegistrations.splice(stalest, 1)
      this.state.pushJobs = this.state.pushJobs.filter((job) => job.registrationKey !== evicted.key)
      this.state.previews = this.state.previews.filter((preview) => preview.registrationKey !== evicted.key)
    }
    this.state.registrations = retainedRegistrations
    if (existingIndex >= 0) this.state.registrations[existingIndex] = registration
    else this.state.registrations.push(registration)
    await this.persist()
    return registration
  }

  async removeRegistration(pubkey, installationID) {
    const key = this.registrationKey(pubkey, installationID)
    const previousCount = this.state.registrations.length
    this.state.registrations = this.state.registrations.filter((registration) => registration.key !== key)
    this.state.pushJobs = this.state.pushJobs.filter((job) => job.registrationKey !== key)
    this.state.previews = this.state.previews.filter((preview) => preview.registrationKey !== key)
    if (this.state.registrations.length !== previousCount) await this.persist()
    return this.state.registrations.length !== previousCount
  }

  async removeRegistrationByKey(key) {
    const registration = this.registrationByKey(key)
    if (!registration) return false
    return this.removeRegistration(registration.pubkey, registration.installationID)
  }

  eventsFor(pubkey) {
    this.pruneForRead()
    return this.state.events
      .filter((entry) => entry.recipient === pubkey.toLowerCase())
      .map((entry) => entry.event)
      .sort((left, right) => left.created_at - right.created_at)
  }

  eventsAfter(pubkey, sequence = 0, limit = 100) {
    this.pruneForRead()
    const normalizedLimit = Math.max(1, Math.min(500, Number.isInteger(limit) ? limit : 100))
    const matches = this.state.events
      .filter((entry) => entry.recipient === pubkey.toLowerCase() && entry.sequence > sequence)
      .sort((left, right) => left.sequence - right.sequence)
    const page = matches.slice(0, normalizedLimit)
    return {
      events: page.map((entry) => entry.event),
      nextSequence: page.at(-1)?.sequence ?? sequence,
      hasMore: matches.length > page.length,
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
    this.prune()
    if (this.state.events.some((entry) => entry.event.id === event.id)) return false
    const recipient = event.tags.find((tag) => tag[0] === 'p')[1].toLowerCase()
    const storedAt = this.now()
    const sequence = this.state.nextEventSequence
    this.state.nextEventSequence += 1
    const bytes = Buffer.byteLength(JSON.stringify(event))
    this.state.events.push({ event, recipient, storedAt, sequence, bytes })
    this.enforceEventBounds(recipient)
    if (notify) {
      for (const registration of this.registrationsToNotify(recipient, application)) {
        const id = `${event.id}:${registration.key}`
        if (this.state.pushJobs.some((job) => job.id === id)) continue
        const previewToken = registration.platform === 'watchos'
          ? undefined
          : randomBytes(32).toString('base64url')
        // One unsent alert per device at a time, and a minimum gap after the last one sent,
        // so a burst of wraps (from anyone) becomes a few alerts rather than one per wrap.
        // The waiting job is repointed at the newest wrap so its preview shows the latest.
        const waiting = this.state.pushJobs.find(
          (job) => job.registrationKey === registration.key && job.attempts === 0,
        )
        if (waiting) {
          if (waiting.previewToken) {
            this.state.previews = this.state.previews.filter((preview) => preview.token !== waiting.previewToken)
          }
          waiting.id = id
          waiting.eventID = event.id
          waiting.previewToken = previewToken
        } else {
          this.state.pushJobs.push({
            id,
            eventID: event.id,
            pubkey: recipient,
            registrationKey: registration.key,
            attempts: 0,
            nextAttemptAt: Math.max(storedAt, (registration.lastPushAt ?? 0) + this.minimumPushIntervalSeconds),
            createdAt: storedAt,
            previewToken,
          })
        }
        if (previewToken) {
          this.state.previews.push({
            token: previewToken,
            eventID: event.id,
            registrationKey: registration.key,
            expiresAt: storedAt + this.previewTTLSeconds,
          })
        }
      }
    }
    await this.persist()
    return true
  }

  async putPreference(event) {
    const pubkey = event.pubkey.toLowerCase()
    const current = this.state.preferences.find((candidate) => candidate.pubkey === pubkey)
    if (current && (
      current.event.created_at > event.created_at
      || (current.event.created_at === event.created_at && current.event.id <= event.id)
    )) return false
    this.state.preferences = this.state.preferences.filter((candidate) => candidate.pubkey !== pubkey)
    this.state.preferences.push({ pubkey, event })
    await this.persist()
    return true
  }

  /// Applies a NIP-09 request only to events signed by the same key. Deleting an event also
  /// removes any notification job or preview that could still reveal the deleted ciphertext.
  async applyDeletionRequest(event) {
    const { eventIDs, addresses } = deletionTargets(event)
    const author = event.pubkey.toLowerCase()
    const deletes = (candidate) => {
      if (candidate.pubkey?.toLowerCase() !== author) return false
      if (eventIDs.has(candidate.id)) return true
      const coordinate = eventCoordinate(candidate)
      return coordinate != null
        && addresses.has(coordinate)
        && candidate.created_at <= event.created_at
    }

    const deletedEventIDs = new Set()
    this.state.events = this.state.events.filter((entry) => {
      if (!deletes(entry.event)) return true
      deletedEventIDs.add(entry.event.id)
      return false
    })
    const preferenceCount = this.state.preferences.length
    this.state.preferences = this.state.preferences.filter((entry) => !deletes(entry.event))
    const taskEventCount = this.state.taskEvents.length
    this.state.taskEvents = this.state.taskEvents.filter((entry) => !deletes(entry.event))
    if (deletedEventIDs.size > 0) {
      this.state.pushJobs = this.state.pushJobs.filter((job) => !deletedEventIDs.has(job.eventID))
      this.state.previews = this.state.previews.filter((preview) => !deletedEventIDs.has(preview.eventID))
    }
    const deletedCount = deletedEventIDs.size
      + (preferenceCount - this.state.preferences.length)
      + (taskEventCount - this.state.taskEvents.length)
    if (deletedCount > 0) await this.persist()
    return deletedCount
  }

  /// Caches only the latest signed replaceable board/task event per public Nostr coordinate.
  /// Entries intentionally have no account, device, requested-relay, or board-secret field, so
  /// the durable cache cannot reconstruct which Taskify identity requested a public ciphertext.
  async putTaskEvents(events) {
    const observedAt = this.now()
    let changed = false
    for (const event of events) {
      const coordinate = taskEventCoordinate(event)
      if (!coordinate) continue
      const index = this.state.taskEvents.findIndex((entry) => entry.coordinate === coordinate)
      if (index < 0) {
        this.state.taskEvents.push({ coordinate, event, lastSeenAt: observedAt })
        changed = true
        continue
      }
      const current = this.state.taskEvents[index]
      if (event.id === current.event.id) {
        // Refresh at most hourly to retain an actively used cache entry without forcing a full
        // state-file write for every foreground Watch refresh.
        if (current.lastSeenAt <= observedAt - 60 * 60) {
          current.lastSeenAt = observedAt
          changed = true
        }
        continue
      }
      if (replacesTaskEvent(event, current.event)) {
        this.state.taskEvents[index] = { coordinate, event, lastSeenAt: observedAt }
        changed = true
      }
    }
    const countBeforeBounds = this.state.taskEvents.length
    this.enforceTaskEventBounds()
    if (this.state.taskEvents.length !== countBeforeBounds) changed = true
    if (changed) await this.persist()
    return changed
  }

  taskEventsFor(authors, limit = 1_000, boardTagsByAuthor = null) {
    this.pruneForRead()
    const normalized = new Set(authors.map((author) => author.toLowerCase()))
    const boundedLimit = Math.max(1, Math.min(1_000, Number.isInteger(limit) ? limit : 1_000))
    return this.state.taskEvents
      .filter((entry) => {
        const author = entry.event.pubkey.toLowerCase()
        if (!normalized.has(author)) return false
        if (!boardTagsByAuthor) return true
        const boardTag = entry.event.tags.find((tag) => tag[0] === 'b')?.[1]?.toLowerCase()
        return boardTagsByAuthor.get(author) === boardTag
      })
      .sort((left, right) => {
        if (left.event.kind !== right.event.kind) return left.event.kind - right.event.kind
        if (left.event.created_at !== right.event.created_at) {
          return left.event.created_at - right.event.created_at
        }
        return left.event.id.localeCompare(right.event.id)
      })
      .slice(-boundedLimit)
      .map((entry) => entry.event)
  }

  preferencesFor(authors = []) {
    const normalized = new Set(authors.map((author) => author.toLowerCase()))
    return this.state.preferences
      .filter((entry) => normalized.size === 0 || normalized.has(entry.pubkey))
      .map((entry) => entry.event)
  }

  duePushJobs(nowSeconds = this.now(), limit = 100) {
    return this.state.pushJobs.filter((job) => job.nextAttemptAt <= nowSeconds).slice(0, limit)
  }

  previewForToken(token) {
    return this.previewEntryForToken(token)?.event ?? null
  }

  /// The gift wrap a preview token points at, and the account it was sent to.
  previewEntryForToken(token) {
    // Unauthenticated: never a full prune per request. Expiry is checked here directly.
    this.pruneForRead()
    const preview = this.state.previews.find((candidate) => candidate.token === token)
    if (!preview || preview.expiresAt < this.now()) return null
    const event = this.state.events.find((entry) => entry.event.id === preview.eventID)?.event
    if (!event) return null
    return { event, recipient: this.registrationByKey(preview.registrationKey)?.pubkey ?? null }
  }

  /// Preview URLs work once: the notification extension fetches each a single time.
  async consumePreview(token) {
    const count = this.state.previews.length
    this.state.previews = this.state.previews.filter((preview) => preview.token !== token)
    if (this.state.previews.length !== count) await this.persist()
  }

  /// `delivered` marks an alert Apple accepted, which starts the device's minimum push gap.
  async completePushJob(id, { retainPreview = false, delivered = false } = {}) {
    const completed = this.state.pushJobs.find((job) => job.id === id)
    const previousCount = this.state.pushJobs.length
    this.state.pushJobs = this.state.pushJobs.filter((job) => job.id !== id)
    if (!retainPreview && completed?.previewToken) {
      this.state.previews = this.state.previews.filter(
        (preview) => preview.token !== completed.previewToken,
      )
    }
    const registration = delivered && completed ? this.registrationByKey(completed.registrationKey) : null
    if (registration) registration.lastPushAt = this.now()
    if (previousCount !== this.state.pushJobs.length) await this.persist()
  }

  async retryPushJob(id, { delaySeconds }) {
    const job = this.state.pushJobs.find((candidate) => candidate.id === id)
    if (!job) return
    job.attempts += 1
    job.nextAttemptAt = this.now() + delaySeconds
    await this.persist()
  }

  pruneForRead() {
    if (this.now() - this.lastPrunedAt >= this.readPruneIntervalSeconds) this.prune()
  }

  prune() {
    this.lastPrunedAt = this.now()
    const registrationCutoff = this.now() - this.registrationTTLSeconds
    this.state.registrations = this.state.registrations.filter(
      (registration) => !Number.isInteger(registration.updatedAt) || registration.updatedAt >= registrationCutoff,
    )
    const registrationsByKey = new Map(
      this.state.registrations.map((registration) => [registration.key, registration]),
    )
    const cutoff = this.now() - this.eventTTLSeconds
    const retainedEventIDs = new Set()
    this.state.events = this.state.events.filter((entry) => {
      if (!Number.isInteger(entry.storedAt) || entry.storedAt < cutoff) return false
      retainedEventIDs.add(entry.event.id)
      return true
    })
    this.state.pushJobs = this.state.pushJobs.filter(
      (job) => retainedEventIDs.has(job.eventID) && registrationsByKey.has(job.registrationKey),
    )
    this.state.previews = this.state.previews.filter(
      (preview) => preview.expiresAt >= this.now()
        && retainedEventIDs.has(preview.eventID)
        && registrationsByKey.get(preview.registrationKey)?.platform !== 'watchos',
    )
    if (this.state.events.length > this.maxEventsTotal) {
      this.state.events.sort((left, right) => left.storedAt - right.storedAt)
      const evictedEventIDs = new Set(
        this.state.events
          .splice(0, this.state.events.length - this.maxEventsTotal)
          .map((entry) => entry.event.id),
      )
      this.state.pushJobs = this.state.pushJobs.filter((job) => !evictedEventIDs.has(job.eventID))
      this.state.previews = this.state.previews.filter(
        (preview) => !evictedEventIDs.has(preview.eventID),
      )
    }
    const taskCutoff = this.now() - this.taskEventTTLSeconds
    this.state.taskEvents = this.state.taskEvents.filter(
      (entry) => Number.isInteger(entry.lastSeenAt) && entry.lastSeenAt >= taskCutoff,
    )
    this.enforceTaskEventBounds({ pruneFirst: false })
  }

  enforceEventBounds(recipient) {
    const remove = new Set()
    const evictOldest = (entries, count, bytes, maxCount, maxBytes) => {
      entries.sort((left, right) => left.storedAt - right.storedAt)
      for (const entry of entries) {
        if (count <= maxCount && bytes <= maxBytes) break
        remove.add(entry.event.id)
        count -= 1
        bytes -= entry.bytes ?? 0
      }
    }
    const recipientEntries = this.state.events.filter((entry) => entry.recipient === recipient)
    evictOldest(
      recipientEntries,
      recipientEntries.length,
      recipientEntries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0),
      this.maxEventsPerRecipient,
      this.maxBytesPerRecipient,
    )
    const retained = this.state.events.filter((entry) => !remove.has(entry.event.id))
    const totalBytes = retained.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0)
    if (totalBytes > this.maxBytesTotal) {
      evictOldest(retained, 0, totalBytes, Number.MAX_SAFE_INTEGER, this.maxBytesTotal)
    }
    if (remove.size > 0) {
      this.state.events = this.state.events.filter((entry) => !remove.has(entry.event.id))
      this.state.pushJobs = this.state.pushJobs.filter((job) => !remove.has(job.eventID))
      this.state.previews = this.state.previews.filter((preview) => !remove.has(preview.eventID))
    }
    this.prune()
  }

  enforceTaskEventBounds({ pruneFirst = true } = {}) {
    if (pruneFirst) {
      const taskCutoff = this.now() - this.taskEventTTLSeconds
      this.state.taskEvents = this.state.taskEvents.filter(
        (entry) => Number.isInteger(entry.lastSeenAt) && entry.lastSeenAt >= taskCutoff,
      )
    }
    const byAuthor = new Map()
    for (const entry of this.state.taskEvents) {
      const author = entry.event.pubkey.toLowerCase()
      const entries = byAuthor.get(author) ?? []
      entries.push(entry)
      byAuthor.set(author, entries)
    }
    const remove = new Set()
    for (const entries of byAuthor.values()) {
      if (entries.length <= this.maxTaskEventsPerAuthor) continue
      entries.sort((left, right) => {
        if (left.lastSeenAt !== right.lastSeenAt) return left.lastSeenAt - right.lastSeenAt
        return left.event.created_at - right.event.created_at
      })
      for (const entry of entries.slice(0, entries.length - this.maxTaskEventsPerAuthor)) {
        remove.add(entry.coordinate)
      }
    }
    if (remove.size > 0) {
      this.state.taskEvents = this.state.taskEvents.filter(
        (entry) => !remove.has(entry.coordinate),
      )
    }
    if (this.state.taskEvents.length > this.maxTaskEventsTotal) {
      this.state.taskEvents.sort((left, right) => {
        if (left.lastSeenAt !== right.lastSeenAt) return left.lastSeenAt - right.lastSeenAt
        return left.event.created_at - right.event.created_at
      })
      this.state.taskEvents.splice(0, this.state.taskEvents.length - this.maxTaskEventsTotal)
    }
  }

  async persist() {
    const snapshot = JSON.stringify(this.state)
    const temporaryPath = `${this.statePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
    // A failed write rejects its own caller only; the next write still runs, so one full disk
    // or permissions slip does not stop every later change from being saved.
    const write = this.writeChain.catch(() => {}).then(async () => {
      try {
        await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 })
        await rename(temporaryPath, this.statePath)
      } catch (error) {
        await unlink(temporaryPath).catch(() => {})
        throw error
      }
    })
    this.writeChain = write
    return write
  }

  async flush() {
    await this.writeChain
  }
}
