# iOS sharing and 500 MB attachments

Status: implemented after user approval on 2026-09-02. The user explicitly requested automatic conversation suggestions with no opt-in setting. Device and live-host verification remain outstanding.

The user requested Taskify in both the iOS share sheet's application row and its
conversation suggestions, with photos/files sent through DMs, and an increase from
50 MB to 500 MB. The user explicitly requires approval before changes affecting
privacy or security. The follow-up approved the extension access and file-based encryption changes and removed the proposed opt-in setting. The implementation follows that updated authorization.

## Findings

- `taskify-ios-native` is the active native application. The Xcode project has app,
  widget and Watch targets, but no Share extension.
- `TaskDocumentContract.maximumUploadBytes` currently limits native attachments to
  `50 * 1_024 * 1_024` bytes. Both task and chat uploads use this contract.
- `TaskAttachmentUploadService` encrypts whole `Data` buffers. Originless multipart
  construction and Blossom request bodies also retain large buffers. NIP-96 already
  writes multipart ciphertext to a temporary upload file, but its encryption input
  still resides in memory. Upload requests currently use a 120-second timeout.
- Chat Photos imports load `Data`; Files imports map the file and then encrypt the
  complete contents. Chat downloads likewise load and decrypt the full attachment.
  Task previews have another independent 50 MB download limit.
- DM attachments use AES-256-GCM with a random per-file key, a 16-byte nonce and a
  16-byte authentication tag. The uploaded blob is ciphertext followed by its tag.
  Its SHA-256 and decryption information travel inside the encrypted NIP-17 message.
  This matches the PWA/0xchat format. Task attachments have a different existing
  envelope, including the `TFA2` prefix; legacy task attachments must remain readable.
- Uploads go directly to the configured Originless, Blossom or NIP-96 server.
  Increasing a native limit cannot override a host's own upload limit. No remote
  server configuration has been changed or live test attachment uploaded.
- The existing App Group contains the main snapshot, which is broader than a share
  extension needs. Wallet Keychain queries do not explicitly select an access group;
  sharing the existing Keychain entitlement must not be assumed to exclude them.

## Approved privacy and security changes

### 1. Share extension access

Add a Taskify Share extension accepting images, videos, files, text and URLs. Show a
recipient selector, preview and explicit Send button, with a selected conversation
prefilled when launched from a suggestion. Support existing one-to-one, self and
group conversations, including current checks against sending to a left group.

Use a dedicated App Group for the app and Share extension, containing a minimal
recipient/routing snapshot, transfer state and temporary shared files. Do not grant
the extension the existing whole-app snapshot container. Protect temporary files,
exclude them from backups, coordinate cross-process writes and remove files on
completion, cancellation, expiry and account changes.

Give the extension access to the Nostr messaging private key through a dedicated
Keychain access group with device-only protection. Audit the app's default Keychain
group ordering so adding this entitlement cannot change wallet storage. Keep wallet
seeds, payment keys and tokens outside the extension's access groups. The messaging
key nevertheless gives the extension cryptographic authority to sign as the user;
this is a real expansion of access, even though both processes belong to Taskify.
Synchronize key replacement/revocation and bind queued work to its originating account.

Reuse NIP-17 wrapping and strict recipient-advertised inbox routing. Store transfer
records separately and let the application reconcile them into its history, avoiding
concurrent whole-snapshot writes. Use supported background file uploads and app
completion handling for long transfers. Distinguish queued work from delivery and
deduplicate retries with stable message/event identities.

### 2. Automatic conversation suggestions

Supply iOS with recipient display names, opaque conversation identifiers and
message-interaction activity for share suggestions automatically, as requested.
The implementation does not add an opt-in setting or fetch avatars for suggestions. Do not donate message bodies, attachment names/content, keys or
the complete address book. Donate only for actual message interactions. Remove
donations when a conversation becomes unavailable or the account changes.

The app option and its own recipient picker also work when iOS does not show a suggested chat.
iOS controls which suggested conversations appear and their ranking; appearance
cannot be guaranteed. This exposes metadata outside Taskify's private UI and is the
reason approval is needed even with message content omitted.

### 3. File-based encryption and transfer for 500 MB

Replace whole-file encryption/decryption with bounded-memory processing that
preserves the existing AES-GCM wire formats, key generation and authentication.
Use file representations for Photos and Files, incremental hashing, file-backed
multipart construction and upload tasks, and disk-based downloads/previews.

CryptoSwift 1.10.0 is pinned behind the small TaskifyFileCipher module. Compatibility
and tamper tests cover both existing formats. Decryption uses a separately supplied
GCM tag to avoid combined-mode buffering assumptions for short/truncated files; the
wire format is unchanged. Per-chunk autorelease pools keep Foundation I/O buffers
bounded. Release-build device performance measurements remain outstanding. Do not implement a custom GCM primitive or use private
CommonCrypto APIs. If a suitable implementation cannot meet these requirements,
return to the user before proposing a new attachment protocol.

Keep plaintext staging protected and short-lived. On download, verify the complete
authentication tag and expected hash before publishing a preview or releasing
decrypted content to consumers. Delete unauthenticated output on any failure.
Retain HTTPS upload requirements, configured storage providers, encrypted DM
metadata and opaque DM upload filenames.

After the file path is validated, raise the common native plaintext limit to
`500 * 1_024 * 1_024` bytes, following the existing binary interpretation of “MB”.
Account separately for encryption and multipart overhead. Enforce limits during
imports/downloads as well as from declared sizes, and handle insufficient disk space,
cancellation, background completion and server rejection. Update task and chat
receive paths alongside sending. Avoid retaining large plaintext in the image cache.

## Implementation and verification after approval

1. Validate incremental encryption against current CryptoKit and PWA WebCrypto
   fixtures: both formats, nonce lengths, unaligned chunk boundaries, legacy reads,
   tampered ciphertext/tag/hash, truncation and no visible plaintext on failure.
2. Implement file import, upload and download paths. Exercise 50 MB, 500 MB and
   over-limit files, slow transfer, cancellation, insufficient disk space and
   retry behavior. Measure memory on an actual supported iPhone and in the extension.
3. Add the extension target, isolated shared data and Keychain access, account
   lifecycle handling, recipient picker and background transfer completion.
   Verify recipient and sender copies and strict routing for DMs and groups.
4. Add automatic suggestions and lifecycle cleanup. Suggested recipients must pass
   the current account and group membership checks. No opt-in setting is added.
5. Build the native app and extension, run focused crypto/transport tests, verify
   native-to-PWA and PWA-to-native attachment compatibility, and test shares from
   Photos, Files and Safari on device. Confirm the configured host can accept a
   500 MB encrypted upload before reporting end-to-end support. Existing clients
   may still face memory limits despite wire compatibility.
6. Update native documentation/settings text and report any device, signing,
   provisioning or storage-host limitations. Register/provision the new extension
   and dedicated App Group for device distribution as needed.

## References

- [Apple: supporting share-extension suggestions](https://developer.apple.com/documentation/foundation/supporting-suggestions-in-your-app-s-share-extension)
- [Apple: extension shared containers and background file transfers](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionScenarios.html)
- [CryptoSwift incremental API documentation](https://github.com/krzyzanowskim/CryptoSwift)
- [CryptoSwift GCM implementation](https://github.com/krzyzanowskim/CryptoSwift/blob/main/Sources/CryptoSwift/BlockMode/GCM.swift)
- [NIP-17 file messages and direct-parent reply tags](https://github.com/nostr-protocol/nips/blob/master/17.md)

## Attachment comments

The user's follow-up requested an optional comment in both the in-app DM composer
and the Share extension. Selecting a photo, video or file now stages a removable
preview. The app waits for an explicit Send action before uploading and queueing
the message. Both composers use the “Add comment or Send” field.

The attachment remains a standard kind-15 rumor containing only its encrypted file
URL. A nonblank comment becomes a separate kind-14 rumor with an `e` tag pointing
to the attachment's canonical rumor ID, with the same conversation participants
and group subject. If the attachment replies to an earlier message, its comment
still replies to the new attachment. Multiple shared files receive one comment,
attached to the last selected file; file uploads can finish independently.

The complete set of recipient and sender wraps is saved before publication. Each
comment copy depends on acknowledgement of the attachment copy for that recipient.
Dependency changes are persisted before releasing a reply, and retries preserve
the saved event IDs. The app imports both share receipts before consuming a completed
transfer. Older transfer/outbox records still decode. Failed uploads or enqueue
operations retain the in-app draft, and a completed upload can be reused on retry.

The updated simulator app and extension build passed. All 102 selected tests passed,
including 13 attachment-comment tests covering wire tags, DM/group/self recipients,
blank comments, ordering, restart and partial-failure recovery, failed disk writes,
expiry, older saved records and reversed history arrival. The existing large-file
encryption pipeline was unchanged. Visual verification remains pending because the
Mac was locked; the test sends used synthetic fixtures without a live DM or upload.

## Verification results

- The app, Share extension and existing widget/Watch targets build for iOS Simulator
  with signing disabled. The Share extension is embedded in the app bundle.
- 44 focused tests passed; the separate large-file test was skipped in that run.
- The 500 MiB file encrypt/decrypt/hash round trip passed separately in a release
  test process: 52.2 seconds, 34,422,784 bytes maximum resident set size (about 32.8 MiB).
  This measures the Mac test process, not an iPhone or the extension on a device.
- The initial whole-test-process memory measurement exposed accumulated Foundation
  I/O buffers; per-chunk autorelease pools resolved that growth.
- Four local HTTP download tests passed: missing Content-Length, actual and declared
  oversize responses, cancellation, and HTTP errors.
- Live visual verification could not proceed because the Mac was locked. No
  actual user attachment or live test DM was sent, and storage-server limits were
  not modified. New extension/App Group provisioning is required for device builds.

## 83 MB live-test follow-up

The user reported that an approximately 83 MB MP3 stalled in both the Share sheet
and the in-app composer, using Originless and Blossom. Both entry points perform
the same incremental encryption before starting their HTTP transfer. The original
composer exposed no byte progress during this stage.

A synthetic 1 MiB benchmark of that exact cipher measured 5.3907 seconds with
CryptoSwift built in Debug and 0.0466 seconds in Release. Optimizing only the
calling wrapper still took 5.1686 seconds. An 83 MiB file could therefore spend
over seven minutes in Debug encryption before uploading. This is a reproduced
build-specific slowdown, not confirmation of the user's installation configuration;
the Xcode-versus-TestFlight question remains unanswered. A read-only request to
`https://originless.solife.me/status` reported a 2 GiB application upload limit.
That does not establish any reverse-proxy limit or the selected Blossom host's limit.

The standard Xcode Run action now selects `Local`. Each native target's Local
configuration copies its Debug settings exactly, retaining development push,
signing, keychain/entitlement configuration, `DEBUG` and debugger support. Xcode
maps this configuration to optimized Swift package builds, as documented in the
[SwiftPM maintainers' configuration discussion](https://forums.swift.org/t/annoying-limitation-of-packagedescription-buildconfiguration/56037).
The actual simulator build commands confirmed CryptoSwift `-O -whole-module-optimization`
and app/extension `-Onone -DDEBUG`. Test/Analyze remain Debug; Archive/Profile remain
Release. No crypto primitive, wire format, file protection, endpoint or authorization
policy was changed for this fix.

Both composers now report encryption progress. In-app uploads also report actual
URLSession bytes, server-response waiting and DM queueing. Cancellation propagates
to encryption/file preparation and HTTP, preserves the attachment/comment draft,
and is unavailable after message queueing starts. Host rejections retain their
HTTP status and server label in an inline attachment error, including specific
413 and 415 descriptions.

Verification used synthetic data and a loopback HTTP fixture, without a live DM,
user file or real server upload. All 106 selected tests passed, including an actual
83 MiB file transfer through Originless multipart POST and authenticated Blossom
PUT, download/decryption/hash verification, byte progress, upload cancellation,
413 rejection and the existing attachment/comment delivery tests. The large case
took 12.27 seconds for encryption, both uploads, both downloads and both decryptions
on the Mac. The app and Share extension also built successfully for iOS Simulator.
The updated build still needs a live device retry; these results do not establish
the user's host/proxy behavior or iOS background-transfer completion.
