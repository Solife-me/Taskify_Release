export const DEFAULT_LANG = 'en_US'

const dict = {
  'Apple Team ID': 0,
  'The 10-character Team ID from Apple Developer membership details.': 1,
  'APNs Key ID': 2,
  'The 10-character Key ID for the uploaded APNs authentication key.': 3,
  'APNs .p8 Private Key': 4,
  'Open the downloaded .p8 file in a text editor and paste its complete contents.': 5,
  'App Bundle ID': 6,
  'The APNs topic. It must match the signed Taskify app bundle identifier.': 7,
  'Configure Apple Push': 8,
  'Store the APNs provider credentials used for content-free wake delivery.': 9,
  'The pasted private key is sensitive. Keep your StartOS account and backups secure.': 10,
  'Configure Apple Push credentials before starting the relay': 11,
  'NIP-17 Push Relay': 12,
  'HTTPS registration API and WebSocket Nostr relay.': 13,
  'Starting Taskify Push Relay': 14,
  'Push Relay': 15,
  'Taskify Push Relay is listening': 16,
  'Waiting for Taskify Push Relay': 17,
} as const

export type I18nKey = keyof typeof dict
export type LangDict = Record<(typeof dict)[I18nKey], string>
export default dict
