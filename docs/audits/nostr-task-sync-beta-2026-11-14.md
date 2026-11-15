# Beta Nostr task sync audit — November 14, 2026

Base commit `6323f956` on `Beta`. This pass traces task changes from the local store through
signing, relay routing, delivery and retries, then back through board discovery, historical
replay, live updates, version selection and persistence. It covers the PWA on desktop and
mobile (including Android), the native iPhone and Mac clients, the Watch’s phone handoff and
independent HTTPS path, and the CLI. It includes the shared Nostr runtime, account-backup
board discovery and the Watch relay/gateway boundary. The browser extension was outside scope.

## Fixed

| Client | Failure | Change |
| --- | --- | --- |
| iPhone and Mac | The native live request can reach EOSE after a relay returns only its newest page. The live cursor then advances, leaving older tasks missing on a fresh device. Looking up open tasks can only repair records this device already knows about. | Reconcile retained task history independently of the live cursor on the existing authenticated socket. Page per board, re-read inclusive timestamp boundaries, and record a per-relay, per-board checkpoint only after the pass completes. Retry incomplete coverage on reconnect or foreground. |
| PWA | A saved deletion lost its event ID on reload. An older same-second task could reappear. The live merge could also delete a newer saved task before the in-memory ledger had seen it. | Keep signed tombstone versions across reloads, seed the ledger from saved task versions and apply the same signed version order to batch and live merges. Existing timestamp-only tombstones still load. A winning live task clears its earlier tombstone. |
| CLI | Cold, refresh and compound-board reads could stop at a relay’s cap. Refresh could replace a cached deletion with an older live copy, and compound boards bypassed the per-board cache. | Use the shared per-relay history pager and a common cache merge for direct and compound reads. Preserve newer cached revisions on normal refresh. An interrupted read keeps its previous checkpoint, and a relay-set change forces a full retained-history pass. |
| Watch and iPhone handoff | Watch snapshots and queued task commands lacked an account label. An independent refresh could also finish after a newer phone snapshot or account replacement and overwrite it. | Carry the account on new paired-device snapshots and commands. Retain the prior account’s queued commands under their original key and reject mismatched deliveries. Drop relay results when the account or underlying task snapshot changes while a request or decode is in flight. Older transfer data remains decodable. |

Same-second task conflicts use the relay’s replaceable-event ordering (later timestamp, then
lower signed event ID). The Watch account label is part of the local WatchConnectivity transfer.
The task events published to Nostr keep their existing format.
[NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)

## November 15 follow-up

**PWA account storage.** The first Nostr identity on an upgraded browser claims the existing
IndexedDB database and local preferences in place. Existing task rows, boards, deletion markers,
and pending publications stay where they are. Additional identities use their own IndexedDB
database and preference namespace. The tab flushes writes and reloads when switching, so a callback
from the previous account stays pinned to its original store. If a backup belongs to a different
identity, Taskify encrypts and stages it in that account’s database, then imports missing records
after reload while preserving existing records. The browser’s wrapping key remains device-wide.

**Independent Watch history.** The Watch requests signed pages for each board and relay, plus
separate pages for its gateway’s cache. It keeps a checkpoint with the cached task projection,
retries unfinished sources, and persists the signed winning versions of completed and deleted
tasks. A timed-out relay request leaves its checkpoint open. A truncated phone projection retains
tasks the Watch recovered for boards still present on the phone.

## Remaining risks

1. **Watch history rollout.** Independent pagination requires the updated gateway or the
   updated Worker fallback. Older services continue to provide their recent snapshot.
2. **Medium — Same-second convergence still varies for metadata.** Board definitions and
   calendar merges on some clients compare timestamps without a persisted winning event ID.
   Extend the task version contract to these records and add mixed-client replay fixtures.
3. **Medium — A relay can hide gaps independently of the client.** Recovery can walk retained
   pages and preserve unfinished checkpoints. Relays that silently cap below the requested
   limit inside a single second, or that have pruned an event, can still leave gaps. An edit
   replicated late with an older timestamp can also fall outside a normal resume window.
   Add a periodic repair and a visible per-relay coverage indicator.
4. **Medium — Mixed-version Watch handoff.** Transfers from older builds can omit the account
   label. They still work on a paired device. New labels are enforced when present, so fully
   enforcing account matching depends on upgrading both ends.

## Release verification

Exercise a fresh login and an existing device against a test account with several boards, a
shared board under a second account, and enough task history to exceed a relay page. Create,
edit, complete, reopen and delete tasks while clients alternate between online and offline.
Disconnect one relay during replay, then restore it and confirm tasks and deletions converge
after restart. Repeat Watch reads and writes with the phone disconnected and switch the
paired account while a command is pending.
