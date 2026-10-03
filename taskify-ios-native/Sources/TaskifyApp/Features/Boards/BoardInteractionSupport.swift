import CoreImage
import CoreImage.CIFilterBuiltins
import CoreTransferable
import SwiftUI
import TaskifyCore
import UIKit
import UniformTypeIdentifiers


extension UTType {
    static let taskifyTask = UTType(exportedAs: "me.solife.taskify.task")
}

struct TaskDragPayload: Codable, Hashable, Transferable {
    let taskID: String

    static var transferRepresentation: some TransferRepresentation {
        CodableRepresentation(contentType: .taskifyTask)
    }
}

enum TaskDropTargetStyle: Equatable {
    case card
    case column
}

struct BoardQuickAddDestination: Equatable {
    let boardID: String
    let columnID: String
    let displayName: String
    let weekday: WeekdayColumn?
}

struct TaskDropTargetModifier: ViewModifier {
    @Environment(AppModel.self) private var model
    let boardID: String
    let columnID: String
    let beforeTaskID: String?
    let style: TaskDropTargetStyle
    @State private var isTargeted = false

    func body(content: Content) -> some View {
        content
            .dropDestination(for: TaskDragPayload.self) { payloads, _ in
                guard let payload = payloads.first else { return false }
                if beforeTaskID == payload.taskID { return true }
                return model.moveTask(
                    payload.taskID,
                    toBoardID: boardID,
                    columnID: columnID,
                    beforeTaskID: beforeTaskID
                )
            } isTargeted: { targeted in
                withAnimation(.easeOut(duration: 0.14)) {
                    isTargeted = targeted
                }
            }
            .overlay(alignment: style == .card ? .top : .center) {
                if isTargeted {
                    switch style {
                    case .card:
                        Capsule()
                            .fill(TaskifyTheme.accent)
                            .frame(height: 4)
                            .padding(.horizontal, 10)
                            .offset(y: -5)
                            .allowsHitTesting(false)
                    case .column:
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .stroke(TaskifyTheme.accent, lineWidth: 2)
                            .padding(2)
                            .allowsHitTesting(false)
                    }
                }
            }
    }
}

struct TaskDragSourceModifier: ViewModifier {
    let payload: TaskDragPayload?
    let title: String

    @ViewBuilder
    func body(content: Content) -> some View {
        if let payload {
            content
                .draggable(payload) {
                    Label(title, systemImage: "rectangle.stack.fill")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .lineLimit(1)
                        .padding(.horizontal, 16)
                        .frame(height: 48)
                        .frame(maxWidth: 260, alignment: .leading)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .stroke(TaskifyTheme.border, lineWidth: 1)
                        )
                }
                .accessibilityHint("Touch and hold, then drag to another list or day")
        } else {
            content
        }
    }
}

@MainActor
final class HorizontalTaskDragAutoScrollController {
    private var command: HorizontalDragAutoScrollCommand?
    private var scrollTask: Task<Void, Never>?
    var onStep: ((HorizontalDragAutoScrollDirection, TimeInterval) -> Void)?

    deinit {
        scrollTask?.cancel()
    }

    func update(_ nextCommand: HorizontalDragAutoScrollCommand?) {
        guard let nextCommand else {
            stop()
            return
        }
        if let command,
           command.direction == nextCommand.direction,
           abs(command.interval - nextCommand.interval) < 0.06 {
            return
        }

        command = nextCommand
        scrollTask?.cancel()
        scrollTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .seconds(min(0.24, nextCommand.interval)))
                while !Task.isCancelled {
                    guard let self, let command = self.command else { return }
                    self.onStep?(command.direction, command.interval)
                    try await Task.sleep(for: .seconds(command.interval))
                }
            } catch {
                return
            }
        }
    }

    func stop() {
        command = nil
        scrollTask?.cancel()
        scrollTask = nil
    }
}

struct HorizontalTaskDragAutoScrollDropDelegate: DropDelegate {
    let controller: HorizontalTaskDragAutoScrollController
    let policy: HorizontalDragAutoScrollPolicy

    func dropEntered(info: DropInfo) {
        update(with: info)
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        update(with: info)
        return DropProposal(operation: .move)
    }

    func dropExited(info: DropInfo) {
        controller.stop()
    }

    func performDrop(info: DropInfo) -> Bool {
        controller.stop()
        return false
    }

    private func update(with info: DropInfo) {
        controller.update(policy.command(
            forHorizontalLocation: Double(info.location.x)
        ))
    }
}

struct HorizontalTaskDragAutoScrollModifier: ViewModifier {
    let pageIDs: [String]
    @Binding var focusedPageID: String?
    let viewportWidth: CGFloat
    @State private var controller = HorizontalTaskDragAutoScrollController()

    func body(content: Content) -> some View {
        content
            .onDrop(
                of: [.taskifyTask],
                delegate: HorizontalTaskDragAutoScrollDropDelegate(
                    controller: controller,
                    policy: HorizontalDragAutoScrollPolicy(
                        viewportWidth: Double(viewportWidth)
                    )
                )
            )
            .onAppear(perform: configureController)
            .onChange(of: pageIDs) { _, _ in configureController() }
            .onDisappear { controller.stop() }
    }

    private func configureController() {
        let focusedPageID = $focusedPageID
        let pageIDs = pageIDs
        controller.onStep = { direction, interval in
            guard !pageIDs.isEmpty else { return }
            let currentIndex = focusedPageID.wrappedValue
                .flatMap { pageIDs.firstIndex(of: $0) }
                ?? 0
            let nextIndex = switch direction {
            case .backward: max(0, currentIndex - 1)
            case .forward: min(pageIDs.count - 1, currentIndex + 1)
            }
            guard nextIndex != currentIndex else { return }
            withAnimation(.easeInOut(duration: min(0.42, max(0.25, interval * 0.65)))) {
                focusedPageID.wrappedValue = pageIDs[nextIndex]
            }
        }
    }
}

extension View {
    func taskDropTarget(
        boardID: String,
        columnID: String,
        beforeTaskID: String? = nil,
        style: TaskDropTargetStyle
    ) -> some View {
        modifier(TaskDropTargetModifier(
            boardID: boardID,
            columnID: columnID,
            beforeTaskID: beforeTaskID,
            style: style
        ))
    }

    func horizontalTaskDragAutoScroll(
        pageIDs: [String],
        focusedPageID: Binding<String?>,
        viewportWidth: CGFloat
    ) -> some View {
        modifier(HorizontalTaskDragAutoScrollModifier(
            pageIDs: pageIDs,
            focusedPageID: focusedPageID,
            viewportWidth: viewportWidth
        ))
    }
}

/// Drives Boards' multi-select mode (ported from the PWA's `useSelectionMode`). It tracks both
/// tasks and Taskify events so mixed selections can move or delete together.
@Observable
final class TaskSelectionController {
    private(set) var isActive = false
    private(set) var selectedTaskIDs: Set<String> = []
    private(set) var selectedEventIDs: Set<String> = []

    var selectedCount: Int { selectedTaskIDs.count + selectedEventIDs.count }
    var isEmpty: Bool { selectedTaskIDs.isEmpty && selectedEventIDs.isEmpty }

    func enter() {
        isActive = true
        selectedTaskIDs.removeAll()
        selectedEventIDs.removeAll()
    }

    func exit() {
        isActive = false
        selectedTaskIDs.removeAll()
        selectedEventIDs.removeAll()
    }

    func toggle(_ taskID: String) {
        if selectedTaskIDs.contains(taskID) {
            selectedTaskIDs.remove(taskID)
        } else {
            selectedTaskIDs.insert(taskID)
        }
    }

    func toggleEvent(_ eventID: String) {
        if selectedEventIDs.contains(eventID) {
            selectedEventIDs.remove(eventID)
        } else {
            selectedEventIDs.insert(eventID)
        }
    }

    func clear() {
        selectedTaskIDs.removeAll()
        selectedEventIDs.removeAll()
    }

    func retainOnlyTasks(_ availableTaskIDs: Set<String>) {
        selectedTaskIDs.formIntersection(availableTaskIDs)
    }

    func retainOnlyEvents(_ availableEventIDs: Set<String>) {
        selectedEventIDs.formIntersection(availableEventIDs)
    }
}

enum TaskCompletionFlightCoordinateSpace {
    static let name = "taskify.boards.completion-flight"
}



extension GeometryProxy {
    /// Centre of this view in the flight coordinate space — where a completion dot launches from.
    var flightOrigin: CGPoint {
        let frame = frame(in: .named(TaskCompletionFlightCoordinateSpace.name))
        return CGPoint(x: frame.midX, y: frame.midY)
    }
}

/// Immediate press feedback for the completion checkbox, plus a touch-down hook.
///
/// A `Button`'s action runs on touch-*up*, so the haptic and the flight animation waited out the
/// whole time the finger was down — 100-200ms of nothing, which is what read as lag. (The action
/// itself was never late: measured at 0.4ms after touch-up with the frame committed ~13ms later.)
/// `onPressBegan` fires the completion from the touch-down edge instead; `TaskCardView` swallows
/// the matching touch-up so the work happens exactly once.
struct TaskCompletionToggleButtonStyle: ButtonStyle {
    let onPressBegan: () -> Void

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.82 : 1)
            .opacity(configuration.isPressed ? 0.55 : 1)
            .animation(.easeOut(duration: 0.08), value: configuration.isPressed)
            .onChange(of: configuration.isPressed) { _, isPressed in
                if isPressed { onPressBegan() }
            }
    }
}

/// Collapses the touch-down and touch-up halves of one tap into a single completion.
///
/// Keyed by task id and by time rather than by a per-view flag, deliberately: the view that would
/// own such a flag is destroyed or re-rendered by the very completion it is tracking, so it can
/// never be trusted to clear it. Anything here expires on its own.
@MainActor
enum CompletionTapCoalescer {
    /// Comfortably longer than a press, short enough that a deliberate re-tap (undoing a
    /// completion you just made) still registers.
    private static let window: CFTimeInterval = 0.4
    private static var lastHandled: [String: CFTimeInterval] = [:]

    static func shouldHandle(taskID: String) -> Bool {
        let now = CACurrentMediaTime()
        if let last = lastHandled[taskID], now - last < window { return false }
        lastHandled[taskID] = now
        if lastHandled.count > 64 {
            lastHandled = lastHandled.filter { now - $0.value < window }
        }
        return true
    }
}

/// Memoizes the link-derived text every task card shows.
///
/// `hasMedia`, `displayTitle`, and `displayNote` each run an `NSRegularExpression` pass over a
/// task's title and note. They're pure functions of those two strings, but SwiftUI re-evaluates a
/// card's body every time the row is instantiated — and in a `LazyVStack` a whole column's worth
/// of rows instantiates at once, every time that column pages into view. That put a burst of
/// regex passes (plus the NSString bridging they need) directly in the path of a horizontal
/// swipe.
///
/// Keyed by content rather than task id, so an entry stays valid across snapshot writes that
/// don't touch the text — which is most of them — and goes stale the moment the task is edited.
@MainActor
enum TaskCardTextCache {
    struct Derived {
        let displayTitle: String
        let displayNote: String
        let hasLink: Bool
    }

    private struct Key: Hashable {
        let title: String
        let note: String
    }

    /// A board renders far fewer distinct cards than this between evictions, so the cheap
    /// drop-everything eviction below effectively never runs during normal scrolling. It exists
    /// only so a long session across many boards can't grow this without bound.
    private static let capacity = 512
    private static var entries: [Key: Derived] = [:]

    static func derived(title: String, note: String) -> Derived {
        let key = Key(title: title, note: note)
        if let cached = entries[key] { return cached }

        let displayTitle: String
        if TaskContentLinks.isURLOnly(title),
           let url = TaskContentLinks.firstURL(title: title, note: "") {
            displayTitle = TaskContentLinks.fallbackTitle(for: url)
        } else {
            displayTitle = title
        }
        let derived = Derived(
            displayTitle: displayTitle,
            displayNote: TaskContentLinks.removingURLs(from: note),
            hasLink: TaskContentLinks.firstURL(title: title, note: note) != nil
        )

        if entries.count >= capacity {
            entries.removeAll(keepingCapacity: true)
        }
        entries[key] = derived
        return derived
    }
}

/// Tracks the board's scroll views so a touch-down can tell whether the list is moving.
///
/// Completing on touch-down means a tap that was really meant to halt a coasting list would
/// otherwise check off whatever it landed on. Momentum taps are caught here; a touch that lands
/// still and *then* turns into a drag is not, which is the accepted trade for instant feedback.
@MainActor
enum BoardScrollActivity {
    private static let scrollViews = NSHashTable<UIScrollView>.weakObjects()

    static func register(_ scrollView: UIScrollView) {
        scrollViews.add(scrollView)
    }

    static var isMoving: Bool {
        scrollViews.allObjects.contains { $0.isDragging || $0.isDecelerating }
    }
}

/// Turns off `UIScrollView.delaysContentTouches` for every enclosing scroll view.
///
/// It defaults to `true`, which withholds touches from content for ~150ms while the scroll view
/// decides whether a pan is starting. That delay lands squarely on the press feedback above — the
/// checkbox would highlight a beat after the finger, or not at all for a quick tap. SwiftUI
/// exposes no modifier for it, hence the walk up the UIKit superview chain. Scrolling still
/// cancels an in-progress press, because `canCancelContentTouches` remains true.
struct ImmediateScrollTouchDelivery: UIViewRepresentable {
    /// Remembers which superview the chain was last configured from. SwiftUI calls `updateUIView`
    /// on every render pass of the enclosing list — which, mid-swipe, is a steady stream — and the
    /// walk below is pure repeat work once a chain has been configured: `delaysContentTouches`
    /// stays false and re-registering a scroll view is a no-op. Re-running only when the view is
    /// re-parented keeps a `DispatchQueue.main.async` hop off the main thread during scrolling
    /// while still covering the case where SwiftUI moves the view to a new chain.
    @MainActor
    final class Coordinator {
        weak var configuredFrom: UIView?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UIView {
        let view = UIView(frame: .zero)
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        // Deferred: on the first update pass the view is not in the hierarchy yet, so there is no
        // superview chain to walk.
        DispatchQueue.main.async {
            guard let superview = uiView.superview else { return }
            guard context.coordinator.configuredFrom !== superview else { return }
            context.coordinator.configuredFrom = superview

            // Every scroll view in the chain, not just the nearest: a board column's vertical
            // scroll view sits inside the horizontal day-pager, and the outer one delays touches
            // to everything within it regardless of what the inner one allows.
            var ancestor: UIView? = superview
            while let current = ancestor {
                if let scrollView = current as? UIScrollView {
                    scrollView.delaysContentTouches = false
                    BoardScrollActivity.register(scrollView)
                }
                ancestor = current.superview
            }
        }
    }
}

extension View {
    /// Apply inside any scroll view containing `TaskCardView`, so its checkbox reacts to a finger
    /// immediately rather than after the scroll view's ~150ms touch-delay.
    func immediateScrollTouchDelivery() -> some View {
        background(ImmediateScrollTouchDelivery().frame(width: 0, height: 0))
    }
}


/// Drives the "checkmark flies to the completed toggle" animation, mirroring the PWA's
/// `flyToCompleted` (taskify-pwa/src/App.tsx).
///
/// Each flight is a bare `CALayer` animated with Core Animation rather than a SwiftUI view with
/// its own `@State`, which is what makes rapid check-offs behave:
///
/// - **Smooth.** Completing a task mutates the snapshot, so the board re-renders on the main
///   thread while the dot is mid-air. A SwiftUI `.position` animation is interpolated on the
///   main thread every frame and visibly stutters through that; a committed `CAAnimation` is
///   interpolated by the render server and is unaffected.
/// - **Non-blocking.** Launching a flight touches no observable state, so it never invalidates
///   `BoardsView` and never re-renders the row the user is about to tap next.
/// - **Overlapping.** Every flight owns an independent layer, so checking off five tasks in a
///   second simply puts five dots in the air at once.
@MainActor
@Observable
final class TaskCompletionAnimationController {
    /// Centre of the completed-tasks toggle, in the flight coordinate space.
    @ObservationIgnored var destination: CGPoint?
    /// The overlay the dots are added to; owned by `TaskCompletionFlightLayer`.
    @ObservationIgnored weak var hostView: UIView?

    private static let duration: CFTimeInterval = 0.6
    /// The dot holds full opacity for most of the flight and only dissolves as it lands — the
    /// web transition's `opacity 300ms ease 420ms` against a 600ms travel.
    private static let fadeStart: CFTimeInterval = 0.42

    @ObservationIgnored private lazy var dotImage: UIImage = Self.makeDotImage()

    func launch(from source: CGPoint) {
        guard let destination, let hostView else { return }

        let layer = CALayer()
        layer.contents = dotImage.cgImage
        layer.contentsScale = dotImage.scale
        layer.bounds = CGRect(origin: .zero, size: dotImage.size)
        layer.position = source
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.35
        layer.shadowRadius = 8
        layer.shadowOffset = CGSize(width: 0, height: 6)
        // The dot is a fixed image, so let Core Animation cache its shadow once instead of
        // recomputing it per frame.
        layer.shouldRasterize = true
        layer.rasterizationScale = dotImage.scale

        let timing = CAMediaTimingFunction(controlPoints: 0.2, 0.7, 0.3, 1)

        // A shallow arc, bowed away from the straight line, so the dot reads as *flying* to the
        // toggle rather than sliding there.
        let path = UIBezierPath()
        path.move(to: source)
        path.addQuadCurve(to: destination, controlPoint: Self.arcControlPoint(from: source, to: destination))

        let travel = CAKeyframeAnimation(keyPath: "position")
        travel.path = path.cgPath
        travel.calculationMode = .paced
        travel.timingFunction = timing

        let shrink = CABasicAnimation(keyPath: "transform.scale")
        shrink.fromValue = 1.0
        shrink.toValue = 0.5
        shrink.timingFunction = timing

        let fade = CAKeyframeAnimation(keyPath: "opacity")
        fade.values = [1.0, 1.0, 0.0]
        fade.keyTimes = [0, NSNumber(value: Self.fadeStart / Self.duration), 1]
        fade.timingFunctions = [
            CAMediaTimingFunction(name: .linear),
            CAMediaTimingFunction(name: .easeInEaseOut),
        ]

        let group = CAAnimationGroup()
        group.animations = [travel, shrink, fade]
        group.duration = Self.duration
        group.fillMode = .forwards
        group.isRemovedOnCompletion = false

        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak layer] in
            layer?.removeFromSuperlayer()
        }
        hostView.layer.addSublayer(layer)
        layer.add(group, forKey: "taskify.completion-flight")
        CATransaction.commit()
    }

    func reset() {
        hostView?.layer.sublayers?.forEach { $0.removeFromSuperlayer() }
    }

    /// Offsets the midpoint perpendicular to the source→destination line by a fraction of its
    /// length (clamped, so short hops stay nearly straight and long ones don't loop absurdly).
    private static func arcControlPoint(from source: CGPoint, to destination: CGPoint) -> CGPoint {
        let dx = destination.x - source.x
        let dy = destination.y - source.y
        let distance = (dx * dx + dy * dy).squareRoot()
        guard distance > 1 else { return source }

        let bow = min(distance * 0.18, 64)
        let midpoint = CGPoint(x: (source.x + destination.x) / 2, y: (source.y + destination.y) / 2)
        // Perpendicular unit vector, chosen so the arc always bows outward (away from the
        // checkbox column) rather than back across the card it came from.
        let normal = CGPoint(x: -dy / distance, y: dx / distance)
        let direction: CGFloat = dx >= 0 ? 1 : -1
        return CGPoint(x: midpoint.x + normal.x * bow * direction,
                       y: midpoint.y + normal.y * bow * direction)
    }

    /// A 20pt accent dot carrying a dark `--accent-on` check, ringed by the 2pt `--accent-soft`
    /// halo the web build draws with `box-shadow: 0 0 0 2px`.
    private static func makeDotImage() -> UIImage {
        let diameter: CGFloat = 20
        let ring: CGFloat = 2
        let size = CGSize(width: diameter + ring * 2, height: diameter + ring * 2)

        return UIGraphicsImageRenderer(size: size).image { context in
            let cgContext = context.cgContext
            cgContext.setFillColor(UIColor(TaskifyTheme.accentSoft).cgColor)
            cgContext.fillEllipse(in: CGRect(origin: .zero, size: size))

            let dot = CGRect(x: ring, y: ring, width: diameter, height: diameter)
            cgContext.setFillColor(UIColor(TaskifyTheme.accent).cgColor)
            cgContext.fillEllipse(in: dot)

            let symbol = UIImage(
                systemName: "checkmark",
                withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .heavy)
            )?.withTintColor(UIColor(TaskifyTheme.accentOn), renderingMode: .alwaysOriginal)

            if let symbol {
                symbol.draw(in: CGRect(
                    x: dot.midX - symbol.size.width / 2,
                    y: dot.midY - symbol.size.height / 2,
                    width: symbol.size.width,
                    height: symbol.size.height
                ))
            }
        }
    }
}

struct TaskCompletionDestinationPreferenceKey: PreferenceKey {
    static var defaultValue: CGPoint?

    static func reduce(value: inout CGPoint?, nextValue: () -> CGPoint?) {
        value = nextValue() ?? value
    }
}

/// Hosts the flight layers. `UIViewRepresentable` (rather than a SwiftUI `ZStack`) so the dots
/// live outside SwiftUI's update cycle entirely — see `TaskCompletionAnimationController`.
struct TaskCompletionFlightLayer: UIViewRepresentable {
    let controller: TaskCompletionAnimationController

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear
        view.layer.masksToBounds = false
        controller.hostView = view
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        controller.hostView = uiView
    }
}
