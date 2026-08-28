import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

const EMPTY_STATE = Object.freeze({
  version: 1,
  registrations: [],
  events: [],
  preferences: [],
  pushJobs: [],
  previews: [],
})

function cloneEmptyState() {
  return JSON.parse(JSON.stringify(EMPTY_STATE))
}

export class RelayStore {
  constructor({
    dataDirectory,
    eventTTLSeconds = 30 * 24 * 60 * 60,
    maxEventsPerRecipient = 500,
    maxEventsTotal = 100_000,
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
        version: 1,
        registrations: Array.isArray(parsed.registrations) ? parsed.registrations : [],
        events: Array.isArray(parsed.events) ? parsed.events : [],
        preferences: Array.isArray(parsed.preferences) ? parsed.preferences : [],
        pushJobs: Array.isArray(parsed.pushJobs) ? parsed.pushJobs : [],
        previews: Array.isArray(parsed.previews) ? parsed.previews : [],
      }
      const loadedAt = this.now()
      for (const job of this.state.pushJobs) {
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

  async putRegistration(pubkey, installationID, { deviceToken, environment }) {
    const normalizedPubkey = pubkey.toLowerCase()
    const key = this.registrationKey(normalizedPubkey, installationID)
    const registration = {
      key,
      pubkey: normalizedPubkey,
      installationID,
      deviceToken: deviceToken.toLowerCase(),
      environment,
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

  async putGiftWrap(event, { notify }) {
    this.prune()
    if (this.state.events.some((entry) => entry.event.id === event.id)) return false
    const recipient = event.tags.find((tag) => tag[0] === 'p')[1].toLowerCase()
    const storedAt = this.now()
    this.state.events.push({ event, recipient, storedAt })
    this.enforceEventBounds(recipient)
    if (notify) {
      for (const registration of this.registrationsFor(recipient)) {
        const id = `${event.id}:${registration.key}`
        if (this.state.pushJobs.some((job) => job.id === id)) continue
        const previewToken = randomBytes(32).toString('base64url')
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
        this.state.previews.push({
          token: previewToken,
          eventID: event.id,
          registrationKey: registration.key,
          expiresAt: storedAt + this.previewTTLSeconds,
        })
      }
    }
    await this.persist()
    return true
  }

  async putPreference(event) {
    const pubkey = event.pubkey.toLowerCase()
    const current = this.state.preferences.find((candidate) => candidate.pubkey === pubkey)
    if (current && current.event.created_at >= event.created_at) return false
    this.state.preferences = this.state.preferences.filter((candidate) => candidate.pubkey !== pubkey)
    this.state.preferences.push({ pubkey, event })
    await this.persist()
    return true
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
        && this.registrationByKey(preview.registrationKey),
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

  async persist() {
    const snapshot = JSON.stringify(this.state)
    const temporaryPath = `${this.statePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
    this.writeChain = this.writeChain.then(async () => {
      await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 })
      await rename(temporaryPath, this.statePath)
    })
    return this.writeChain
  }
}
