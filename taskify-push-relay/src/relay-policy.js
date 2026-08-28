const HEX_PUBLIC_KEY = /^[0-9a-f]{64}$/

export function giftWrapRecipient(event) {
  if (event?.kind !== 1059 || !Array.isArray(event.tags)) {
    throw new Error('Only kind 1059 gift wraps are accepted')
  }
  const recipientTags = event.tags.filter((tag) => Array.isArray(tag) && tag[0] === 'p')
  if (recipientTags.length !== 1) throw new Error('Gift wrap must have exactly one recipient p tag')
  const recipient = recipientTags[0][1]?.toLowerCase()
  if (!HEX_PUBLIC_KEY.test(recipient ?? '')) throw new Error('Gift wrap recipient is invalid')
  return recipient
}

export function assertAuthorizedGiftWrapFilters(filters, authenticatedPubkey) {
  if (!HEX_PUBLIC_KEY.test(authenticatedPubkey ?? '')) {
    throw new Error('auth-required: authenticate before reading gift wraps')
  }
  if (!Array.isArray(filters) || filters.length === 0 || filters.length > 5) {
    throw new Error('restricted: invalid subscription filters')
  }
  for (const filter of filters) {
    const kinds = filter?.kinds
    const recipients = filter?.['#p']
    if (!Array.isArray(kinds) || kinds.length !== 1 || kinds[0] !== 1059) {
      throw new Error('restricted: this relay only serves kind 1059 recipient subscriptions')
    }
    if (!Array.isArray(recipients) || recipients.length !== 1 || recipients[0]?.toLowerCase() !== authenticatedPubkey) {
      throw new Error('restricted: subscription recipient must match the authenticated pubkey')
    }
  }
}

export function shouldNotifyRecipient({ authenticatedPubkey, recipientPubkey }) {
  return authenticatedPubkey?.toLowerCase() !== recipientPubkey?.toLowerCase()
}

export function matchesFilter(event, filter) {
  if (Array.isArray(filter.ids) && !filter.ids.some((id) => event.id.startsWith(id))) return false
  if (Array.isArray(filter.authors) && !filter.authors.some((author) => event.pubkey.startsWith(author))) return false
  if (Array.isArray(filter.kinds) && !filter.kinds.includes(event.kind)) return false
  if (Number.isInteger(filter.since) && event.created_at < filter.since) return false
  if (Number.isInteger(filter.until) && event.created_at > filter.until) return false
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#') || !Array.isArray(values)) continue
    const tagName = key.slice(1)
    if (!event.tags.some((tag) => tag[0] === tagName && values.includes(tag[1]))) return false
  }
  return true
}
