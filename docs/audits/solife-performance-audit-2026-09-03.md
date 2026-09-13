# Solife physical-device performance audit — September 3, 2026

## Scope and setup

Measured the real Solife iPhone 17 Pro running iOS 27.0 (24A5430a), connected over the local
network. The baseline was the installed Taskify 0.1 (37), process 28782. The user chose to
navigate on the phone; iPhone Mirroring was locked. CPU stacks show activity in Upcoming,
Boards, Contacts, Wallet, Settings, and an individual chat conversation. Exact per-tab dwell
times were not supplied, so these measurements describe the recorded sessions rather than
an equal-duration comparison of each tab.

Instruments recorded Time Profiler plus Activity Monitor. A preliminary resource-only capture
also succeeded. Initial device-wide attempts failed with a device-disconnected error and a
system-library symbol overlap; those recordings were excluded. Subsequent recordings attached
directly to Taskify and completed normally.

## Baseline findings

| Measurement | Five-minute navigation capture | Two-minute follow-up |
| --- | ---: | ---: |
| Sampled interval for resource deltas | 300.19 seconds | 120.31 seconds |
| CPU time consumed | 12.67 seconds | 6.13 seconds |
| Average CPU, relative to one core | 4.22% | 5.10% |
| Physical memory, start → end | 94.97 → 154.19 MiB | 139.47 → 135.00 MiB |
| Peak physical memory | 168.11 MiB | 141.81 MiB |
| Additional disk writes | 7.35 MiB | 0.14 MiB |

The first 3½ minutes of the longer capture were quiet: each 30-second segment consumed roughly
0.09–0.27 seconds of CPU and memory stayed around 95 MiB. Work increased during the final
minute, with UI rendering and event filtering visible in the stacks. The follow-up includes
chat rendering. Memory subsequently decreased; these sessions did not demonstrate continuing
memory growth. They are not an allocation/leak proof.

The five-minute capture reported **nominal thermal state throughout** and **zero detected hangs
at the configured 250 ms threshold**. This does not rule out shorter animation hitches or
warmth below the operating system's thermal thresholds. No sustained CPU saturation or
multi-gigabyte write amplification appeared in these captures.

## Confirmed hotspot and fix

`TaskifyEvent.isoDate(_:)` repeatedly constructed ISO-8601 formatters when Upcoming filtered
events and prepared event dates. It accounted for approximately **1.20 seconds of sampled CPU**
in the five-minute baseline, primarily on Upcoming's selected-day event filtering path.

The implementation now retains two formatters, for whole and fractional seconds, and serializes
access with a lock. The accepted timestamp formats and local date-only handling remain unchanged.
This avoids repeatedly constructing Foundation's date parsing machinery during rendering.

Validation:

- 34 focused calendar, Upcoming and shared-inbox tests passed, including offset/fractional
  timestamp equivalence and concurrent access to the shared parser.
- An optimized Mac benchmark parsed the same 10,000 timestamps with both implementations:
  2.744 seconds before versus 0.933 seconds after, approximately 2.94× faster for that operation.
  This is not a measurement of whole-app speedup or an iPhone speedup.
- The signed Local iOS/embedded Watch build succeeded and was installed over the existing app
  on Solife without clearing its data. It includes the preceding Nostr sync-audit fixes.

## Updated-device recording

The updated app was launched as process 28880. The post-install recording and results are
being collected; see the final results below when available.

## Evidence and limits

Raw recordings and exported counters/stacks are retained locally at
`/tmp/taskify-performance-audit-2026-09-03/`:

- `connection-check.trace`: approximately 30 seconds; low CPU, stable 95 MiB, no additional writes.
- `all-tabs.trace`: five-minute installed-build recording, 22:00:11–22:05:13 local time.
- `settling.trace`: two-minute installed-build follow-up.
- `updated.trace`: post-install validation.

These are local temporary artifacts and may be cleared by macOS. Trace files can contain
application metadata; they have not been uploaded or published. This audit did not send test
messages, make payments, or change user history. Opening conversations can follow the app's
normal read-state behavior. Watch cellular/Bluetooth performance, message-arrival latency,
long-duration battery drain, and detailed frame hitch rates were not established by this run.
