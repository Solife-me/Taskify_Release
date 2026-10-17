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
  'Store the APNs provider credentials used for metadata-free alert delivery.': 9,
  'The pasted private key is sensitive. Keep your StartOS account and backups secure.': 10,
  'Configure Apple Push credentials before starting the relay': 11,
  'NIP-17 Push Relay': 12,
  'HTTPS registration API and WebSocket Nostr relay.': 13,
  'Starting Taskify Push Relay': 14,
  'Push Relay': 15,
  'Taskify Push Relay is listening': 16,
  'Waiting for Taskify Push Relay': 17,
  'Watch App Bundle ID': 18,
  'The Watch APNs topic. It must match the signed Taskify Watch app bundle identifier.': 19,
  'Snapstr App Bundle ID': 20,
  'The APNs topic. It must match the signed Snapstr app bundle identifier.': 21,
  'Configure Android Push': 22,
  'Store the Firebase service account used to wake Snapstr on Android. Leave blank to turn Android push off.': 23,
  'Firebase Service Account JSON': 24,
  'In the Firebase console, open Project settings, Service accounts, and Generate new private key. Paste the complete downloaded JSON file.': 25,
  'Configure Web Push': 26,
  'Store the Taskify Worker VAPID key pair so the Taskify web app gets chat alerts. Leave the private key blank to turn web push off.': 27,
  'VAPID Public Key': 28,
  'The Worker VAPID_PUBLIC_KEY (base64url). Browsers subscribe with this key, so it must be the same one.': 29,
  'VAPID Private Key': 30,
  'The Worker VAPID_PRIVATE_KEY: base64url or PEM.': 31,
  'VAPID Subject': 32,
  'A mailto: or https:// contact for push services, usually the Worker VAPID_SUBJECT.': 33,
} as const

export type I18nKey = keyof typeof dict
export type LangDict = Record<(typeof dict)[I18nKey], string>
export default dict
