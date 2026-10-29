# Taskify checklist execution plan

Status: active
Created: 2026-10-29
Source: Taskify to-do checklist supplied 2026-10-29
Baseline: `Beta` at `e8eaca27`

This is the living tracker for the Taskify checklist. At the start or end of every iteration, update the status table, evidence log, commit hash, and any discovered constraints. Another agent must be able to resume from this file without reconstructing decisions from chat history.

## Scope decisions

- **Chat polls are out of scope.** The user explicitly removed this item.
- **One responsive PWA, not two.** Desktop, tablet, and touch layouts share one service worker, release, routes, identity, and data model.
- **Native parity is required where the behavior applies.** PWA-specific presentation work stays in the PWA; shared privacy, attachment, and chat behavior must have matching native behavior.
- **Bot menus run only in conversations with a verified Taskify bot.** Ordinary chat keeps normal Markdown rendering.
- **Hermes will not be modified.** Taskify must adapt to the Telegram/text responses Hermes already emits.
- **Fast, refreshable provider catalog flow.** The `/model` text response supplies provider names, slugs, counts, and five preview models. Tapping a provider sends the tested one-provider JSON catalog prompt, then replaces the same interactive card with the complete model list. Cache results per bot and provider with a 10-minute TTL. Serve a cached list immediately, revalidate stale entries in the background, expose a manual Refresh action, and mark cached catalogs stale whenever a new `/model` response arrives so newly added models can appear.
- **File names are private metadata.** File hosts and public URLs must not reveal original file names. Original names may travel only inside already-encrypted task or NIP-17 payloads.
- **One or more commits per iteration.** Each commit must be logically distinct, buildable, and limited to the files for that step. Update this file in the same commit or immediately after the implementation commit with its hash and verification evidence.

## Repository state and branch policy

- The documented `New_Features_Fixes` branch does not currently exist on `origin`.
- Until that branch is created or restored, use a short-lived branch based on the current `Beta` integration tip for each iteration. Never commit directly to `main`.
- The current checkout has uncommitted CLI/runtime rate-limit work plus unrelated in-progress macOS and iOS changes. Preserve all of it.
- Stage only files belonging to the active iteration. Never use a broad `git add .` in the current dirty checkout.
- Shared TypeScript packages commit regenerated `dist/` output with source changes.
- Update relevant docs whenever behavior changes, following `AGENT.md`.

## Definition of done

An iteration is complete only when:

- The requested behavior works on every platform explicitly listed for that iteration.
- A regression test exists first for reported bugs; feature tests cover core rules and failure paths.
- Relevant tests, lint, type checks, and builds pass locally.
- Visual or device-specific work has been checked with the best available browser/simulator evidence.
- Documentation and this tracker are updated.
- The work is committed as a focused change with its hash recorded below.
- Known limitations are recorded rather than hidden.

User testing is valuable but is not a prerequisite for marking work complete.

## Status

| Iteration | Item | Status | Commit | Verification |
|---|---|---|---|---|
| 1 | Create and commit this living plan | Complete | `6a864fa2` | plan reviewed |
| 2 | Finish and commit CLI relay rate-limit work | Complete | `a5ef6b1a` | 91 runtime tests + 225 CLI tests |
| 3 | Keep attachment file names private on every upload path | Complete | `ea845460` | cross-client tests + iOS/Watch build |
| 4 | Stop PWA task editing from waiting for relay publication | Complete | `4917b490` | PWA 768 passed/14 skipped; lint; build; startup 420.2/440 KB; relay failures stay queued |
| 5 | Show attachment download progress across clients | Complete | `798dffe3` | PWA 770/14 skipped; lint/build/startup 420.7 KB; Swift 5/5; iOS/Watch/share/Mac builds |
| 6 | Add shared Hermes bot-menu parser | Complete | `c1c56eeb` | core 182/182; TypeScript + standalone Swift fixture parity |
| 7 | Add interactive bot model picker to PWA | Not started | - | PWA tests + browser check |
| 8 | Add interactive bot model picker to iOS/macOS | Not started | - | Swift tests + simulator |
| 9 | Paste clipboard photos into iOS task notes as attachments | Not started | - | paste UI test |
| 10 | Capture multiple chat photos in one iOS camera session | Not started | - | camera model + simulator |
| 11 | Make every PWA settings group collapsible | Not started | - | PWA tests + visual check |
| 12 | Remove PWA AI instruction block | Not started | - | tests + grep |
| 13 | Prevent task content from scrolling sideways inside lists | Not started | - | browser width tests |
| 14 | Add adaptive Mac-like PWA desktop layout for wide touch screens | Not started | - | Mac/iPad screenshots |
| 15 | Print whole board or selected lists, respecting completed settings | Not started | - | layout tests |
| 16 | Refactor print/scan format and make scan round-trip reliable | Not started | - | synthetic scan tests |
| 17 | Add scan result verification before completing tasks | Not started | - | verification UI tests |
| - | Chat polls | Out of scope | - | user decision |

Status values: `Not started`, `In progress`, `Blocked`, `Complete`.

## Iteration protocol

1. Read this file and run `git status --short --branch`.
2. Mark the active row `In progress` and create a focused branch from the current integration tip.
3. Reproduce a reported bug with a failing test or a documented manual reproduction before fixing it.
4. Implement the smallest complete change.
5. Run the iteration's verification commands and any affected package-wide gates.
6. Inspect the final diff for unrelated files or secrets.
7. Update the row, evidence log, residual limitations, and docs.
8. Commit only the focused change. Record the commit hash in this file.

## Iteration details

### 1. Living plan

- Add this file to `docs/plans/`.
- Link it from `docs/README.md` if appropriate.
- Commit only plan/documentation files.

### 2. CLI relay rate limiting

Current state: implementation is already uncommitted in the working tree. Treat it as the basis for this item, not as new work to rewrite.

- Review `taskify-runtime-nostr/src/RelayPublishBudget.ts`, `PublishCoordinator.ts`, `RelayAccess.ts`, and `StandaloneSession.ts` for cross-process lease and release correctness.
- Review `taskify-cli/src/shared/nodeRuntimeSession.ts` and `shareTransport.ts` for persisted pacing, one-off publishers, proof-of-work retries, and lock cleanup.
- Confirm runtime source and committed `dist/` output agree.
- Check for deadlocks, stale in-flight leases, concurrent CLI processes, malformed budget files, rate-limit rejection classification, and clean process exit.
- Do not include unrelated iOS, macOS, or board presentation changes in the commit.

Verification:

```sh
cd taskify-runtime-nostr && npm test
cd ../taskify-cli && npm test
```

Also exercise two concurrent CLI-style budget instances against the same temp budget file. Confirm a paced relay receives one event immediately, the second waits, and a rate-limit response creates persisted backoff.

Acceptance: the existing WIP is complete, documented, tested, and committed without touching unrelated changes.

### 3. Attachment file-name privacy

Threat model: an observer of the file host, upload request, or returned URL must not learn the original name or extension. Recipients still see the original name after decryption.

Known state:

- PWA chat uploads already use an opaque ciphertext hash plus `.bin`; PWA task uploads still pass the original filename.
- Native chat uploads already use an opaque hash plus `.bin`; native task uploads still pass the original name.
- CLI shared-board attachments upload as `<original-name>.bin`.
- Audit the share extension and every provider multipart/path variant for metadata leaks.

Implementation:

- Add one shared opaque-upload filename rule where protocol-neutral helpers can own it; otherwise mirror it with shared fixtures.
- Upload task and chat ciphertext as an opaque hash-based name and `application/octet-stream`.
- Keep the original file name only in the encrypted task payload or encrypted NIP-17 rumor.
- Ensure URL paths, multipart fields, `Content-Disposition`, NIP-98 payload hashes, and provider compatibility do not require the original extension.
- Preserve downloads and local display by using the decrypted metadata name, not the remote URL.
- Keep legacy attachments readable.

Verification:

- PWA attachment unit/integration tests assert the upload name contains only the ciphertext hash and `.bin`.
- TaskifyCore/Swift tests assert native task and chat uploads use opaque names.
- CLI tests assert Originless, Blossom, and NIP-96 task attachments never send the original name.
- Run affected `taskify-pwa`, `taskify-core`, `taskify-cli`, and iOS test suites.
- Document the privacy invariant and compatibility behavior.

### 4. PWA editor publication backpressure

Problem: saving/editing a task waits for relay publication and can leave the editor busy for a long time when the durable queue is large.

- Trace the PWA save path from `EditModal` through `App.tsx` and the durable publisher.
- Split durable enqueue from network drain. The editor may close once the local state and signed durable outbox record are safely committed.
- Continue publishing in the background with existing coalescing, idempotency, retry, and stale-edit protections.
- Show a compact queued/syncing indicator without blocking the editor.
- Preserve failures: a failed network publish remains queued and retryable; a failed local enqueue keeps the editor open and explains the error.
- Cover large queues, offline mode, superseded edits, and app teardown after enqueue.

Verification: focused Vitest cases prove the save promise resolves after enqueue, not relay acknowledgement; lint, build, and startup budget still pass.

### 5. Attachment download progress

Goal: an unobtrusive determinate percentage when response length is known, with an indeterminate fallback when it is not.

- Audit PWA task images/documents, PWA chat attachments, iOS task attachments, iOS chat attachments, and macOS surfaces sharing those services.
- Use streamed response-body reads for PWA progress so percentage updates before the full body arrives.
- Keep native file-based/bounded-memory download paths; expose their existing byte counts to UI.
- Show progress in the affected task or chat bubble and during explicit downloads.
- Preserve cancellation, retry, authentication failure, hash/GCM verification, and object-URL cleanup.
- Do not publish unauthenticated plaintext.

Verification: local HTTP fixtures cover known length, unknown length, oversize, cancellation, HTTP error, hash mismatch, and retry. Run PWA tests and focused Swift tests. Manually inspect progress on a large local fixture.

### 6. Shared Hermes bot-menu parser

Hermes cannot emit new structured metadata. Build a strict parser and state model that consumes its existing output.

Inputs already verified:

- `/model` text fallback with provider sections, slugs, counts, current marker, and up to five preview models.
- One-provider JSON catalog response in the form `{"provider":"custom:local","models":["..."]}`.
- Model switch confirmation text from `/model <model> --provider <slug>`.
- Telegram uses 10 providers per page and 8 models per page.

Implementation:

- Add a versioned bot-menu contract/parser in `taskify-core` for provider listings, provider catalogs, model actions, pagination, and confirmations.
- Require a verified bot command list and a recognized Hermes response shape; never activate on ordinary Markdown.
- Validate all slugs and model IDs; only exact parsed values may be sent as commands.
- Include shared JSON fixtures consumed by TypeScript and Swift.
- Define UI state: provider page, selected provider, catalog loading, model page, confirmation, error, expired, cancelled.
- Keep a readable text fallback when parsing or catalog loading fails.

Verification: `taskify-core` tests and corresponding Swift vector tests cover preview listings, full provider catalogs, malformed JSON, duplicate models, pagination, current markers, confirmation, and injection-shaped values.

### 7. PWA interactive Hermes model picker

- Render the parsed menu beneath the triggering `/model` bot response as one interactive card.
- Provider buttons include labels and model counts; mark the current provider.
- On provider tap, render any cached provider catalog immediately. If the entry is missing or stale, show in-card refresh status, send the verified one-provider catalog request, parse the JSON result, and replace the list when fresh data arrives. A manual Refresh action performs the same request even when the cache is fresh. Marking a new `/model` response stale invalidates provider catalogs for that bot.
- Paginate models at eight per page. Provider pagination may use ten per page.
- Model tap sends `/model <model-id> --provider <slug>`.
- Mark Taskify-generated catalog and model commands with encrypted custom rumor tags so clients can distinguish them from user-authored chat.
- Suppress the technical catalog request/JSON response and model command/confirmation from the visible thread when successfully paired; replace the original card with the compact confirmation.
- Keep raw text visible if pairing or parsing fails.
- Add Back, Cancel, retry, and stale/expired states.
- Scope the behavior to verified bot DMs.
- Ensure keyboard, screen-reader, focus, and 44px touch target behavior.

Verification: Vitest coverage for parsing integration/state transitions, command generation, failure fallback, fresh-cache reuse, stale-cache revalidation, manual refresh, catalog changes, and one-visible-card behavior. Perform a browser check with recorded Hermes fixtures and a live Hermes run.

### 8. Native interactive Hermes model picker

- Port the shared menu state to `TaskifyCore` and render it in iOS chat.
- Match Hermes behavior in the macOS chat view where the shared native chat surface applies.
- Preserve PWA wire compatibility for custom menu markers and generated commands.
- Keep the raw text fallback on Watch or any surface without the full picker.
- Mirror the PWA's 10-minute provider catalog cache, stale-while-revalidate behavior, invalidation after a new `/model` listing, and manual Refresh action.

Verification: focused `TaskifyCoreTests`, native UI tests using synthetic Hermes messages, unsigned simulator build, and a live Hermes DM on iOS. Confirm the same menu is reconstructed after reload and from the encrypted message history.

### 9. iOS clipboard photo to task notes

Desired behavior: pasting an image while editing task notes attaches it exactly as the task editor's attach button would. The photo must not need to be saved to Photos.

- Reuse the editor's existing file import, encryption, upload, progress, and attachment save paths.
- Detect image/file paste providers in the notes editor without breaking normal text paste.
- Add the staged attachment immediately, show progress and a removable preview, and include it when the task is saved.
- Avoid duplicate import when UIKit offers multiple representations of the same image.
- Preserve cancellation and editor-dismissal behavior.

Verification: a UI test sets `UIPasteboard.general.image` and confirms the task gains one encrypted attachment; unit tests cover mixed text/image paste and duplicate representations.

### 10. Multiple chat photos in one camera session

Desired behavior: open the camera once, take several photos, review the staged thumbnails, then return the whole batch to the existing chat attachment composer.

- Replace the single-shot picker path for chat with a multi-capture camera session.
- Keep the session open after each shutter press; show a thumbnail strip and count.
- Provide Done, Retake/remove, cancel, flash/camera switching where available, and a hard cap matching the existing ten-attachment batch limit.
- Stage every accepted photo through the existing protected temporary-file and upload pipeline only after the user chooses Send.
- Keep Photos picker, Files, paste, and document scan behavior unchanged.
- Handle denial, interruption, rotation, low storage, and simulator fallback.

Verification: extract testable selection logic into a small model with unit tests; add simulator UI coverage for staged thumbnails and cancellation; build on iPhone with camera permission.

### 11. PWA collapsible settings groups

- Introduce one shared PWA accordion component matching iOS settings groups.
- Wrap Boards, View, Chat, Bible, Notifications, Nostr & Sync, Backup, storage/file servers, support, and other top-level groups.
- All groups start collapsed whenever the settings page mounts.
- Expansion state resets on page refresh and does not persist across sessions.
- Preserve `aria-expanded`, keyboard activation, focus visibility, and touch-sized headers.
- Do not change individual settings behavior.

Verification: Vitest asserts every group begins collapsed, one group expands without affecting another, and remount resets state. Capture a visual check on phone and wide desktop.

### 12. Remove PWA AI instructions

- Delete the “AI prompts” section from PWA Settings.
- Remove its prompt builder, copy handler, imports, and styles that become unused.
- Keep the separate task/event JSON paste/import behavior unless a dependency is proven.
- Search for stale help text that still directs users to the removed block.

Verification: tests, lint, production build, and repository search show no dead AI-instructions UI/code.

### 13. PWA task/list horizontal overflow

Desired behavior: only the board scroller scrolls horizontally between lists. A task card and its children must stay within the list width.

- Reproduce with a 325px list and long title, unbroken text, Markdown/code-like notes, long subtasks, document names, URL previews, and attachment chips.
- Measure `scrollWidth` versus `clientWidth` for cards, their content column, and list scroll container.
- Repair intrinsic sizing with `min-width: 0`, `max-width: 100%`, wrapping/breaking rules, and contained media without merely hiding important content.
- Keep drag, selection, action buttons, and multiline rounded-card behavior intact.
- Add a browser-based regression check that asserts card content never exceeds its column; use CUA/browser tooling if no Playwright setup is added.
- Confirm mouse wheel, trackpad, touch, edge arrows, and keyboard navigation still move between lists.

Verification: phone, iPad landscape, and Mac-browser screenshots at multiple widths, plus automated `scrollWidth` assertions.

### 14. Adaptive Mac-like PWA layout for wide touch screens

Architecture decision: one PWA.

- Separate layout selection from input capability. Wide screens receive the Mac-like rail and content arrangement even when touch is present.
- Keep hover/fine-pointer rules for mouse-only enhancements such as hover styling and wheel-assisted board scrolling.
- Preserve coarse-pointer hit areas and touch gestures inside the wide layout.
- Align the PWA shell with the native macOS information architecture where practical without copying AppKit-only controls.
- Check landscape iPad, portrait iPad, Mac at default and narrow widths, browser zoom, and split view.
- Do not change data, routing, or service-worker scope.

Verification: screenshots at representative Mac and iPad sizes, touch interaction checks, no overlap/clipping, PWA tests/lint/build/startup budget.

### 15. Print whole board or selected lists

Existing PWA print supports whole board and selected individual tasks. Add list scope.

- Keep the existing print entry point but open a scope chooser before preview.
- Offer whole board and multi-select list/day columns using the same board structure shown on screen.
- For compound boards, expose source child-board list columns without duplicates.
- Include completed tasks only when the board's `show completed` setting is enabled.
- Persist sufficient print-job metadata for later scanning, including board identity, scope labels, task IDs, layout version, and print time.
- Keep paper/scan marker compatibility and PDF/print output consistent.

Verification: unit tests for week, list, compound, filtered, and completed-task cases; preview snapshots for selected lists; manual PDF inspection.

### 16. Reliable, versioned print/scan round trip

The user reports the current scan-compatible format may not work and is not cross-client compatible. Treat the current format as untrusted.

- Reproduce failures with synthetic rendered pages, camera-like transforms, rotation, perspective, blur, and threshold changes.
- Define a versioned print payload in `taskify-core` with shared fixtures so every consumer agrees on page IDs, task IDs, scope, and layout version.
- Make task identity machine-stable across clients; do not rely on display order alone.
- Version the layout and scanner together. Keep old print jobs readable only if they can be validated safely.
- Test multiple pages, list headers, dense tasks, filled/unfilled circles, stray marks, and wrong board/version.
- Document the paper wire contract and compatibility promise.

Verification: synthetic image round-trip tests generated from actual print layout, plus manual phone-camera scans of at least one-letter and A6 pages. Do not apply any result until iteration 17 is in place.

### 17. Scan verification before completion

- After scanning, show a verification screen listing each detected task with title, list, current state, and detected completion mark.
- Allow selecting or deselecting every proposed change and scanning additional pages into the same review.
- Do not include unknown IDs, wrong-board jobs, already-completed tasks, or ambiguous pages in the default apply set.
- Apply only user-confirmed task IDs through the existing task completion command path, preserving recurrence, sync, and undo behavior.
- Handle partial publication exactly like normal completion: local state and durable outbox first, relay recovery later.
- Show a result summary and retain a clear cancel path.

Verification: tests for confirmation/deselection, wrong page, duplicate task IDs, recurrence, offline apply, and partial sync; manual end-to-end print-fill-scan-confirm flow.

## Evidence log

| Date | Iteration | Branch | Commit | Verification | Notes |
|---|---|---|---|---|---|
| 2026-10-29 | 1 | Beta | `6a864fa2` | Checklist and repository reviewed | Living plan created |
| 2026-10-29 | 2 | `codex/checklist-iterations-2-4` | `a5ef6b1a` | `taskify-runtime-nostr`: 91/91; `taskify-cli`: 225/225 | Finished existing WIP; committed only CLI/runtime rate-limit files and regenerated runtime dist |
| 2026-10-29 | 3 | `codex/checklist-iterations-2-4` | `ea845460` | core 175/175; PWA 765 passed/14 skipped; CLI 226/226; PWA lint; Swift filename tests 3/3; unsigned iOS app + Watch + share extension build | Shared opaque filename rule; original names remain only in encrypted metadata; legacy URLs unchanged |
| 2026-10-29 | 4 | `codex/checklist-iterations-2-4` | `4917b490` | PWA 768 passed/14 skipped; lint; production build; startup 420.2 KB gz of 440 KB budget | Added non-blocking durable queue path; editor now closes after local intent acceptance and relay failures remain queued |
| 2026-10-29 | 5 | `codex/checklist-iterations-5-9` | `798dffe3` | PWA 770 passed/14 skipped; lint; build; startup 420.7 KB; Swift 5/5; unsigned iOS app/Watch/share extension and Mac app builds | Streamed body progress in PWA; native URLSession byte progress in chat/task attachments; indeterminate fallback when length is unknown |
| 2026-10-29 | 6 | `codex/checklist-iterations-5-9` | `c1c56eeb` | core 182/182; TypeScript and Swift consumed the same Hermes listing/catalog/confirmation vectors; Swift parser executable passed | Added strict provider/model parsing, page sizes, confirmation parsing, and encrypted bot-UI action tags |

## Handoff checklist

Before ending an iteration, record:

- what changed;
- commands run and their result;
- any manual visual/device checks;
- unresolved risks or follow-up work;
- the exact commit hash;
- whether the next iteration is safe to start.
