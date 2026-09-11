# PWA / iOS task and DM history recovery

The September 11 investigation focused on tasks missing from boards and missing DMs
when reopening an older PWA installation with the same account. These are code-level
findings and regression reproductions; the affected account's private relay history
has not been inspected and the changes have not been deployed.

## Causes and corrections

- **Board history completion raced asynchronous decryption.** EOSE read and removed
  relay batches before queued task handlers finished adding their records. Completion,
  timeout flushing, and subscription cleanup now run behind the board's event queue.
- **A saved cursor did not prove complete task history.** The PWA advanced a board's
  cursor while receiving newest-first history. Older interrupted or capped responses
  could leave records behind that cursor. A separate retained-history reconciliation
  runs on startup and browser resume, bypassing both board and runtime cursors.
- **Chat receive routing ignored the account's inbox preferences.** The PWA sent to
  advertised kind-10050 relays but received only from its default relays. It now reads
  from the latest verified account inbox list plus its existing default relays, so
  messages delivered to the iOS inbox and earlier PWA relays can both be recovered.
  Equal-time preference events use the lowest event ID consistently.
- **DM history was artificially limited.** The initial lookup used a 30-day cutoff,
  later lookups trusted a local sync time, and incoming messages truncated the entire
  local list to 400. Chat recovery now searches retained history without those cutoffs;
  the implicit 400-message cap is removed. Explicit user retention/deletion behavior
  remains in the existing DM state layer.
- **Sender copies require recipient lookup.** NIP-17 history is fetched through
  self-addressed gift wraps, including messages sent on iOS. Legacy kind-4 sent messages
  retain their author query. Alternate wraps of the same rumor share one chat entry.
- **Suspension/reconnection needs reconciliation.** Foreground, visibility, and online
  events restart recovery, coalescing simultaneous browser notifications. Old recovery
  work is cancelled and late subscription handles are released. A completed DM sync
  timestamp is recorded only when all requested pages finish successfully.

The shared `taskify-runtime-nostr` recovery helper reads each relay independently in
bounded pages, re-queries the inclusive timestamp boundary, and waits for EOSE instead
of treating a timer/inactivity return as completed history. Saturated timestamp pages
increase their requested limit; an exhausted known limit is reported as incomplete
instead of silently skipping that second. Earlier pages remain applied if a later
page fails. A subsequent foreground/reconnect retries from retained history.

Chat recovery is read-only with respect to wallet operations: recovered payment
messages may appear in chat, but this path does not invoke token redemption or payment
request handling. No wallet seed, balances, mint state, or event schemas were changed.

## Verification and limits

Regression tests cover asynchronous board completion (per-relay, aggregate EOSE,
and timeout), pagination beyond a relay cap, same-second boundaries, interrupted and
cancelled pages, signed inbox selection, recovery of old iOS sender copies despite a
recent local cursor, message retention beyond 400, rumor deduplication, and browser
resume. Run `npm test` in `taskify-runtime-nostr` and `taskify-pwa`, followed by PWA lint
and production build.

This cannot recover events that no available relay retains, messages never published
as sender copies, or unpublished iOS tasks. A relay that silently truncates even an
under-limit single-second result cannot establish completeness with ordinary Nostr
filters. Failed/incomplete recovery is logged and retried on the next resume; the
existing board spinner represents the initial live subscription, not a completeness
certificate for all recovery pages. Local tests do not prove actual account recovery;
a deployed PWA and an account/device check are still required.
