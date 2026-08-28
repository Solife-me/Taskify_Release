import { LangDict } from './default'

const english = {
  0: 'Apple Team ID',
  1: 'The 10-character Team ID from Apple Developer membership details.',
  2: 'APNs Key ID',
  3: 'The 10-character Key ID for the uploaded APNs authentication key.',
  4: 'APNs .p8 Private Key',
  5: 'Open the downloaded .p8 file in a text editor and paste its complete contents.',
  6: 'App Bundle ID',
  7: 'The APNs topic. It must match the signed Taskify app bundle identifier.',
  8: 'Configure Apple Push',
  9: 'Store the APNs provider credentials used for content-free wake delivery.',
  10: 'The pasted private key is sensitive. Keep your StartOS account and backups secure.',
  11: 'Configure Apple Push credentials before starting the relay',
  12: 'NIP-17 Push Relay',
  13: 'HTTPS registration API and WebSocket Nostr relay.',
  14: 'Starting Taskify Push Relay',
  15: 'Push Relay',
  16: 'Taskify Push Relay is listening',
  17: 'Waiting for Taskify Push Relay',
} satisfies LangDict

export default {
  es_ES: english,
  de_DE: english,
  pl_PL: english,
  fr_FR: english,
} satisfies Record<string, LangDict>
