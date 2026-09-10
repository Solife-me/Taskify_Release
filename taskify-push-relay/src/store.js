import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
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
    taskEventTTLSeconds = 30 * 24 * 60 * 60,
    maxTaskEventsPerAuthor = 2_000,
    maxTaskEventsTotal = 100_000,
    maxRegistrationsPerPubkey = 10,
    maxRegistrationsTotal = 100_000,
    previewTTLSeconds = 15 * 60,
    now = () => Math.floor(Date.now() / 1000),
  }) {
    this.dataDirectory = dataDirectory
    this.statePath = path.join(dataDirectory, 'state.json')
    this.eventTTLSeconds = eventTTLSeconds
    this.maxEventsPerRecipient = maxEventsPerRecipient
    this.maxEventsTotal = maxEventsTotal
    this.taskEventTTLSeconds = taskEventTTLSeconds
    this.maxTaskEventsPerAuthor = maxTaskEventsPerAuthor
    this.maxTaskEventsTotal = maxTaskEventsTotal
    this.maxRegistrationsPerPubkey = maxRegistrationsPerPubkey
    this.maxRegistrationsTotal = maxRegistrationsTotal
    this.previewTTLSeconds = previewTTLSeconds
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
        if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 1) {
          entry.sequence = nextSequence
          nextSequence += 1
        } else {
          nextSequence = Math.max(nextSequence, entry.sequence + 1)
        }
      }
      this.state.nextEventSequence = nextSequence
      const loadedAt = this.now()
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

  async putRegistration(pubkey, installationID, { deviceToken, environment, platform = 'ios' }) {
    const normalizedPubkey = pubkey.toLowerCase()
    const key = this.registrationKey(normalizedPubkey, installationID)
    const registration = {
      key,
      pubkey: normalizedPubkey,
      installationID,
      deviceToken: deviceToken.toLowerCase(),
      environment,
      platform,
      updatedAt: this.now(),
    }
    const retainedRegistrations = this.state.registrations.filter(
      (candidate) => candidate.key === key
        || (candidate.installationID !== installationID && candidate.deviceToken !== registration.deviceToken),
    )
    const existingIndex = retainedRegistrations.findIndex((candidate) => candidate.key === key)
    const resultingTotal = retainedRegistrations.length + (existingIndex >= 0 ? 0 : 1)
    const resultingForPubkey = retainedRegistrations.filter(
      (candidate) => candidate.pubkey === normalizedPubkey,
    ).length + (existingIndex >= 0 ? 0 : 1)
    if (resultingForPubkey > this.maxRegistrationsPerPubkey
        || resultingTotal > this.maxRegistrationsTotal) {
      throw new Error('Device registration limit exceeded')
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
    this.prune()
    return this.state.events
      .filter((entry) => entry.recipient === pubkey.toLowerCase())
      .map((entry) => entry.event)
      .sort((left, right) => left.created_at - right.created_at)
  }

  eventsAfter(pubkey, sequence = 0, limit = 100) {
    this.prune()
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

  async putGiftWrap(event, { notify }) {
    this.prune()
    if (this.state.events.some((entry) => entry.event.id === event.id)) return false
    const recipient = event.tags.find((tag) => tag[0] === 'p')[1].toLowerCase()
    const storedAt = this.now()
    const sequence = this.state.nextEventSequence
    this.state.nextEventSequence += 1
    this.state.events.push({ event, recipient, storedAt, sequence })
    this.enforceEventBounds(recipient)
    if (notify) {
      for (const registration of this.registrationsFor(recipient)) {
        const id = `${event.id}:${registration.key}`
        if (this.state.pushJobs.some((job) => job.id === id)) continue
        const previewToken = registration.platform === 'watchos'
          ? undefined
          : randomBytes(32).toString('base64url')
        this.state.pushJobs.push({
          id,
          eventID: event.id,
          pubkey: recipient,
          registrationKey: registration.key,
          attempts: 0,
          nextAttemptAt: storedAt,
          createdAt: storedAt,
          previewToken,
        })
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
    this.prune()
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
    this.prune()
    const preview = this.state.previews.find((candidate) => candidate.token === token)
    if (!preview) return null
    return this.state.events.find((entry) => entry.event.id === preview.eventID)?.event ?? null
  }

  async completePushJob(id, { retainPreview = false } = {}) {
    const completed = this.state.pushJobs.find((job) => job.id === id)
    const previousCount = this.state.pushJobs.length
    this.state.pushJobs = this.state.pushJobs.filter((job) => job.id !== id)
    if (!retainPreview && completed?.previewToken) {
      this.state.previews = this.state.previews.filter(
        (preview) => preview.token !== completed.previewToken,
      )
    }
    if (previousCount !== this.state.pushJobs.length) await this.persist()
  }

  async retryPushJob(id, { delaySeconds }) {
    const job = this.state.pushJobs.find((candidate) => candidate.id === id)
    if (!job) return
    job.attempts += 1
    job.nextAttemptAt = this.now() + delaySeconds
    await this.persist()
  }

  prune() {
    const cutoff = this.now() - this.eventTTLSeconds
    const retainedEventIDs = new Set()
    this.state.events = this.state.events.filter((entry) => {
      if (!Number.isInteger(entry.storedAt) || entry.storedAt < cutoff) return false
      retainedEventIDs.add(entry.event.id)
      return true
    })
    this.state.pushJobs = this.state.pushJobs.filter(
      (job) => retainedEventIDs.has(job.eventID) && this.registrationByKey(job.registrationKey),
    )
    this.state.previews = this.state.previews.filter(
      (preview) => preview.expiresAt >= this.now()
        && retainedEventIDs.has(preview.eventID)
        && this.registrationByKey(preview.registrationKey)?.platform !== 'watchos',
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
    const recipientEntries = this.state.events.filter((entry) => entry.recipient === recipient)
    if (recipientEntries.length > this.maxEventsPerRecipient) {
      recipientEntries.sort((left, right) => left.storedAt - right.storedAt)
      const remove = new Set(
        recipientEntries.slice(0, recipientEntries.length - this.maxEventsPerRecipient).map((entry) => entry.event.id),
      )
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
    this.writeChain = this.writeChain.then(async () => {
      await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 })
      await rename(temporaryPath, this.statePath)
    })
    return this.writeChain
  }

  async flush() {
    await this.writeChain
  }
}
