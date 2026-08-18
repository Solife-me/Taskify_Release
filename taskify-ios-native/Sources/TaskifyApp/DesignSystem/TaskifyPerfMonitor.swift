import SwiftUI
import QuartzCore

/// Live responsiveness counters, for diagnosing sluggishness on a real account.
///
/// The simulator cannot reproduce this app's actual load: its cost is driven by relay traffic
/// merging into `AppModel.snapshot`, and a local-only account produces none. So rather than
/// profile a synthetic dataset, this reports what is happening on device, in the moment, on the
/// account that is actually slow.
///
/// Entirely inert unless switched on — one `Bool` read, resolved once at launch. Enable with
/// the `TASKIFY_PERF=1` environment variable (Xcode scheme → Run → Arguments), or by passing
/// `-TaskifyPerf YES` as a launch argument.
///
/// What each number means:
/// - **hitch** — a frame that took longer than two display intervals. This is what "sluggish"
///   actually feels like. `worst` is the longest single stall since the last reset.
/// - **snap/s** — snapshot writes per second. Every one invalidates the lookup cache and bumps
///   the revision counter each view memoizes against, so a high idle rate means the UI is being
///   told to rebuild constantly by sync traffic rather than by anything the user did.
/// - **card** — task card body evaluations per second, the main render cost on a board.
@MainActor
final class TaskifyPerfMonitor {
    static let shared = TaskifyPerfMonitor()

    static let isEnabled: Bool = {
        if ProcessInfo.processInfo.environment["TASKIFY_PERF"] == "1" { return true }
        return UserDefaults.standard.bool(forKey: "TaskifyPerf")
    }()

    /// Set `TASKIFY_DISABLE_CARD_MATERIAL=1` to render task cards without the background blur
    /// added for photo-background readability, so the two can be compared on a real device.
    static let cardMaterialDisabled: Bool = {
        ProcessInfo.processInfo.environment["TASKIFY_DISABLE_CARD_MATERIAL"] == "1"
    }()

    private(set) var hitchCount = 0
    private(set) var worstFrameMilliseconds = 0.0
    private(set) var snapshotWritesPerSecond = 0.0
    private(set) var cardBodiesPerSecond = 0.0

    private var displayLink: CADisplayLink?
    private var lastFrameTimestamp: CFTimeInterval = 0
    private var windowStart: CFTimeInterval = 0
    private var snapshotWritesInWindow = 0
    private var cardBodiesInWindow = 0

    private init() {}

    func start() {
        guard Self.isEnabled, displayLink == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(step(_:)))
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    func reset() {
        hitchCount = 0
        worstFrameMilliseconds = 0
    }

    nonisolated func recordSnapshotWrite() {
        guard Self.isEnabled else { return }
        MainActor.assumeIsolated { snapshotWritesInWindow += 1 }
    }

    func recordCardBody() {
        guard Self.isEnabled else { return }
        cardBodiesInWindow += 1
    }

    @objc private func step(_ link: CADisplayLink) {
        defer { lastFrameTimestamp = link.timestamp }
        guard lastFrameTimestamp > 0 else {
            windowStart = link.timestamp
            return
        }

        // `targetTimestamp - timestamp` is the display's current interval, so this adapts to
        // ProMotion's variable refresh rate instead of assuming 60Hz.
        let interval = link.targetTimestamp - link.timestamp
        let elapsed = link.timestamp - lastFrameTimestamp
        if elapsed > interval * 2 {
            hitchCount += 1
            worstFrameMilliseconds = max(worstFrameMilliseconds, elapsed * 1000)
        }

        let windowElapsed = link.timestamp - windowStart
        guard windowElapsed >= 1 else { return }
        snapshotWritesPerSecond = Double(snapshotWritesInWindow) / windowElapsed
        cardBodiesPerSecond = Double(cardBodiesInWindow) / windowElapsed
        snapshotWritesInWindow = 0
        cardBodiesInWindow = 0
        windowStart = link.timestamp
    }
}

/// Small always-on-top readout of `TaskifyPerfMonitor`. Tap it to zero the hitch counters, so a
/// specific interaction can be measured in isolation.
struct TaskifyPerfOverlay: View {
    @State private var monitor = TaskifyPerfMonitor.shared
    @State private var tick = 0
    private let timer = Timer.publish(every: 0.5, on: .main, in: .common).autoconnect()

    var body: some View {
        if TaskifyPerfMonitor.isEnabled {
            VStack(alignment: .leading, spacing: 1) {
                Text("hitch \(monitor.hitchCount)  worst \(Int(monitor.worstFrameMilliseconds))ms")
                Text("snap/s \(monitor.snapshotWritesPerSecond, specifier: "%.1f")")
                Text("card/s \(monitor.cardBodiesPerSecond, specifier: "%.0f")")
                if TaskifyPerfMonitor.cardMaterialDisabled {
                    Text("material OFF")
                }
            }
            .font(.system(size: 10, weight: .semibold, design: .monospaced))
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .background(Color.black.opacity(0.72), in: RoundedRectangle(cornerRadius: 6))
            .opacity(tick >= 0 ? 1 : 1)
            .onReceive(timer) { _ in tick &+= 1 }
            .onTapGesture { monitor.reset() }
            .allowsHitTesting(true)
            .accessibilityHidden(true)
        }
    }
}
