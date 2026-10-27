# Runtime security review — 2026-10-22

## Scope

This review checked the Taskify push relay first, followed by every JavaScript package in the repository, against the eMudhra intermediate-CA compromise, the 2026-10-21 Node.js security release, and the 2026-10-21 PHP security release.

## Findings and remediation

| Area | Finding | Remediation |
|---|---|---|
| Push relay container | The floating `node:22-alpine` base could leave an already-built deployment on a Node release affected by the October Node vulnerabilities and the compromised eMudhra CA trust. The relay makes authenticated outbound TLS connections to APNs, FCM, Web Push services, and Nostr relays, so the TLS and CA fixes apply directly. | Both image stages now use `node:22.23.4-alpine3.24`, the first fixed Node 22 release. The package engine requires `>=22.23.4 <23`. Rebuild and redeploy the image; changing source does not patch a running container. |
| Other Node tooling | CI and package engine floors allowed older Node 22 releases. | CI is pinned to `22.23.4`; the Worker, CLI, PWA, core, and Nostr runtime package floors now require the fixed Node 22 line. |
| PWA dependencies | `markdown-it` 15.0.2 had quadratic-time denial-of-service advisories. Mammoth's CLI-only dependency path retained vulnerable `sprintf-js` through `argparse` 1.x, although the PWA imports Mammoth's prebuilt browser entry. | Updated `markdown-it` to 15.0.3 and overrode Mammoth's unused CLI parser to `argparse` 2.0.1. Production and full-tree npm audits are now clean. |
| PHP | No PHP runtime, Composer manifest/lockfile, PHP container, or application PHP source exists in this repository. | The PHP RCEs CVE-2026-109618 and CVE-2026-109619 are not applicable. No PHP patch was added. |
| Cloudflare Worker | Production runs on the Cloudflare Workers runtime, not the repository's local Node executable. | No runtime image change is available or required here. Its local/CI Node floor and dependency audit were still updated and checked. |

The fixed Node runtime also covers CVE-2026-105482, CVE-2026-106069, CVE-2026-111497, CVE-2026-105481, CVE-2026-106072, CVE-2026-106074, and CVE-2026-106073, plus the release's c-ares, CA, OpenSSL, SQLite, and Undici updates.

## Verification

- Push relay: 102/102 tests pass; TypeScript check passes; StartOS JavaScript bundle builds.
- Push relay container: clean build; runtime reports Node `v22.23.4`; production npm audit reports zero vulnerabilities.
- Worker: TypeScript check and 86/86 tests pass; production npm audit reports zero vulnerabilities.
- Core and Nostr runtime: test suites pass; production npm audits report zero vulnerabilities.
- CLI: test suite passes; production npm audit reports zero vulnerabilities.
- PWA: lint, TypeScript, production build, startup budget, and focused sanitization tests pass; npm audit reports zero vulnerabilities.
- The full PWA suite reported 745 passing, 14 skipped, and one failing task-postponement assertion in `src/domains/tasks/taskCommands.test.ts`. That failure is outside the dependency/runtime changes in this review and remains visible for separate repair.

## Deployment requirement

Rebuild and redeploy the push-relay/StartOS package so the running process actually moves to Node 22.23.4. Existing images built from the former floating tag remain vulnerable until replaced.

## Follow-up — 2026-10-26

Committed on 2026-10-26, when `npm audit` was run again across every package.

- The PWA test failure noted above (`taskCommands.test.ts`) was a clock dependency in the test, fixed in `b73ad92d`.
- **New since 2026-10-22 and fixed:**
  - **PWA:** DOMPurify ≤ 3.4.16 (critical: a `SAFE_FOR_TEMPLATES` shadow-root bypass, `IN_PLACE` hook handlers left armed, and an SMIL `href` guard skipped under XHTML). `src/lib/sanitize.ts` uses it on HTML that can come from other people. Now 3.4.17.
  - **PWA, dev tools only:** undici 7.30.1 (via jsdom) and zod 4.6.7 (via `eslint-plugin-react-hooks`).
  - **Worker:** undici 8.12.3 (via `link-preview-js`), for an EventSource memory denial of service, a Subresource Integrity bypass and a content-encoding crash.
- **Verification:**
  - production and full npm audits are clean for the PWA, Worker, CLI, core and Nostr runtime;
  - PWA `tsc -b`, lint, 747 tests, production build and startup budget pass;
  - Worker TypeScript and 86/86 tests pass.
- **Open:** the push relay's dev dependency `@start9labs/start-sdk` carries a zod memory-exhaustion advisory, fixed in SDK 3.1.0. The relay's production audit is clean. The SDK bump changes the StartOS package and needs a pack-and-install check, so it is left to the Chunk 13 review of the relay.
