# Solife → Taskify iOS ecash audit

Date: 2026-09-22. Investigation only; no wallet/server implementation changes.

## Finding and evidence limits

The code establishes the exact normal spend boundary: the mint accepts the
client's receive swap, invalidating the incoming proofs before Taskify persists
replacement proofs. It does **not** establish which actor spent the reported
payment. “Spent” alone does not prove theft or permanent loss.

Reviewed Taskify checkout HEAD `f92948fc`, its pinned CDK Swift 0.18.0 dependency,
local CDK/CDK-common/CDK-FFI 0.18.0 source under `/private/tmp`, and the sibling
`Solife_Landing_Page` working tree (HEAD `0f48157`, with existing modifications).
Neither checkout has been established as identical to the installed app/deployed
server. The available `/private/tmp/solife-audit.sqlite` has no payment/proof rows;
it is not incident evidence. No production tokens were redeemed or funds moved.

## Payment sequence and exact spend boundary

1. Solife checks the paid mint quote using the payment's stored `mint_url`.
   `Solife_Landing_Page/server/worker.ts:77`.
2. Solife calls `mintPaidQuote`, obtaining fresh bearer proofs, then inserts them
   into SQLite. `worker.ts:118`; `server/cashu.ts:60`.
3. Solife encodes those same proofs and wraps the token in a recipient-encrypted
   NIP-17 DM. Publication/status updates do not redeem them.
   `worker.ts:121`; `server/ecashDelivery.ts:8`.
4. Taskify processes the unsolicited token inbox through `submitReceive`, saving
   the original token in its pending JSON before attempting redemption.
   `WalletView.swift:1086`; `CashuWalletService.swift:2271`.
5. Taskify selects the mint **from the token**, creating its wallet if absent;
   its preferred mint is not substituted. `CashuWalletService.swift:2589`.
6. CDK prepares replacement outputs and persists the receive saga, counter range,
   blinded outputs, and pending transaction **before** `post_swap`.
   CDK `src/wallet/receive/saga/mod.rs:364`.
7. **Spend boundary:** mint-side acceptance of `post_swap` consumes the incoming
   proofs. CDK then reconstructs the returned proofs and writes them as Unspent
   to its local database. The request is at line 413; local proof update at 461.
   Response loss, process termination, reconstruction failure, or database failure
   in between can leave the DM token spent without a locally available balance.

CDK is designed to recover this interval by replay or NUT-09 restore. Taskify
invokes saga recovery on startup and activation. Therefore a post-swap failure
alone does not establish permanent loss; the recovery outcome must be examined.

## Confirmed receive/recovery weaknesses

### Taskify discards unresolved spent deliveries

`CashuWalletService.swift:2344` removes a pending token on a spent-classified
error without first recovering and correlating this token's receive saga.
`WalletView.swift:1138` marks the inbox delivery handled for every thrown error.
The original DM and CDK data may remain, but the app's normal pending-delivery
tracking ends. `receive` only retries counter-desynchronization errors.

The classifier also treats `duplicate inputs` as already spent
(`CashuWalletService.swift:3280`). Duplicated inputs in one request are not, by
themselves, proof of a previous successful redemption. This path can therefore
also misclassify a rejected token; incident proof state must be checked directly.

### CDK can complete recovery without recovering outputs

CDK `src/wallet/receive/saga/resume.rs:204` handles spent inputs by restoring
outputs. When restoration returns `None`, it removes the spent inputs, marks
the transaction Completed, and deletes the saga. It explicitly advises a full
wallet restore in its log. `src/wallet/recovery.rs:445` shows that an empty restore
response or certain definitive restore failures can reach an unavailable result.
This is a concrete route to completed-looking recovery with no replacement
balance. It is not evidence that the incident executed this branch.

Taskify additionally suppresses recovery exceptions (`try?`), and its snapshot
turns balance-query errors into zero (`CashuWalletService.swift:972`). A displayed
zero is consequently not proof that the database contains no money.

## Keyset rotation and seed recovery

| Path | Source finding | Consequence |
| --- | --- | --- |
| iOS receive of old proofs | CDK `wallet/keysets.rs:173` decodes with active and inactive keyset metadata; preparation loads their keys. | Inactive input keysets are supported, provided the mint supplies the required historical metadata/keys. |
| Rotation between output selection and swap | `receive/mod.rs:30` uses `retry_on_inactive_keyset`; `keysets.rs:104` refreshes and retries once if the selected active keyset changed. | Normal typed inactive-keyset rejection is handled. Unknown/nonstandard errors, repeated rotations, or refresh failure are not guaranteed to recover in that attempt. |
| Seed restore | `wallet/mod.rs:704` iterates available unit keysets, including inactive ones with loaded keys. | It is not intentionally active-keyset-only. Historical keys missing from a mint, or stale fallback metadata, can prevent complete restoration. |
| Historical key fetching | `mint_metadata_cache.rs:718` fetches and verifies uncached keys for each advertised keyset, propagating fetch errors. | A broken historical key endpoint can fail a fresh metadata load; this is not silent graceful rotation. |
| Server rotation | `server/cashu.ts:30` caches a Wallet and calls `loadMint` once. `mintPaidQuote` has no refresh/rebind/retry wrapper; installed cashu-ts `prepareMint` uses the bound keyset and `completeMint` posts once. | A long-lived server may keep using an inactive output keyset. This principally explains failed issuance/delivery, not a successfully delivered token later becoming spent. |

CDK's restore scan defaults to batches of 100, stopping after three empty batches
per keyset (`cdk-common wallet/mod.rs:423`). Taskify calls the default `restore()`;
it does not expose a larger scan range. A long counter gap can hide later proofs.

There is also a source-level counter concern: CDK restore calls
`increment_keyset_counter(keyset.id, highest + 1)` after scanning, although the
database interface defines this as an additive increment, not an assignment
(`cdk wallet/mod.rs:853`; `cdk-common database/wallet/mod.rs:115`, with additive
semantics asserted in `database/wallet/test/mod.rs:826`). Repeated restores into
an existing database can advance counters unnecessarily. Combined with the
bounded gap scan, this is a plausible recovery failure mechanism requiring a
runtime reproduction against the actual shipped library and incident counters.

Taskify's backup writes empty per-mint counter dictionaries, and the importer
extracts their mint names rather than importing counter values
(`CashuWalletService.swift:831,1384`). Recovery therefore relies on scanning.

Your failed seed restore does not distinguish theft from failed local recovery:

- Before Taskify swaps, the original Solife proofs were generated by Solife's
  unseeded cashu-ts wallet, not the Taskify mnemonic. Your mnemonic cannot
  reconstruct those original server-generated secrets.
- After a successful Taskify swap, deterministic replacement outputs should be
  recoverable using the matching seed, actual mint, keysets, and adequate scan
  range, if the mint retains/provides their signatures.
- If another client using the same Nostr identity redeems first with a different
  wallet seed, this iOS seed will not recover that client's replacement proofs.
- Taskify's recovery mint list is backup mints + manually supplied mints + current
  snapshot mints + Minibits (`WalletView.swift:1357,1461`). A removed Solife mint
  is not automatically rediscovered from a bare mnemonic.

## Preferred mint and disabled Solife mint

Selecting a wallet mint (`WalletView.swift:543`) changes local selection only.
Changing Solife routing is a separate API call (`WalletView.swift:485`). Existing
payments retain their stored mint URL on the server. Switching preference does
not convert outstanding Solife tokens into Minibits tokens.

The reviewed iOS receive path automatically creates the token's mint wallet,
even if it is absent from the current list. The wallet overview sums wallets;
it is not restricted to the selected mint. Removing a mint is refused when its
available/pending/reserved balances are nonzero (`CashuWalletService.swift:1073`).
If “turned off” means shutting down the actual mint service, redemption and
restore depend on bringing that mint's endpoints back; Minibits cannot redeem
another mint's signatures. The user's exact setting/action remains unconfirmed.

## Can an attacker redeem server-held tokens first?

**Yes, if they obtain the full unlocked proofs.** Solife stores `proof_secret`
and `proof_json` in its database and retains delivery/recovery records for about
30 days. Issuance specifies no recipient P2PK lock. The authenticated
`GET /api/me/payments` returns reconstructable recovery tokens scoped to the
session's public key (`routes.ts:501,1145,1199`). A stolen authorized session,
database copy, process compromise, or compromised plaintext server↔mint hop
could expose redeemable tokens. The mint URL validator permits HTTP as well as
HTTPS (`cashu.ts:122`); actual production transport has not been verified.

A passive relay observer sees an encrypted NIP-17 event; the reviewed path does
not publish the token in plaintext. An attacker needs a way to obtain the
plaintext proofs or compromise relevant keys/endpoints. No unauthenticated token
endpoint or actual interception was demonstrated in this audit. Possession of
the recipient Nostr key also permits another legitimate wallet to read/redeem
the DM, which can look identical to theft from this device's perspective.

P2PK locking would change who can redeem copied proofs; it is a potential future
design hardening, not evidence of the cause of this payment's failure.

## Separate server loss window

Solife calls `mintProofsBolt11` before persisting returned proofs. Its wallet has
no configured deterministic seed or durable prepared-output journal. A mint
issuance followed by a lost response/process failure can leave an issued quote
without stored proofs; the worker explicitly records `issued_missing_proofs`
(`worker.ts:78`). This is a server-side loss window, but it occurs before DM
construction and therefore does not explain the same payment having a valid
token already delivered in a DM.

## Validation and evidence still needed

- Existing Solife worker tests: **2 passed**. The relevant delivery test checks
  storage and recipient decryption using a mocked mint/token. It does not test
  actual mint spending, keyset rotation, or crash recovery.
- `swift test --skip-update --filter CashuWalletTests`: failed before tests ran.
  Local CDK framework headers disagreed with the cached precompiled module
  (210767 vs 241536 bytes), with additional missing FFI types. No iOS test pass
  or live failure reproduction is claimed.
- No live swap, melt, restore, or mint request was issued during this audit.

To determine the incident's precise cause, correlate the payment time/amount,
address, DM event ID, deployed versions, stored mint URL and proof identifiers
with the original device's CDK receive transaction/saga and mint request records.
Inspect copies read-only before any recovery operation that mutates local state.

The decisive evidence is whether the spent input proofs were accepted with
Taskify's recorded blinded outputs. If matching signatures exist, the fault is
in receiving/persisting/recovering those outputs. If those proofs were spent
before this client's request, investigate other clients and server/session
exposure. Standard spent-state queries alone do not identify the redeemer or
their destination outputs, so mint-side request evidence may be necessary.

Protocol references checked: [NUT-02 keysets](https://github.com/cashubtc/nuts/blob/main/02.md),
[NUT-13 deterministic recovery](https://github.com/cashubtc/nuts/blob/main/13.md),
[NUT-11 P2PK](https://github.com/cashubtc/nuts/blob/main/11.md).
