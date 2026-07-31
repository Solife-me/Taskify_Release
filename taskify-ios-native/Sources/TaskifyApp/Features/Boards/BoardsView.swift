import CoreImage
import CoreImage.CIFilterBuiltins
import CoreTransferable
import SwiftUI
import TaskifyCore
import UIKit
import UniformTypeIdentifiers

private extension UTType {
    static let taskifyTask = UTType(exportedAs: "me.solife.taskify.task")
}

private struct TaskDragPayload: Codable, Hashable, Transferable {
    let taskID: String

    static var transferRepresentation: some TransferRepresentation {
        CodableRepresentation(contentType: .taskifyTask)
    }
}

private enum TaskDropTargetStyle: Equatable {
    case card
    case column
}

private struct BoardQuickAddDestination: Equatable {
    let boardID: String
    let columnID: String
    let displayName: String
    let weekday: WeekdayColumn?
}

private struct TaskDropTargetModifier: ViewModifier {
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

private struct TaskDragSourceModifier: ViewModifier {
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
private final class HorizontalTaskDragAutoScrollController {
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

private struct HorizontalTaskDragAutoScrollDropDelegate: DropDelegate {
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

private struct HorizontalTaskDragAutoScrollModifier: ViewModifier {
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

private extension View {
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

/// Drives Boards' multi-select mode (ported from the PWA's `useSelectionMode`). Owned as `@State`
/// by `BoardsView` and handed down via `.environment(_:)` so column views and `TaskCardView` —
/// several layers deep across three different board-kind view trees — can read/mutate it without
/// threading a binding through every intermediate initializer.
@Observable
final class TaskSelectionController {
    private(set) var isActive = false
    private(set) var selectedTaskIDs: Set<String> = []

    func enter() {
        isActive = true
        selectedTaskIDs.removeAll()
    }

    func exit() {
        isActive = false
        selectedTaskIDs.removeAll()
    }

    func toggle(_ taskID: String) {
        if selectedTaskIDs.contains(taskID) {
            selectedTaskIDs.remove(taskID)
        } else {
            selectedTaskIDs.insert(taskID)
        }
    }

    func clear() {
        selectedTaskIDs.removeAll()
    }

    func retainOnly(_ availableTaskIDs: Set<String>) {
        selectedTaskIDs.formIntersection(availableTaskIDs)
    }
}

private enum TaskCompletionFlightCoordinateSpace {
    static let name = "taskify.boards.completion-flight"
}



private extension GeometryProxy {
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
private struct TaskCompletionToggleButtonStyle: ButtonStyle {
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
private enum CompletionTapCoalescer {
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
    func makeUIView(context: Context) -> UIView {
        let view = UIView(frame: .zero)
        view.isUserInteractionEnabled = false
        return view
    }


    func updateUIView(_ uiView: UIView, context: Context) {
        // Deferred: on the first update pass the view is not in the hierarchy yet, so there is no
        // superview chain to walk.
        DispatchQueue.main.async {
            // Every scroll view in the chain, not just the nearest: a board column's vertical
            // scroll view sits inside the horizontal day-pager, and the outer one delays touches
            // to everything within it regardless of what the inner one allows.
            var ancestor = uiView.superview
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
private final class TaskCompletionAnimationController {
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

private struct TaskCompletionDestinationPreferenceKey: PreferenceKey {
    static var defaultValue: CGPoint?

    static func reduce(value: inout CGPoint?, nextValue: () -> CGPoint?) {
        value = nextValue() ?? value
    }
}

/// Hosts the flight layers. `UIViewRepresentable` (rather than a SwiftUI `ZStack`) so the dots
/// live outside SwiftUI's update cycle entirely — see `TaskCompletionAnimationController`.
private struct TaskCompletionFlightLayer: UIViewRepresentable {
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

struct BoardsView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("taskify.board.sort.mode") private var sortModeRaw = UpcomingSortMode.manual.rawValue
    @AppStorage("taskify.board.sort.direction") private var sortDirectionRaw = UpcomingSortDirection.ascending.rawValue
    @AppStorage(TaskPresentationSettings.completedTabKey)
    private var completedTabEnabled = TaskPresentationSettings.completedTabDefault
    @State private var showCompleted = false
    @State private var showingAddList = false
    @State private var showingBoardShare = false
    @State private var showingBoardUpcoming = false
    @State private var showingSortOptions = false
    @State private var showingClearCompletedConfirmation = false
    @State private var showingSelectionMoveSheet = false
    @State private var showingVoiceDictation = false
    @State private var newListName = ""
    @State private var quickTaskDraft = ""
    @State private var focusedPageID: String?
    @State private var selection = TaskSelectionController()
    @State private var completionAnimations = TaskCompletionAnimationController()
    @FocusState private var quickTaskFieldIsFocused: Bool

    private var sortMode: UpcomingSortMode {
        UpcomingSortMode(rawValue: sortModeRaw) ?? .manual
    }

    private var sortDirection: UpcomingSortDirection {
        UpcomingSortDirection(rawValue: sortDirectionRaw) ?? sortMode.defaultDirection
    }

    private var availableTaskIDs: Set<String> {
        model.activeTaskIDs
    }

    private var completedTasksAreVisible: Bool {
        model.selectedBoard?.kind == .bible ? showCompleted : (!completedTabEnabled || showCompleted)
    }

    private var hasCompletedTasks: Bool {
        guard let boardID = model.selectedBoard?.id else { return false }
        return model.completedTaskCount(forBoardID: boardID) > 0
    }

    var body: some View {
        VStack(spacing: 10) {
            header
                .padding(.horizontal, 18)
                .padding(.top, 6)

            boardContent
                .environment(selection)
                .environment(completionAnimations)
        }
        .coordinateSpace(name: TaskCompletionFlightCoordinateSpace.name)
        .onPreferenceChange(TaskCompletionDestinationPreferenceKey.self) { destination in
            completionAnimations.destination = destination
        }
        .overlay {
            TaskCompletionFlightLayer(controller: completionAnimations)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
        .overlay(alignment: .bottom) {
            if selection.isActive {
                SelectionActionBar(
                    selection: selection,
                    onMove: { showingSelectionMoveSheet = true },
                    onComplete: {
                        model.completeTasks(selection.selectedTaskIDs)
                        selection.exit()
                    },
                    onDelete: {
                        model.deleteTasks(selection.selectedTaskIDs)
                        selection.exit()
                    }
                )
                .padding(.horizontal, 18)
                .padding(.bottom, 10)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            } else if let quickAddDestination {
                FloatingQuickAddBar(
                    draft: $quickTaskDraft,
                    isFocused: $quickTaskFieldIsFocused,
                    destinationName: quickAddDestination.displayName,
                    onSubmit: { addQuickTask(dismissKeyboard: false) },
                    onAddButton: { addQuickTask(dismissKeyboard: true) },
                    onVoice: {
                        quickTaskFieldIsFocused = false
                        showingVoiceDictation = true
                    }
                )
                .padding(.horizontal, 18)
                .padding(.bottom, 10)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .sheet(isPresented: $showingVoiceDictation) {
            VoiceDictationSheet()
                .environment(model)
        }
        .sheet(isPresented: $showingSelectionMoveSheet) {
            SelectionMoveSheet(selection: selection) {
                selection.exit()
            }
            .environment(model)
        }
        .alert("Add list", isPresented: $showingAddList) {
            TextField("List name", text: $newListName)
            Button("Cancel", role: .cancel) { newListName = "" }
            Button("Add") {
                guard model.addListColumn(name: newListName) else { return }
                newListName = ""
            }
            .disabled(newListName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: {
            Text("Create another column on \(model.selectedBoard?.name ?? "this board").")
        }
        .sheet(isPresented: $showingBoardShare) {
            if let board = model.selectedBoard {
                BoardShareSheet(board: board)
            }
        }
        .sheet(isPresented: $showingBoardUpcoming) {
            if let board = model.selectedBoard {
                BoardUpcomingSheet(board: board)
                    .environment(model)
            }
        }
        .sheet(isPresented: $showingSortOptions) {
            BoardSortOptionsSheet(
                sortMode: sortMode,
                sortDirection: sortDirection,
                onSelectSort: selectSortMode
            )
            .presentationDetents([.medium])
            .presentationDragIndicator(.visible)
        }
        .confirmationDialog(
            "Clear all completed tasks on \(model.selectedBoard?.name ?? "this board")?",
            isPresented: $showingClearCompletedConfirmation,
            titleVisibility: .visible
        ) {
            Button("Clear completed", role: .destructive) {
                guard let boardID = model.selectedBoard?.id else { return }
                model.clearCompletedTasks(forBoardID: boardID)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This can't be undone.")
        }
        .onAppear(perform: resetFocusedPage)
        .onAppear(perform: TaskCompletionHaptics.warmUp)
        .onChange(of: model.selectedBoardID) { _, _ in
            selection.exit()
            completionAnimations.reset()
            quickTaskDraft = ""
            quickTaskFieldIsFocused = false
            resetFocusedPage()
        }
        .onChange(of: availableTaskIDs) { _, taskIDs in
            selection.retainOnly(taskIDs)
        }
        .onChange(of: completedTabEnabled) { _, enabled in
            showCompleted = false
            if !enabled {
                completionAnimations.destination = nil
            }
        }
    }

    @ViewBuilder
    private var boardContent: some View {
        switch model.selectedBoard?.kind {
        case .week:
            WeekBoardView(
                showCompleted: completedTasksAreVisible,
                sortMode: sortMode,
                sortDirection: sortDirection,
                focusedPageID: $focusedPageID
            )
        case .list:
            if let board = model.selectedBoard {
                ListBoardView(
                    board: board,
                    showCompleted: completedTasksAreVisible,
                    sortMode: sortMode,
                    sortDirection: sortDirection,
                    focusedPageID: $focusedPageID
                )
            }
        case .compound:
            if let board = model.selectedBoard {
                CompoundBoardView(
                    board: board,
                    showCompleted: completedTasksAreVisible,
                    sortMode: sortMode,
                    sortDirection: sortDirection,
                    focusedPageID: $focusedPageID
                )
            }
        case .bible:
            BibleTrackerView(showCompletedBooks: showCompleted)
        case nil:
            ContentUnavailableView("No board selected", systemImage: "square.grid.2x2")
                .foregroundStyle(TaskifyTheme.secondaryText)
        }
    }

    private var quickAddDestination: BoardQuickAddDestination? {
        guard let board = model.selectedBoard else { return nil }

        switch board.kind {
        case .week:
            let weekday = WeekdayColumn(rawValue: focusedPageID ?? "")
                ?? WeekdayColumn.containing(Date())
            return BoardQuickAddDestination(
                boardID: board.id,
                columnID: weekday.rawValue,
                displayName: weekday.fullName,
                weekday: weekday
            )
        case .list:
            let columns = board.columns.sorted {
                if $0.order != $1.order { return $0.order < $1.order }
                return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            }
            guard let column = columns.first(where: { $0.id == focusedPageID }) ?? columns.first else {
                return nil
            }
            return BoardQuickAddDestination(
                boardID: board.id,
                columnID: column.id,
                displayName: column.name,
                weekday: nil
            )
        case .compound:
            let references = model.compoundChildBoards(for: board.id).flatMap { child in
                child.columns.map { CompoundColumnReference(board: child, column: $0) }
            }
            guard let reference = references.first(where: { $0.id == focusedPageID }) ?? references.first else {
                return nil
            }
            return BoardQuickAddDestination(
                boardID: reference.board.id,
                columnID: reference.column.id,
                displayName: "\(reference.board.name), \(reference.column.name)",
                weekday: nil
            )
        case .bible:
            return nil
        }
    }

    private func resetFocusedPage() {
        guard let board = model.selectedBoard else {
            focusedPageID = nil
            return
        }

        switch board.kind {
        case .week:
            focusedPageID = WeekdayColumn.containing(Date()).rawValue
        case .list:
            focusedPageID = board.columns.sorted { $0.order < $1.order }.first?.id
        case .compound:
            focusedPageID = model.compoundChildBoards(for: board.id)
                .flatMap { child in
                    child.columns
                        .sorted { $0.order < $1.order }
                        .map { CompoundColumnReference(board: child, column: $0).id }
                }
                .first
        case .bible:
            focusedPageID = nil
        }
    }

    private func dismissQuickTaskKeyboard() {
        quickTaskFieldIsFocused = false
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil
        )
    }

    private func addQuickTask(dismissKeyboard: Bool) {
        guard let quickAddDestination else { return }
        let title = quickTaskDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }

        quickTaskDraft = ""
        if dismissKeyboard {
            dismissQuickTaskKeyboard()
        }

        if let weekday = quickAddDestination.weekday {
            model.addQuickTask(title: title, weekday: weekday)
        } else {
            model.addQuickTask(
                title: title,
                boardID: quickAddDestination.boardID,
                columnID: quickAddDestination.columnID
            )
        }
    }

    private func selectSortMode(_ mode: UpcomingSortMode) {
        if sortMode == mode, mode.supportsDirection {
            sortDirectionRaw = (sortDirection == .ascending
                ? UpcomingSortDirection.descending
                : UpcomingSortDirection.ascending).rawValue
            return
        }
        sortModeRaw = mode.rawValue
        sortDirectionRaw = mode.defaultDirection.rawValue
    }

    private var header: some View {
        TaskifyGlassControlGroup(spacing: 10) {
            HStack(spacing: 10) {
                HStack(spacing: 0) {
                    Menu {
                        ForEach(model.visibleBoards) { board in
                            Button {
                                model.selectBoard(board.id)
                            } label: {
                                if board.id == model.selectedBoardID {
                                    Label(board.name, systemImage: "checkmark")
                                } else {
                                    Text(board.name)
                                }
                            }
                        }
                    } label: {
                        HStack(spacing: 8) {
                            Text(model.selectedBoard?.name ?? "Boards")
                                .font(.system(size: 17, weight: .semibold))
                                .lineLimit(1)
                            Image(systemName: "chevron.down")
                                .font(.system(size: 11, weight: .bold))
                        }
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .padding(.leading, 16)
                        .padding(.trailing, 11)
                        .frame(height: 42)
                    }

                    if model.selectedBoard?.kind != .bible {
                        Rectangle()
                            .fill(TaskifyTheme.border)
                            .frame(width: 1, height: 23)

                        Button {
                            showingBoardShare = true
                        } label: {
                            Image(systemName: "square.and.arrow.up")
                                .font(.system(size: 15, weight: .semibold))
                                .frame(width: 42, height: 42)
                                .contentShape(Rectangle())
                        }
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .buttonStyle(.plain)
                        .accessibilityLabel("Share \(model.selectedBoard?.name ?? "board")")
                    }
                }
                .taskifyGlassControl(in: Capsule())
                .layoutPriority(1)

                Spacer(minLength: 4)

                if completedTabEnabled || model.selectedBoard?.kind == .bible {
                    HeaderIconButton(
                        systemName: showCompleted ? "checkmark.circle.fill" : "checkmark",
                        accent: showCompleted,
                        accessibilityLabel: showCompleted ? "Hide completed tasks" : "Show completed tasks"
                    ) {
                        withAnimation(.snappy) { showCompleted.toggle() }
                    }
                    .background {
                        GeometryReader { proxy in
                            let frame = proxy.frame(in: .named(TaskCompletionFlightCoordinateSpace.name))
                            Color.clear.preference(
                                key: TaskCompletionDestinationPreferenceKey.self,
                                value: CGPoint(x: frame.midX, y: frame.midY)
                            )
                        }
                    }
                    .contextMenu {
                        if showCompleted,
                           model.selectedBoard?.kind != .bible,
                           model.selectedBoard?.clearCompletedDisabled == false {
                            Button(role: .destructive) {
                                showingClearCompletedConfirmation = true
                            } label: {
                                Label("Clear completed tasks", systemImage: "trash")
                            }
                        }
                    }
                } else if model.selectedBoard?.clearCompletedDisabled == false {
                    HeaderIconButton(
                        systemName: "trash",
                        accessibilityLabel: "Clear completed tasks"
                    ) {
                        showingClearCompletedConfirmation = true
                    }
                    .disabled(!hasCompletedTasks)
                    .opacity(hasCompletedTasks ? 1 : 0.42)
                }

                if model.selectedBoard?.kind == .list {
                    HeaderIconButton(
                        systemName: "rectangle.stack.badge.plus",
                        accessibilityLabel: "Add list"
                    ) {
                        showingAddList = true
                    }
                } else if model.selectedBoard?.kind != .bible {
                    HeaderIconButton(
                        systemName: "calendar",
                        accessibilityLabel: "Board upcoming"
                    ) {
                        showingBoardUpcoming = true
                    }
                }

                if model.selectedBoard?.kind != .bible {
                    HeaderIconButton(
                        systemName: "arrow.up.arrow.down",
                        accent: sortMode != .manual,
                        accessibilityLabel: "Sort tasks"
                    ) {
                        showingSortOptions = true
                    }
                }
            }
        }
    }
}

private enum SharedInboxFilterTab: String, CaseIterable {
    case new = "New"
    case replied = "Replied"
}

struct SharedTaskInboxSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    @State private var selectedTab: SharedInboxFilterTab = .new

    private var visibleItems: [SharedInboxItem] {
        model.sharedInboxItems.filter { $0.status != .deleted }
    }

    private var filteredItems: [SharedInboxItem] {
        visibleItems.filter { item in
            switch selectedTab {
            case .new: item.status == .pending
            case .replied: item.status != .pending
            }
        }
    }

    private var destinationName: String? {
        guard let board = model.selectedBoard, board.kind != .bible else { return nil }
        return board.name
    }

    var body: some View {
        NavigationStack {
            Group {
                if filteredItems.isEmpty {
                    ContentUnavailableView(
                        selectedTab == .new ? "No new invitations" : "No replied invitations",
                        systemImage: "tray",
                        description: Text("Tasks and assignments sent to your Nostr identity will appear here.")
                    )
                    .foregroundStyle(TaskifyTheme.secondaryText)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            if selectedTab == .new, let destinationName {
                                Label(
                                    "Accepted tasks are added to \(destinationName)",
                                    systemImage: "arrow.down.app"
                                )
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(TaskifyTheme.secondaryText)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 4)
                            }

                            ForEach(filteredItems) { item in
                                SharedTaskInboxCard(
                                    item: item,
                                    canAccept: destinationName != nil
                                )
                            }
                        }
                        .padding(18)
                    }
                    .scrollIndicators(.hidden)
                }
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(TaskifyTheme.primaryText)
                            .frame(width: 32, height: 32)
                            .background(TaskifyTheme.raisedFill, in: Circle())
                    }
                    .accessibilityLabel("Close")
                }
                ToolbarItem(placement: .principal) {
                    Picker("Filter", selection: $selectedTab) {
                        ForEach(SharedInboxFilterTab.allCases, id: \.self) { tab in
                            Text(tab.rawValue).tag(tab)
                        }
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 200)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .preferredColorScheme(.dark)
    }
}

private struct SharedTaskInboxCard: View {
    @Environment(AppModel.self) private var model
    let item: SharedInboxItem
    let canAccept: Bool

    private var detailCount: Int {
        (item.task.subtasks?.count ?? 0) + (item.task.documents?.count ?? 0)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 9) {
                Label(
                    item.task.isAssignment ? "ASSIGNMENT" : "SHARED TASK",
                    systemImage: item.task.isAssignment ? "person.crop.circle.badge.checkmark" : "paperplane.fill"
                )
                .font(.system(size: 10, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(TaskifyTheme.accent)

                Spacer()

                Text(item.receivedAt, style: .relative)
                    .font(.caption2)
                    .foregroundStyle(TaskifyTheme.tertiaryText)
            }

            VStack(alignment: .leading, spacing: 5) {
                Text(item.task.title)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Text("From \(item.sender.displayName)")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(TaskifyTheme.secondaryText)

                if let note = item.task.note, !note.isEmpty {
                    Text(note)
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .lineLimit(3)
                        .padding(.top, 2)
                }
            }

            HStack(spacing: 12) {
                if let dueDate = item.task.dueDate {
                    Label(
                        dueDate.formatted(
                            date: .abbreviated,
                            time: item.task.dueTimeEnabled == true ? .shortened : .omitted
                        ),
                        systemImage: "calendar"
                    )
                }
                if let priority = item.task.priority.flatMap(TaskPriority.init(rawValue:)) {
                    Label(priority.cardLabel, systemImage: "exclamationmark")
                        .foregroundStyle(priority.cardColor)
                }
                if detailCount > 0 {
                    Label("\(detailCount)", systemImage: "paperclip")
                }
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(TaskifyTheme.tertiaryText)

            if item.status == .pending {
                pendingActions
            } else {
                HStack {
                    Label(statusLabel, systemImage: statusSymbol)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(statusColor)
                    Spacer()
                    Button("Remove") {
                        withAnimation(.snappy) {
                            model.dismissSharedInboxItem(item.id)
                        }
                    }
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.plain)
                    .foregroundStyle(TaskifyTheme.secondaryText)
                }
            }
        }
        .padding(15)
        .taskifyGlass(cornerRadius: 19)
    }

    @ViewBuilder
    private var pendingActions: some View {
        if item.task.isAssignment {
            HStack(spacing: 9) {
                responseButton("Decline", status: .declined, tint: .red)
                responseButton("Maybe", status: .tentative, tint: .orange)
                responseButton("Accept", status: .accepted, tint: TaskifyTheme.accent)
                    .disabled(!canAccept)
            }
        } else {
            HStack(spacing: 9) {
                Button {
                    withAnimation(.snappy) {
                        model.dismissSharedInboxItem(item.id)
                    }
                } label: {
                    Text("Dismiss")
                        .frame(maxWidth: .infinity)
                        .frame(height: 40)
                }
                .buttonStyle(.bordered)

                responseButton("Add Task", status: .accepted, tint: TaskifyTheme.accent)
                    .disabled(!canAccept)
            }
        }
    }

    private func responseButton(
        _ title: String,
        status: SharedInboxItemStatus,
        tint: Color
    ) -> some View {
        Button {
            withAnimation(.snappy) {
                _ = model.respondToSharedInboxItem(item.id, status: status)
            }
        } label: {
            Text(title)
                .frame(maxWidth: .infinity)
                .frame(height: 40)
        }
        .buttonStyle(.borderedProminent)
        .tint(tint)
    }

    private var statusLabel: String {
        switch item.status {
        case .pending: "Pending"
        case .accepted: "Accepted"
        case .declined: "Declined"
        case .tentative: "Maybe"
        case .deleted: "Removed"
        }
    }

    private var statusSymbol: String {
        switch item.status {
        case .pending: "clock"
        case .accepted: "checkmark.circle.fill"
        case .declined: "xmark.circle.fill"
        case .tentative: "questionmark.circle.fill"
        case .deleted: "trash"
        }
    }

    private var statusColor: Color {
        switch item.status {
        case .pending: TaskifyTheme.secondaryText
        case .accepted: .green
        case .declined: .red
        case .tentative: .orange
        case .deleted: TaskifyTheme.tertiaryText
        }
    }
}

private struct BoardSortOptionsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let sortMode: UpcomingSortMode
    let sortDirection: UpcomingSortDirection
    let onSelectSort: (UpcomingSortMode) -> Void

    private let columns = [GridItem(.flexible()), GridItem(.flexible())]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("SORT TASKS BY")
                        .font(.system(size: 11, weight: .bold))
                        .tracking(1)
                        .foregroundStyle(TaskifyTheme.tertiaryText)

                    LazyVGrid(columns: columns, spacing: 10) {
                        ForEach(UpcomingSortMode.allCases, id: \.rawValue) { mode in
                            Button {
                                onSelectSort(mode)
                            } label: {
                                HStack(spacing: 7) {
                                    Text(mode.label)
                                    if sortMode == mode, mode.supportsDirection {
                                        Image(systemName: sortDirection == .ascending ? "arrow.up" : "arrow.down")
                                    }
                                }
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(sortMode == mode ? .white : TaskifyTheme.secondaryText)
                                .frame(maxWidth: .infinity)
                                .frame(height: 44)
                                .background(
                                    sortMode == mode ? TaskifyTheme.accent : TaskifyTheme.raisedFill,
                                    in: Capsule()
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(18)
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Sort Board")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}

private struct BoardUpcomingSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    let board: Board

    private struct DayGroup: Identifiable {
        let date: Date
        let tasks: [TaskItem]
        var id: Date { date }
    }

    private var scopedBoardIDs: Set<String> {
        if board.kind == .compound {
            return Set(model.compoundChildBoards(for: board.id).map(\.id))
        }
        return [board.id]
    }

    private var groups: [DayGroup] {
        let calendar = Calendar.current
        let tasks = model.upcomingTasks().filter { scopedBoardIDs.contains($0.boardID) }
        let byDate = Dictionary(grouping: tasks) { calendar.startOfDay(for: $0.dueDate ?? Date()) }
        return byDate
            .map { date, tasks in
                DayGroup(
                    date: date,
                    tasks: UpcomingTaskOrganizer.sort(
                        tasks,
                        mode: .dueDate,
                        direction: .ascending,
                        boardGrouping: .mixed,
                        boardOrder: []
                    )
                )
            }
            .sorted { $0.date < $1.date }
    }

    var body: some View {
        NavigationStack {
            Group {
                if groups.isEmpty {
                    ContentUnavailableView(
                        "No upcoming items",
                        systemImage: "calendar",
                        description: Text("Tasks with a due date on \(board.name) will appear here.")
                    )
                    .foregroundStyle(TaskifyTheme.secondaryText)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 18) {
                            ForEach(groups) { group in
                                VStack(alignment: .leading, spacing: 9) {
                                    Text(dayLabel(group.date))
                                        .font(.system(size: 13, weight: .bold))
                                        .foregroundStyle(TaskifyTheme.tertiaryText)
                                    ForEach(group.tasks) { task in
                                        TaskCardView(task: task)
                                    }
                                }
                            }
                        }
                        .padding(18)
                    }
                    .scrollIndicators(.hidden)
                }
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("\(board.name) Upcoming")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .preferredColorScheme(.dark)
    }

    private func dayLabel(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInTomorrow(date) { return "Tomorrow" }
        return date.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
    }
}

private struct FloatingQuickAddBar: View {
    @Binding var draft: String
    var isFocused: FocusState<Bool>.Binding
    let destinationName: String
    let onSubmit: () -> Void
    let onAddButton: () -> Void
    let onVoice: () -> Void

    var body: some View {
        HStack(spacing: 9) {
            QuickAddTextField(
                text: $draft,
                isFocused: isFocused,
                accessibilityLabel: "New task in \(destinationName)",
                onSubmit: onSubmit
            )
                .padding(.horizontal, 17)
                .frame(height: 48)
                .taskifyGlassControl(
                    in: Capsule(),
                    fallbackFill: Color.black.opacity(0.32)
                )

            // Hidden while typing: the add button is the action you want in that moment, and two
            // circular buttons plus a shrinking field gets cramped on narrow screens.
            if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button(action: onVoice) {
                    Image(systemName: "mic.fill")
                        .font(.system(size: 17, weight: .semibold))
                        .frame(width: 48, height: 48)
                        .contentShape(Circle())
                        .foregroundStyle(.white)
                        .taskifyGlassControl(
                            in: Circle(),
                            fallbackFill: Color.black.opacity(0.32)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Add tasks by voice")
                .transition(.scale.combined(with: .opacity))
            }

            Button(action: onAddButton) {
                Image(systemName: "plus")
                    .font(.system(size: 19, weight: .bold))
                    .frame(width: 48, height: 48)
                    .contentShape(Circle())
                    .foregroundStyle(.white)
                    .taskifyGlassControl(
                        in: Circle(),
                        tint: TaskifyTheme.accent.opacity(0.72),
                        fallbackFill: TaskifyTheme.accent
                    )
            }
            .buttonStyle(.plain)
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("Add task to \(destinationName) and close keyboard")
        }
    }
}

private struct QuickAddTextField: UIViewRepresentable {
    @Binding var text: String
    var isFocused: FocusState<Bool>.Binding
    let accessibilityLabel: String
    let onSubmit: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.delegate = context.coordinator
        field.addTarget(
            context.coordinator,
            action: #selector(Coordinator.textChanged(_:)),
            for: .editingChanged
        )
        field.placeholder = "New Task"
        field.font = .preferredFont(forTextStyle: .body)
        field.textColor = .white
        field.tintColor = UIColor(TaskifyTheme.accent)
        field.backgroundColor = .clear
        field.clearButtonMode = .never
        field.autocapitalizationType = .sentences
        field.autocorrectionType = .default
        field.returnKeyType = .default
        field.enablesReturnKeyAutomatically = true
        field.accessibilityLabel = accessibilityLabel
        // Without this, the field's intrinsic width grows with its text (UITextField resists
        // compression by default), so a long title pushes the capsule wider than the screen
        // instead of scrolling its visible portion to track the cursor.
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }

    static func dismantleUIView(_ uiView: UITextField, coordinator: Coordinator) {
        coordinator.removeKeyboardDismissalGesture()
    }

    func updateUIView(_ field: UITextField, context: Context) {
        context.coordinator.parent = self
        field.accessibilityLabel = accessibilityLabel
        if field.text != text {
            field.text = text
        }
        if isFocused.wrappedValue {
            context.coordinator.hasSynchronizedFocus = true
            if !field.isFirstResponder {
                field.becomeFirstResponder()
            }
        } else if context.coordinator.hasSynchronizedFocus, field.isFirstResponder {
            context.coordinator.hasSynchronizedFocus = false
            field.resignFirstResponder()
        }
    }

    final class Coordinator: NSObject, UITextFieldDelegate, UIGestureRecognizerDelegate {
        var parent: QuickAddTextField
        var hasSynchronizedFocus = false
        // The floating field sits outside the task scroll views, and an empty scroll view has no
        // draggable content. Observe the active window so swipe-down works on populated and empty
        // boards.
        private weak var activeField: UITextField?
        private weak var gestureWindow: UIWindow?
        private lazy var keyboardDismissalPan: UIPanGestureRecognizer = {
            let gesture = UIPanGestureRecognizer(
                target: self,
                action: #selector(handleKeyboardDismissalPan(_:))
            )
            gesture.cancelsTouchesInView = false
            gesture.delegate = self
            return gesture
        }()

        init(parent: QuickAddTextField) {
            self.parent = parent
        }

        @objc func textChanged(_ field: UITextField) {
            parent.text = field.text ?? ""
        }

        func textFieldDidBeginEditing(_ textField: UITextField) {
            parent.isFocused.wrappedValue = true
            installKeyboardDismissalGesture(for: textField)
        }

        func textFieldDidEndEditing(_ textField: UITextField) {
            parent.isFocused.wrappedValue = false
            removeKeyboardDismissalGesture()
        }

        func textFieldShouldReturn(_ textField: UITextField) -> Bool {
            parent.onSubmit()
            return false
        }

        private func installKeyboardDismissalGesture(for field: UITextField) {
            guard let window = field.window else {
                DispatchQueue.main.async { [weak self, weak field] in
                    guard let self, let field, field.isFirstResponder else { return }
                    self.installKeyboardDismissalGesture(for: field)
                }
                return
            }

            if gestureWindow === window {
                activeField = field
                return
            }

            removeKeyboardDismissalGesture()
            activeField = field
            gestureWindow = window
            window.addGestureRecognizer(keyboardDismissalPan)
        }

        func removeKeyboardDismissalGesture() {
            gestureWindow?.removeGestureRecognizer(keyboardDismissalPan)
            gestureWindow = nil
            activeField = nil
        }

        @objc private func handleKeyboardDismissalPan(_ gesture: UIPanGestureRecognizer) {
            guard gesture.state == .changed else { return }
            let translation = gesture.translation(in: gestureWindow)
            guard translation.y > 30 else { return }
            guard abs(translation.y) > abs(translation.x) else { return }

            parent.isFocused.wrappedValue = false
            activeField?.resignFirstResponder()
        }

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard activeField?.isFirstResponder == true else { return false }
            guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return false }
            let velocity = pan.velocity(in: gestureWindow)
            return velocity.y > abs(velocity.x)
        }

        /// The gesture is on the window, so without this it also sees touches inside any sheet
        /// presented above the board — e.g. the task editor. A drag that begins on a text field
        /// anywhere (this one or a completely different field in a presented sheet) is a cursor
        /// placement or text-selection gesture, never a request to dismiss the keyboard, even if
        /// this field is still first responder in the background. Regression: that conflict made
        /// dragging to select a title in the task editor sometimes get read as a swipe-to-dismiss,
        /// resigning this field mid-interaction and leaving the editor's own focus/dismiss state
        /// out of sync — closing and reopening the sheet instead of placing the cursor.
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            var view: UIView? = touch.view
            while let current = view {
                if current is UITextField || current is UITextView { return false }
                view = current.superview
            }
            return true
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            true
        }
    }
}

/// Bottom action bar shown while `TaskSelectionController.isActive`, ported from the PWA's
/// `SelectionOverlays.tsx` selection bar. Printing is intentionally not ported — the PWA's
/// "Print" action feeds the fiducial-marker print/scan round-trip system, which is a separate,
/// much larger milestone (see `BibleTrackerView`'s printing note) not built natively yet.
private struct SelectionActionBar: View {
    @Environment(AppModel.self) private var model
    var selection: TaskSelectionController
    let onMove: () -> Void
    let onComplete: () -> Void
    let onDelete: () -> Void

    private var selectedCount: Int { selection.selectedTaskIDs.count }

    private var hasIncompleteSelected: Bool {
        selection.selectedTaskIDs.contains { model.task(withID: $0)?.completed == false }
    }

    var body: some View {
        VStack(spacing: 6) {
            HStack {
                Text(selectedCount > 0 ? "\(selectedCount) selected" : "Select items")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TaskifyTheme.primaryText)
                Spacer()
                Button("Cancel") { selection.exit() }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)

            HStack(spacing: 0) {
                SelectionBarAction(systemName: "xmark", label: "Clear", disabled: selectedCount == 0) {
                    selection.clear()
                }
                SelectionBarAction(systemName: "square.grid.2x2", label: "Move", disabled: selectedCount == 0, action: onMove)
                SelectionBarAction(systemName: "checkmark", label: "Done", disabled: !hasIncompleteSelected, action: onComplete)
                SelectionBarAction(
                    systemName: "trash",
                    label: "Delete",
                    disabled: selectedCount == 0,
                    danger: true,
                    action: onDelete
                )
            }
            .padding(.horizontal, 6)
            .padding(.bottom, 8)
        }
        .taskifyGlass(cornerRadius: 22)
    }
}

private struct SelectionBarAction: View {
    let systemName: String
    let label: String
    var disabled: Bool
    var danger: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Image(systemName: systemName)
                    .font(.system(size: 17, weight: .semibold))
                Text(label)
                    .font(.system(size: 10, weight: .semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .foregroundStyle(disabled ? TaskifyTheme.tertiaryText : (danger ? Color.red : TaskifyTheme.primaryText))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }
}

/// Board/column picker for the selection bar's "Move" action, ported from `SelectionOverlays.tsx`.
/// List boards with more than one list, week boards (always 7 weekday columns), and compound
/// boards all drill into a column picker; a single-column list board moves directly.
private struct SelectionMoveSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    var selection: TaskSelectionController
    let onMoved: () -> Void

    private struct ColumnTarget: Identifiable {
        let id: String
        let boardID: String
        let boardName: String
        let columnID: String
        let columnName: String
    }

    @State private var drilledInBoard: Board?

    private var eligibleBoards: [Board] {
        model.visibleBoards.filter { $0.kind != .bible }
    }

    var body: some View {
        NavigationStack {
            List {
                if let drilledInBoard {
                    ForEach(columnTargets(for: drilledInBoard)) { target in
                        Button {
                            move(toBoardID: target.boardID, columnID: target.columnID)
                        } label: {
                            HStack {
                                Text(target.columnName)
                                    .foregroundStyle(TaskifyTheme.primaryText)
                                if target.boardID != drilledInBoard.id {
                                    Spacer()
                                    Text(target.boardName)
                                        .font(.caption)
                                        .foregroundStyle(TaskifyTheme.secondaryText)
                                }
                            }
                        }
                    }
                } else if selection.selectedTaskIDs.isEmpty {
                    Text("Select one or more items to move.")
                        .foregroundStyle(TaskifyTheme.secondaryText)
                } else {
                    ForEach(eligibleBoards) { board in
                        Button {
                            handleSelect(board)
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(board.name)
                                        .foregroundStyle(TaskifyTheme.primaryText)
                                    Text(board.kind.rawValue.capitalized)
                                        .font(.caption)
                                        .foregroundStyle(TaskifyTheme.secondaryText)
                                }
                                Spacer()
                                if needsDrillIn(board) {
                                    Image(systemName: "chevron.right")
                                        .font(.caption2)
                                        .foregroundStyle(TaskifyTheme.tertiaryText)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle(drilledInBoard == nil ? "Move selected items" : "Choose a list")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if drilledInBoard != nil {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Back") { drilledInBoard = nil }
                    }
                } else {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                }
            }
        }
    }

    private func needsDrillIn(_ board: Board) -> Bool {
        switch board.kind {
        case .list: return board.columns.count > 1
        case .week, .compound: return true
        case .bible: return false
        }
    }

    private func handleSelect(_ board: Board) {
        if needsDrillIn(board) {
            drilledInBoard = board
        } else if let columnID = board.columns.first?.id {
            move(toBoardID: board.id, columnID: columnID)
        }
    }

    private func columnTargets(for board: Board) -> [ColumnTarget] {
        if board.kind == .compound {
            return model.compoundChildBoards(for: board.id).flatMap { child in
                child.columns.sorted { $0.order < $1.order }.map { column in
                    ColumnTarget(
                        id: "\(child.id)::\(column.id)",
                        boardID: child.id,
                        boardName: child.name,
                        columnID: column.id,
                        columnName: column.name
                    )
                }
            }
        }
        return board.columns
            .sorted { $0.order < $1.order }
            .map { column in
                ColumnTarget(
                    id: column.id,
                    boardID: board.id,
                    boardName: board.name,
                    columnID: column.id,
                    columnName: column.name
                )
            }
    }

    private func move(toBoardID boardID: String, columnID: String) {
        model.moveTasks(selection.selectedTaskIDs, toBoardID: boardID, columnID: columnID)
        dismiss()
        onMoved()
    }
}

private struct BoardShareSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    let board: Board

    @State private var shareMode = ShareMode.board
    @State private var copied = false
    @State private var templateShare: BoardTemplateShareResult?
    @State private var templateError: String?
    @State private var isGeneratingTemplate = false
    @State private var requestedTemplate = false
    @State private var recipient = ""
    @State private var isSendingToContact = false
    @State private var sendErrorMessage: String?
    @State private var sentToRecipientName: String?

    private enum ShareMode: String, CaseIterable, Identifiable {
        case board = "Board"
        case template = "Template"

        var id: String { rawValue }
    }

    private var activeShareBoard: Board? {
        switch shareMode {
        case .board: board
        case .template: templateShare?.board
        }
    }

    private var sharePayload: String? {
        guard let activeShareBoard else { return nil }
        return (try? BoardShareContract.encode(board: activeShareBoard))
            ?? activeShareBoard.effectiveNostrBoardID
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    Picker("Share mode", selection: $shareMode) {
                        ForEach(ShareMode.allCases) { mode in
                            Text(mode.rawValue).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)

                    VStack(spacing: 5) {
                        Label(
                            shareMode == .board ? "Live board" : "Independent copy",
                            systemImage: shareMode == .board
                                ? "arrow.triangle.2.circlepath"
                                : "square.on.square"
                        )
                            .font(.caption.weight(.bold))
                            .foregroundStyle(TaskifyTheme.accent)
                        Text(
                            shareMode == .board
                                ? "Changes remain synced for everyone who joins this board."
                                : "Creates a snapshot with a new board ID. Future changes won't sync between the two boards."
                        )
                            .font(.caption)
                            .foregroundStyle(TaskifyTheme.secondaryText)
                            .multilineTextAlignment(.center)
                    }

                    if let sharePayload {
                        Button(action: copyBoardID) {
                            VStack(spacing: 11) {
                                TaskifyQRCode(value: sharePayload)
                                    .frame(width: 250, height: 250)
                                    .padding(10)
                                    .background(.white, in: RoundedRectangle(cornerRadius: 22, style: .continuous))

                                Label(copied ? "Board ID copied" : "Tap QR to copy board ID", systemImage: copied ? "checkmark" : "doc.on.doc")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(copied ? TaskifyTheme.accent : TaskifyTheme.secondaryText)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(copied ? "Board ID copied" : "Copy board ID")
                    } else {
                        VStack(spacing: 14) {
                            if isGeneratingTemplate {
                                ProgressView()
                                    .controlSize(.large)
                                    .tint(TaskifyTheme.accent)
                                Text("Creating a template snapshot…")
                            } else {
                                Image(systemName: "exclamationmark.arrow.triangle.2.circlepath")
                                    .font(.system(size: 34, weight: .medium))
                                Text(templateError ?? "The template isn't ready yet.")
                                Button("Try again", action: generateTemplate)
                                    .buttonStyle(.bordered)
                            }
                        }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .multilineTextAlignment(.center)
                        .frame(width: 270, height: 270)
                        .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 22).stroke(TaskifyTheme.border, lineWidth: 1))
                    }

                    if let templateShare, shareMode == .template {
                        Label(templateStatus(templateShare), systemImage: templateShare.failedTaskCount == 0 ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(templateShare.failedTaskCount == 0 ? Color.green : Color.orange)
                            .multilineTextAlignment(.center)
                    }

                    if let activeShareBoard {
                        VStack(alignment: .leading, spacing: 7) {
                            Text(shareMode == .board ? "BOARD ID" : "TEMPLATE BOARD ID")
                                .font(.system(size: 10, weight: .bold))
                                .tracking(1.2)
                                .foregroundStyle(TaskifyTheme.tertiaryText)
                            Text(activeShareBoard.effectiveNostrBoardID)
                                .font(.caption.monospaced())
                                .foregroundStyle(TaskifyTheme.primaryText)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(14)
                        .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 17).stroke(TaskifyTheme.border, lineWidth: 1))
                    }

                    if let sharePayload {
                        HStack(spacing: 10) {
                            Button(action: copyBoardID) {
                                Label(copied ? "Copied" : "Copy ID", systemImage: copied ? "checkmark" : "doc.on.doc")
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 48)
                            }
                            .buttonStyle(.bordered)

                            ShareLink(
                                item: sharePayload,
                                subject: Text(shareSubject),
                                preview: SharePreview(shareSubject)
                            ) {
                                Label("Share", systemImage: "square.and.arrow.up")
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 48)
                            }
                            .buttonStyle(.borderedProminent)
                        }
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Relays")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(TaskifyTheme.secondaryText)
                        ForEach(board.effectiveRelayURLs, id: \.self) { relay in
                            Label(relay, systemImage: "antenna.radiowaves.left.and.right")
                                .font(.caption.monospaced())
                                .foregroundStyle(TaskifyTheme.tertiaryText)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    if activeShareBoard != nil {
                        sendToContactCard
                    }
                }
                .padding(20)
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Share \(board.name)")
            .navigationBarTitleDisplayMode(.inline)
            .onChange(of: shareMode) { _, mode in
                copied = false
                sendErrorMessage = nil
                sentToRecipientName = nil
                guard mode == .template,
                      templateShare == nil,
                      !requestedTemplate else { return }
                generateTemplate()
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private func copyBoardID() {
        guard let activeShareBoard else { return }
        UIPasteboard.general.string = activeShareBoard.effectiveNostrBoardID
        withAnimation(.snappy) { copied = true }
    }

    private var shareSubject: String {
        shareMode == .board
            ? "Join \(board.name) in Taskify"
            : "Copy \(board.name) in Taskify"
    }

    private func templateStatus(_ result: BoardTemplateShareResult) -> String {
        if result.failedTaskCount > 0 {
            return "Template ready, but \(result.failedTaskCount) task\(result.failedTaskCount == 1 ? "" : "s") could not be added."
        }
        if result.queuedTaskCount == 0 {
            return "Empty template ready to share. Publishing in the background."
        }
        return "Template ready with \(result.queuedTaskCount) task\(result.queuedTaskCount == 1 ? "" : "s"). Publishing in the background."
    }

    private func generateTemplate() {
        guard !isGeneratingTemplate else { return }
        requestedTemplate = true
        templateError = nil
        isGeneratingTemplate = true
        copied = false

        Task { @MainActor in
            do {
                templateShare = try await model.createTemplateShare(for: board.id)
            } catch {
                templateError = error.localizedDescription
            }
            isGeneratingTemplate = false
        }
    }

    private var recipientIsValid: Bool { NostrPublicKey.parse(recipient) != nil }

    private var matchingContacts: [NostrContact] {
        let query = recipient.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty, NostrPublicKey.parse(query) == nil else {
            return model.nostrContacts
        }
        return model.nostrContacts.filter {
            $0.displayName.localizedCaseInsensitiveContains(query) ||
                $0.subtitle.localizedCaseInsensitiveContains(query) ||
                $0.npub.localizedCaseInsensitiveContains(query)
        }
    }

    private var sendToContactCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Send to a contact")
                .font(.caption.weight(.bold))
                .foregroundStyle(TaskifyTheme.secondaryText)

            TextField("npub or public key", text: $recipient, axis: .vertical)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .lineLimit(1...3)
                .font(.system(.callout, design: .monospaced))
                .padding(.horizontal, 14)
                .frame(minHeight: 44)
                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(TaskifyTheme.border, lineWidth: 1))

            if !matchingContacts.isEmpty {
                VStack(spacing: 6) {
                    ForEach(matchingContacts.prefix(6)) { contact in
                        Button {
                            recipient = contact.npub
                            sendErrorMessage = nil
                            sentToRecipientName = nil
                        } label: {
                            HStack(spacing: 10) {
                                NostrContactAvatar(contact: contact, size: 30)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(contact.displayName)
                                        .foregroundStyle(TaskifyTheme.primaryText)
                                    Text(contact.subtitle)
                                        .font(.caption2)
                                        .foregroundStyle(TaskifyTheme.tertiaryText)
                                        .lineLimit(1)
                                }
                                Spacer()
                                if contact.publicKey == NostrPublicKey.parse(recipient)?.hexString {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(TaskifyTheme.accent)
                                }
                            }
                            .padding(.horizontal, 10)
                            .frame(height: 44)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            if let sendErrorMessage {
                Label(sendErrorMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            if let sentToRecipientName {
                Label("Sent to \(sentToRecipientName)", systemImage: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(Color.green)
            }

            Button(action: sendToContact) {
                if isSendingToContact {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .frame(height: 44)
                } else {
                    Text("Send")
                        .frame(maxWidth: .infinity)
                        .frame(height: 44)
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(!recipientIsValid || activeShareBoard == nil || isSendingToContact)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func sendToContact() {
        guard recipientIsValid, let activeShareBoard, !isSendingToContact else { return }
        isSendingToContact = true
        sendErrorMessage = nil
        sentToRecipientName = nil
        let recipientValue = recipient
        Task { @MainActor in
            do {
                try await model.sendSharedBoard(
                    boardID: activeShareBoard.effectiveNostrBoardID,
                    boardName: activeShareBoard.name,
                    relayURLs: activeShareBoard.effectiveRelayURLs,
                    to: recipientValue
                )
                sentToRecipientName = model.nostrContact(
                    publicKey: NostrPublicKey.parse(recipientValue)?.hexString ?? ""
                )?.displayName ?? "contact"
                recipient = ""
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } catch {
                sendErrorMessage = error.localizedDescription
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
            isSendingToContact = false
        }
    }
}

private struct TaskifyQRCode: View {
    let value: String

    private static let context = CIContext()

    var body: some View {
        if let image = image {
            Image(decorative: image, scale: 1)
                .interpolation(.none)
                .resizable()
        } else {
            Image(systemName: "qrcode")
                .resizable()
                .scaledToFit()
                .foregroundStyle(.black)
                .padding(35)
        }
    }

    private var image: CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(value.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 12, y: 12)) else {
            return nil
        }
        return Self.context.createCGImage(output, from: output.extent)
    }
}

/// A jump-to-list navigation card shown as the leading page in a list/compound board's
/// horizontal column scroller, matching the PWA's opt-in "Index" card. It participates in the
/// same view-aligned paging as the columns it lets you jump to.
private struct IndexCardEntry: Identifiable {
    let id: String
    let title: String
}

private struct IndexCardGroup: Identifiable {
    let id: String
    let title: String?
    let entries: [IndexCardEntry]
}

private struct IndexCardColumnView: View {
    let groups: [IndexCardGroup]
    @Binding var focusedPageID: String?

    private var flatEntries: [IndexCardEntry] {
        groups.flatMap(\.entries)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Index")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(TaskifyTheme.secondaryText)

            if flatEntries.isEmpty {
                Text("No lists yet.")
                    .font(.subheadline)
                    .foregroundStyle(TaskifyTheme.secondaryText)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 24)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        ForEach(groups) { group in
                            if let title = group.title {
                                Text(title.uppercased())
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(TaskifyTheme.tertiaryText)
                                    .padding(.top, group.id == groups.first?.id ? 0 : 6)
                                    .padding(.horizontal, 4)
                            }
                            ForEach(group.entries) { entry in
                                indexEntryButton(entry)
                            }
                        }
                    }
                }
                .scrollIndicators(.hidden)
                .scrollDismissesKeyboard(.interactively)
            }
        }
        .padding(10)
        .taskifyGlass(cornerRadius: 22)
    }

    private func indexEntryButton(_ entry: IndexCardEntry) -> some View {
        let order = (flatEntries.firstIndex(where: { $0.id == entry.id }) ?? 0) + 1
        let isActive = focusedPageID == entry.id
        return Button {
            withAnimation(.snappy) {
                focusedPageID = entry.id
            }
        } label: {
            HStack {
                Text(entry.title)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer()
                Text("\(order)")
                    .font(.caption)
            }
            .foregroundStyle(isActive ? TaskifyTheme.primaryText : TaskifyTheme.secondaryText)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(isActive ? TaskifyTheme.accent.opacity(0.15) : TaskifyTheme.raisedFill)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(isActive ? TaskifyTheme.accent.opacity(0.6) : TaskifyTheme.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
}

private let indexCardPageID = "board-index-card"

private struct ListBoardView: View {
    let board: Board
    let showCompleted: Bool
    let sortMode: UpcomingSortMode
    let sortDirection: UpcomingSortDirection
    @Binding var focusedPageID: String?

    private var columns: [BoardColumn] {
        board.columns.sorted {
            if $0.order != $1.order { return $0.order < $1.order }
            return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    private var indexGroups: [IndexCardGroup] {
        [IndexCardGroup(
            id: indexCardPageID,
            title: nil,
            entries: columns.map { IndexCardEntry(id: $0.id, title: $0.name) }
        )]
    }

    var body: some View {
        GeometryReader { proxy in
            ScrollView(.horizontal) {
                LazyHStack(spacing: 16) {
                    if board.indexCardEnabled {
                        IndexCardColumnView(groups: indexGroups, focusedPageID: $focusedPageID)
                            .frame(width: min(330, proxy.size.width - 50))
                            .id(indexCardPageID)
                    }
                    ForEach(columns) { column in
                        ListColumnView(
                            column: column,
                            showCompleted: showCompleted,
                            sortMode: sortMode,
                            sortDirection: sortDirection
                        )
                            .frame(width: min(330, proxy.size.width - 50))
                            .id(column.id)
                    }
                }
                .scrollTargetLayout()
                .padding(.horizontal, 18)
                .padding(.bottom, 10)
            }
            .scrollIndicators(.hidden)
            .scrollTargetBehavior(.viewAligned(limitBehavior: .never))
            .scrollPosition(id: $focusedPageID)
            .horizontalTaskDragAutoScroll(
                pageIDs: columns.map(\.id),
                focusedPageID: $focusedPageID,
                viewportWidth: proxy.size.width
            )
            .onAppear(perform: repairFocusedPage)
            .onChange(of: columns.map(\.id)) { _, _ in repairFocusedPage() }
        }
    }

    private func repairFocusedPage() {
        if board.indexCardEnabled && focusedPageID == indexCardPageID { return }
        guard !columns.contains(where: { $0.id == focusedPageID }) else { return }
        focusedPageID = columns.first?.id
    }
}

private struct CompoundBoardView: View {
    @Environment(AppModel.self) private var model
    let board: Board
    let showCompleted: Bool
    let sortMode: UpcomingSortMode
    let sortDirection: UpcomingSortDirection
    @Binding var focusedPageID: String?

    private var columns: [CompoundColumnReference] {
        model.compoundChildBoards(for: board.id).flatMap { child in
            child.columns
                .sorted {
                    if $0.order != $1.order { return $0.order < $1.order }
                    return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
                }
                .map { CompoundColumnReference(board: child, column: $0) }
        }
    }

    private var indexGroups: [IndexCardGroup] {
        var groups: [IndexCardGroup] = []
        var groupIndexByBoardID: [String: Int] = [:]
        for reference in columns {
            let entry = IndexCardEntry(id: reference.id, title: reference.column.name)
            if let index = groupIndexByBoardID[reference.board.id] {
                groups[index] = IndexCardGroup(
                    id: groups[index].id,
                    title: groups[index].title,
                    entries: groups[index].entries + [entry]
                )
            } else {
                groupIndexByBoardID[reference.board.id] = groups.count
                groups.append(IndexCardGroup(
                    id: reference.board.id,
                    title: board.hideChildBoardNames ? nil : reference.board.name,
                    entries: [entry]
                ))
            }
        }
        return groups
    }

    var body: some View {
        if columns.isEmpty {
            ContentUnavailableView(
                "No linked lists",
                systemImage: "square.stack.3d.up",
                description: Text("Add list boards to this compound board from Settings.")
            )
            .foregroundStyle(TaskifyTheme.secondaryText)
        } else {
            GeometryReader { proxy in
                ScrollView(.horizontal) {
                    LazyHStack(spacing: 16) {
                        if board.indexCardEnabled {
                            IndexCardColumnView(groups: indexGroups, focusedPageID: $focusedPageID)
                                .frame(width: min(330, proxy.size.width - 50))
                                .id(indexCardPageID)
                        }
                        ForEach(columns) { reference in
                            CompoundColumnView(
                                reference: reference,
                                hideBoardName: board.hideChildBoardNames,
                                showCompleted: showCompleted,
                                sortMode: sortMode,
                                sortDirection: sortDirection
                        )
                            .frame(width: min(330, proxy.size.width - 50))
                            .id(reference.id)
                        }
                    }
                    .scrollTargetLayout()
                    .padding(.horizontal, 18)
                    .padding(.bottom, 10)
                }
                .scrollIndicators(.hidden)
                .scrollTargetBehavior(.viewAligned(limitBehavior: .never))
                .scrollPosition(id: $focusedPageID)
                .horizontalTaskDragAutoScroll(
                    pageIDs: columns.map(\.id),
                    focusedPageID: $focusedPageID,
                    viewportWidth: proxy.size.width
                )
                .onAppear(perform: repairFocusedPage)
                .onChange(of: columns.map(\.id)) { _, _ in repairFocusedPage() }
            }
        }
    }

    private func repairFocusedPage() {
        if board.indexCardEnabled && focusedPageID == indexCardPageID { return }
        guard !columns.contains(where: { $0.id == focusedPageID }) else { return }
        focusedPageID = columns.first?.id
    }
}

private struct CompoundColumnReference: Identifiable {
    let board: Board
    let column: BoardColumn

    var id: String { "\(board.id)::\(column.id)" }
}

private struct CompoundColumnView: View {
    @Environment(AppModel.self) private var model
    @Environment(TaskSelectionController.self) private var selection: TaskSelectionController?
    let reference: CompoundColumnReference
    let hideBoardName: Bool
    let showCompleted: Bool
    let sortMode: UpcomingSortMode
    let sortDirection: UpcomingSortDirection

    private var tasks: [TaskItem] {
        let raw = model.tasks(
            boardID: reference.board.id,
            columnID: reference.column.id,
            includeCompleted: showCompleted
        )
        guard sortMode != .manual else { return raw }
        return UpcomingTaskOrganizer.sortBoardTasks(raw, mode: sortMode, direction: sortDirection)
    }

    var body: some View {
        let tasks = tasks

        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 2) {
                    if !hideBoardName {
                        Text(reference.board.name.uppercased())
                            .font(.system(size: 9, weight: .bold))
                            .tracking(1)
                            .foregroundStyle(TaskifyTheme.tertiaryText)
                            .lineLimit(1)
                    }
                    Text(reference.column.name)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .lineLimit(1)
                }

                Spacer()

                Text("\(tasks.count)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TaskifyTheme.tertiaryText)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(TaskifyTheme.raisedFill, in: Capsule())

                Menu {
                    Button {
                        withAnimation(.snappy) {
                            if selection?.isActive == true {
                                selection?.exit()
                            } else {
                                selection?.enter()
                            }
                        }
                    } label: {
                        Label(
                            selection?.isActive == true ? "Exit selection" : "Select tasks",
                            systemImage: selection?.isActive == true ? "xmark.circle" : "checklist"
                        )
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .frame(width: 34, height: 34)
                        .background(TaskifyTheme.raisedFill, in: Circle())
                        .contentShape(Circle())
                }
                .accessibilityLabel("Manage \(reference.column.name) list")
            }

            ScrollView {
                LazyVStack(spacing: 9) {
                    ForEach(tasks) { task in
                        TaskCardView(task: task, allowsDragging: true)
                            .taskDropTarget(
                                boardID: reference.board.id,
                                columnID: reference.column.id,
                                beforeTaskID: task.id,
                                style: .card
                            )
                    }
                }
                .immediateScrollTouchDelivery()
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .contentMargins(.bottom, 76, for: .scrollContent)
        }
        .padding(10)
        .taskifyGlass(cornerRadius: 22)
        .taskDropTarget(
            boardID: reference.board.id,
            columnID: reference.column.id,
            style: .column
        )
    }
}

private struct ListColumnView: View {
    @Environment(AppModel.self) private var model
    @Environment(TaskSelectionController.self) private var selection: TaskSelectionController?
    let column: BoardColumn
    let showCompleted: Bool
    let sortMode: UpcomingSortMode
    let sortDirection: UpcomingSortDirection
    @State private var renameDraft = ""
    @State private var showingRename = false
    @State private var showingDeleteConfirmation = false

    private var tasks: [TaskItem] {
        let raw = model.tasks(forColumnID: column.id, includeCompleted: showCompleted)
        guard sortMode != .manual else { return raw }
        return UpcomingTaskOrganizer.sortBoardTasks(raw, mode: sortMode, direction: sortDirection)
    }

    private var allTasks: [TaskItem] {
        model.tasks(forColumnID: column.id, includeCompleted: true)
    }

    private var orderedColumns: [BoardColumn] {
        guard let board = model.selectedBoard, board.kind == .list else { return [] }
        return board.columns.sorted {
            if $0.order != $1.order { return $0.order < $1.order }
            return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    private var columnIndex: Int? {
        orderedColumns.firstIndex(where: { $0.id == column.id })
    }

    private var moveDestination: BoardColumn? {
        guard let columnIndex else { return nil }
        if columnIndex > 0 { return orderedColumns[columnIndex - 1] }
        let nextIndex = columnIndex + 1
        return orderedColumns.indices.contains(nextIndex) ? orderedColumns[nextIndex] : nil
    }

    var body: some View {
        let tasks = tasks

        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(column.name)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(TaskifyTheme.secondaryText)
                Spacer()
                Text("\(tasks.count)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TaskifyTheme.tertiaryText)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(TaskifyTheme.raisedFill, in: Capsule())

                Menu {
                    Button {
                        withAnimation(.snappy) {
                            if selection?.isActive == true {
                                selection?.exit()
                            } else {
                                selection?.enter()
                            }
                        }
                    } label: {
                        Label(
                            selection?.isActive == true ? "Exit selection" : "Select tasks",
                            systemImage: selection?.isActive == true ? "xmark.circle" : "checklist"
                        )
                    }

                    Divider()

                    Button {
                        renameDraft = column.name
                        showingRename = true
                    } label: {
                        Label("Rename list", systemImage: "pencil")
                    }

                    Divider()

                    Button {
                        withAnimation(.snappy) {
                            _ = model.moveListColumn(columnID: column.id, direction: -1)
                        }
                    } label: {
                        Label("Move left", systemImage: "arrow.left")
                    }
                    .disabled(columnIndex == 0)

                    Button {
                        withAnimation(.snappy) {
                            _ = model.moveListColumn(columnID: column.id, direction: 1)
                        }
                    } label: {
                        Label("Move right", systemImage: "arrow.right")
                    }
                    .disabled(columnIndex == nil || columnIndex == orderedColumns.count - 1)

                    Divider()

                    Button(role: .destructive) {
                        showingDeleteConfirmation = true
                    } label: {
                        Label("Delete list", systemImage: "trash")
                    }
                    .disabled(orderedColumns.count <= 1)
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .frame(width: 34, height: 34)
                        .background(TaskifyTheme.raisedFill, in: Circle())
                        .contentShape(Circle())
                }
                .accessibilityLabel("Manage \(column.name) list")
            }

            ScrollView {
                LazyVStack(spacing: 9) {
                    ForEach(tasks) { task in
                        TaskCardView(task: task, allowsDragging: true)
                            .taskDropTarget(
                                boardID: model.selectedBoardID,
                                columnID: column.id,
                                beforeTaskID: task.id,
                                style: .card
                            )
                    }
                }
                .immediateScrollTouchDelivery()
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .contentMargins(.bottom, 76, for: .scrollContent)
        }
        .padding(10)
        .taskifyGlass(cornerRadius: 22)
        .taskDropTarget(
            boardID: model.selectedBoardID,
            columnID: column.id,
            style: .column
        )
        .alert("Rename list", isPresented: $showingRename) {
            TextField("List name", text: $renameDraft)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                _ = model.renameListColumn(columnID: column.id, name: renameDraft)
            }
            .disabled(renameDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: {
            Text("The new name will sync with everyone sharing this board.")
        }
        .confirmationDialog(
            "Delete \(column.name)?",
            isPresented: $showingDeleteConfirmation,
            titleVisibility: .visible
        ) {
            if let moveDestination, !allTasks.isEmpty {
                Button("Move \(taskCountLabel) to \(moveDestination.name)") {
                    _ = model.removeListColumn(
                        columnID: column.id,
                        moveTasksTo: moveDestination.id
                    )
                }
            }

            Button(
                allTasks.isEmpty ? "Delete empty list" : "Delete list and \(taskCountLabel)",
                role: .destructive
            ) {
                _ = model.removeListColumn(columnID: column.id, moveTasksTo: nil)
            }

            Button("Cancel", role: .cancel) {}
        } message: {
            if allTasks.isEmpty {
                Text("This removes the list from the shared board.")
            } else {
                Text("Choose whether to keep its tasks or delete them. This change syncs to everyone sharing the board.")
            }
        }
    }

    private var taskCountLabel: String {
        "\(allTasks.count) task\(allTasks.count == 1 ? "" : "s")"
    }
}

private struct WeekBoardView: View {
    @Environment(AppModel.self) private var model
    let showCompleted: Bool
    let sortMode: UpcomingSortMode
    let sortDirection: UpcomingSortDirection
    @Binding var focusedPageID: String?

    private var orderedWeekdays: [WeekdayColumn] {
        WeekdayColumn.ordered(startingAt: model.weekStart)
    }

    var body: some View {
        GeometryReader { proxy in
            ScrollView(.horizontal) {
                LazyHStack(spacing: 16) {
                    ForEach(orderedWeekdays) { weekday in
                        DayColumnView(
                            weekday: weekday,
                            showCompleted: showCompleted,
                            sortMode: sortMode,
                            sortDirection: sortDirection
                        )
                            .frame(width: min(330, proxy.size.width - 50))
                            .id(weekday.rawValue)
                    }
                }
                .scrollTargetLayout()
                .padding(.horizontal, 18)
                .padding(.bottom, 10)
            }
            .scrollIndicators(.hidden)
            .scrollTargetBehavior(.viewAligned(limitBehavior: .never))
            .scrollPosition(id: $focusedPageID)
            .horizontalTaskDragAutoScroll(
                pageIDs: orderedWeekdays.map(\.rawValue),
                focusedPageID: $focusedPageID,
                viewportWidth: proxy.size.width
            )
            .onAppear {
                guard WeekdayColumn(rawValue: focusedPageID ?? "") == nil else { return }
                focusedPageID = WeekdayColumn.containing(Date()).rawValue
            }
        }
    }
}

private struct DayColumnView: View {
    @Environment(AppModel.self) private var model
    @Environment(TaskSelectionController.self) private var selection: TaskSelectionController?
    let weekday: WeekdayColumn
    let showCompleted: Bool
    let sortMode: UpcomingSortMode
    let sortDirection: UpcomingSortDirection

    private var tasks: [TaskItem] {
        let raw = model.tasks(for: weekday, includeCompleted: showCompleted)
        guard sortMode != .manual else { return raw }
        return UpcomingTaskOrganizer.sortBoardTasks(raw, mode: sortMode, direction: sortDirection)
    }

    var body: some View {
        let tasks = tasks

        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(weekday.shortName)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(TaskifyTheme.secondaryText)
                Spacer()
                Menu {
                    Button {
                        withAnimation(.snappy) {
                            if selection?.isActive == true {
                                selection?.exit()
                            } else {
                                selection?.enter()
                            }
                        }
                    } label: {
                        Label(
                            selection?.isActive == true ? "Exit selection" : "Select tasks",
                            systemImage: selection?.isActive == true ? "xmark.circle" : "checklist"
                        )
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .frame(width: 30, height: 30)
                }
            }

            ScrollView {
                LazyVStack(spacing: 9) {
                    ForEach(tasks) { task in
                        TaskCardView(task: task, allowsDragging: true)
                            .taskDropTarget(
                                boardID: model.selectedBoardID,
                                columnID: weekday.rawValue,
                                beforeTaskID: task.id,
                                style: .card
                            )
                    }
                }
                .immediateScrollTouchDelivery()
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .contentMargins(.bottom, 76, for: .scrollContent)
        }
        .padding(10)
        .taskifyGlass(cornerRadius: 22)
        .taskDropTarget(
            boardID: model.selectedBoardID,
            columnID: weekday.rawValue,
            style: .column
        )
    }
}

struct TaskCardView: View {
    @Environment(AppModel.self) private var model
    // Optional: only Boards' own board content injects a TaskSelectionController (via
    // `.environment(selection)` in BoardsView.body). TaskCardView is also used from Upcoming and
    // a couple of other spots that never enter selection mode, so this must tolerate being nil
    // rather than requiring every call site to provide one.
    @Environment(TaskSelectionController.self) private var selection: TaskSelectionController?
    @Environment(TaskCompletionAnimationController.self)
    private var completionAnimations: TaskCompletionAnimationController?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(TaskPresentationSettings.completedTabKey)
    private var completedTabEnabled = TaskPresentationSettings.completedTabDefault
    @AppStorage(TaskPresentationSettings.hideCompletedSubtasksKey)
    private var hideCompletedSubtasks = TaskPresentationSettings.hideCompletedSubtasksDefault
    let task: TaskItem
    let allowsDragging: Bool
    @State private var showingEditor = false
    @State private var showingTaskShare = false
    @State private var taskShareMode: TaskShareMode = .share
    @State private var confirmingRecurringDeletion = false

    init(task: TaskItem, allowsDragging: Bool = false) {
        self.task = task
        self.allowsDragging = allowsDragging
    }

    private var subtaskProgress: String? {
        guard let subtasks = task.subtasks, !subtasks.isEmpty else { return nil }
        return "\(subtasks.filter(\.completed).count)/\(subtasks.count)"
    }

    private var visibleSubtasks: [TaskSubtask] {
        let subtasks = task.subtasks ?? []
        return hideCompletedSubtasks ? subtasks.filter { !$0.completed } : subtasks
    }

    /// Streaks are tracked for any "frequent" recurrence (daily/weekly, or every N days/weeks —
    /// see `TaskifySnapshot.toggleCompletion`), but only *displayed* for the simple daily/weekly
    /// cases, matching the PWA's narrower badge condition.
    private var visibleStreak: Int? {
        switch task.recurrence {
        case .daily, .weekly:
            break
        default:
            return nil
        }
        guard let streak = task.streak, streak > 0 else { return nil }
        return streak
    }

    private var mediaBoardID: String {
        model.board(withID: task.boardID)?.effectiveNostrBoardID ?? task.boardID
    }

    private var hasMedia: Bool {
        !(task.images ?? []).isEmpty ||
            !(task.documents ?? []).isEmpty ||
            TaskContentLinks.firstURL(title: task.title, note: task.note) != nil
    }

    private var displayTitle: String {
        guard TaskContentLinks.isURLOnly(task.title),
              let url = TaskContentLinks.firstURL(title: task.title, note: "") else {
            return task.title
        }
        return TaskContentLinks.fallbackTitle(for: url)
    }

    private var displayNote: String {
        TaskContentLinks.removingURLs(from: task.note)
    }

    var body: some View {
        // Hoisted once per body evaluation: these are all plain computed properties (not
        // memoized by Swift), and several run regex matching over the title/note
        // (`hasMedia`/`displayTitle`/`displayNote` via `TaskContentLinks`). The old code read
        // them directly at each use site, re-running that work up to 7x per row per frame
        // during scroll.
        let hasMedia = hasMedia
        let displayTitle = displayTitle
        let displayNote = displayNote
        let subtaskProgress = subtaskProgress
        let visibleSubtasks = visibleSubtasks
        let visibleStreak = visibleStreak
        let cardCornerRadius = hasMedia ? CGFloat(24) : 18
        let isSelectionMode = selection?.isActive ?? false
        let isSelected = selection?.selectedTaskIDs.contains(task.id) ?? false

        return VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 11) {
                GeometryReader { proxy in
                    Button {
                        if isSelectionMode {
                            selection?.toggle(task.id)
                        } else {
                            // Touch-up, and the only path VoiceOver takes. Deduplicated against
                            // the touch-down fire inside `handleCompletionTap`.
                            handleCompletionTap(origin: proxy.flightOrigin)
                        }
                    } label: {
                        Image(systemName: isSelectionMode
                            ? (isSelected ? "checkmark.circle.fill" : "circle")
                            : (task.completed ? "checkmark.circle.fill" : "circle"))
                            .font(.system(size: 22, weight: .medium))
                            .foregroundStyle((isSelectionMode ? isSelected : task.completed)
                                ? TaskifyTheme.accent : TaskifyTheme.secondaryText)
                            .contentTransition(.symbolEffect(.replace))
                            .frame(width: 30, height: 30)
                    }
                    .buttonStyle(TaskCompletionToggleButtonStyle {
                        handleCompletionPressDown(origin: proxy.flightOrigin,
                                                  isSelectionMode: isSelectionMode)
                    })
                    .accessibilityLabel(isSelectionMode
                        ? (isSelected ? "Deselect task" : "Select task")
                        : (task.completed ? "Mark incomplete" : "Complete task"))
                }
                .frame(width: 30, height: 30)

                Button {
                    if isSelectionMode {
                        selection?.toggle(task.id)
                    } else {
                        showingEditor = true
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(displayTitle)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(task.completed ? TaskifyTheme.tertiaryText : TaskifyTheme.primaryText)
                            .strikethrough(task.completed)
                            .frame(maxWidth: .infinity, alignment: .leading)

                        if !displayNote.isEmpty {
                            Text(displayNote)
                                .font(.caption)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                                .lineLimit(2)
                        }

                        if task.priority != nil || (task.dueDateEnabled && task.dueDate != nil) ||
                            subtaskProgress != nil || task.recurrence != nil || !(task.reminders ?? []).isEmpty ||
                            !task.sharedTaskAssignees.isEmpty || visibleStreak != nil {
                            HStack(spacing: 9) {
                                if let priority = task.priority {
                                    Text(String(repeating: "!", count: priority.rawValue))
                                        .font(.caption.bold())
                                        .foregroundStyle(priority.cardColor)
                                        .accessibilityLabel("\(priority.cardLabel) priority")
                                }

                                if task.dueDateEnabled, let dueDate = task.dueDate {
                                    Label {
                                        Text(formattedDueDate(dueDate))
                                    } icon: {
                                        Image(systemName: task.dueTimeEnabled ? "clock" : "calendar")
                                    }
                                    .font(.caption)
                                    .foregroundStyle(TaskifyTheme.secondaryText)
                                }

                                if let subtaskProgress {
                                    Label(subtaskProgress, systemImage: "checklist")
                                        .font(.caption)
                                        .foregroundStyle(TaskifyTheme.secondaryText)
                                }

                                if task.recurrence != nil {
                                    Image(systemName: "repeat")
                                        .font(.caption)
                                        .foregroundStyle(TaskifyTheme.secondaryText)
                                        .accessibilityLabel("Repeating task")
                                }

                                if let visibleStreak {
                                    Label {
                                        Text("\(visibleStreak)")
                                    } icon: {
                                        Text("\u{1F525}")
                                    }
                                    .font(.caption)
                                    .foregroundStyle(TaskifyTheme.secondaryText)
                                    .accessibilityLabel("\(visibleStreak) \(visibleStreak == 1 ? "completion" : "completions") streak")
                                }

                                if !(task.reminders ?? []).isEmpty {
                                    Image(systemName: "bell.fill")
                                        .font(.caption)
                                        .foregroundStyle(TaskifyTheme.secondaryText)
                                        .accessibilityLabel("Reminder set")
                                }

                                if !task.sharedTaskAssignees.isEmpty {
                                    let hasPending = task.sharedTaskAssignees.contains {
                                        $0.status == nil || $0.status == .pending
                                    }
                                    Label(
                                        "\(task.sharedTaskAssignees.count)",
                                        systemImage: hasPending ? "person.badge.clock" : "person.badge.checkmark"
                                    )
                                    .font(.caption)
                                    .foregroundStyle(hasPending ? TaskifyTheme.secondaryText : TaskifyTheme.accent)
                                    .accessibilityLabel(
                                        "\(task.sharedTaskAssignees.count) assignee\(task.sharedTaskAssignees.count == 1 ? "" : "s")"
                                    )
                                }
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityLabel("Edit \(displayTitle)")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .zIndex(1)

            if hasMedia {
                TaskMediaView(task: task, boardID: mediaBoardID, compact: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .clipped()
                    .contentShape(Rectangle())
                    .zIndex(0)
            }

            if !visibleSubtasks.isEmpty {
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(visibleSubtasks) { subtask in
                        Button {
                            TaskCompletionHaptics.subtaskToggled()
                            model.toggleSubtaskCompletion(
                                taskID: task.id,
                                subtaskID: subtask.id
                            )
                        } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Image(systemName: subtask.completed ? "checkmark.square.fill" : "square")
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(
                                        subtask.completed
                                            ? TaskifyTheme.accent
                                            : TaskifyTheme.secondaryText
                                    )
                                    .contentTransition(.symbolEffect(.replace))

                                Text(subtask.title)
                                    .font(.caption)
                                    .foregroundStyle(
                                        subtask.completed
                                            ? TaskifyTheme.tertiaryText
                                            : TaskifyTheme.secondaryText
                                    )
                                    .strikethrough(subtask.completed)
                                    .multilineTextAlignment(.leading)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(
                            subtask.completed
                                ? "Mark \(subtask.title) incomplete"
                                : "Complete \(subtask.title)"
                        )
                    }
                }
                .padding(.leading, 41)
                .padding(.trailing, 3)
            }
        }
        .allowsHitTesting(!isSelectionMode)
        .padding(.horizontal, hasMedia ? 10 : 13)
        .padding(.vertical, hasMedia ? 10 : 12)
        .background(
            LinearGradient(
                colors: [Color.white.opacity(0.13), Color.white.opacity(0.035)],
                startPoint: .top,
                endPoint: .bottom
            ),
            in: RoundedRectangle(cornerRadius: cardCornerRadius, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: cardCornerRadius, style: .continuous)
                .stroke(
                    isSelected ? TaskifyTheme.accent : Color.white.opacity(hasMedia ? 0.15 : 0.12),
                    lineWidth: isSelected ? 2 : 1
                )
        )
        .overlay {
            if isSelectionMode {
                Button {
                    selection?.toggle(task.id)
                } label: {
                    Color.clear
                        .contentShape(RoundedRectangle(cornerRadius: cardCornerRadius, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isSelected ? "Deselect \(displayTitle)" : "Select \(displayTitle)")
            }
        }
        .shadow(color: Color.black.opacity(0.22), radius: 8, y: 5)
        .contentShape(RoundedRectangle(cornerRadius: cardCornerRadius, style: .continuous))
        .modifier(TaskDragSourceModifier(
            payload: (allowsDragging && !isSelectionMode) ? TaskDragPayload(taskID: task.id) : nil,
            title: displayTitle
        ))
        .accessibilityAction(named: isSelectionMode ? "Toggle selection" : "Edit task") {
            if isSelectionMode {
                selection?.toggle(task.id)
            } else {
                showingEditor = true
            }
        }
        .contextMenu {
            if !isSelectionMode {
                Button {
                    showingEditor = true
                } label: {
                    Label("Edit", systemImage: "pencil")
                }
                Button {
                    taskShareMode = .share
                    showingTaskShare = true
                } label: {
                    Label("Share Task", systemImage: "paperplane")
                }
                Button {
                    taskShareMode = .assignment
                    showingTaskShare = true
                } label: {
                    Label("Assign Task", systemImage: "person.badge.plus")
                }
                if task.dueDateEnabled, task.dueDate != nil {
                    Button {
                        model.postponeTask(task.id, byDays: 1)
                    } label: {
                        Label("Postpone 1 Day", systemImage: "calendar.badge.clock")
                    }
                    Button {
                        model.postponeTask(task.id, byDays: 7)
                    } label: {
                        Label("Postpone 1 Week", systemImage: "calendar.badge.clock")
                    }
                }
                Button(role: .destructive) {
                    if task.recurrence?.isActive == true {
                        confirmingRecurringDeletion = true
                    } else {
                        model.deleteTask(task.id, scope: .single)
                    }
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
        }
        .confirmationDialog(
            "Delete recurring task?",
            isPresented: $confirmingRecurringDeletion,
            titleVisibility: .visible
        ) {
            Button("Delete This Task", role: .destructive) {
                model.deleteTask(task.id, scope: .single)
            }
            Button("Delete This and Future Tasks", role: .destructive) {
                model.deleteTask(task.id, scope: .thisAndFuture)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Choose whether to delete only this occurrence or end the recurring series here.")
        }
        .sheet(isPresented: $showingEditor) {
            TaskEditorView(task: task)
                .environment(model)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showingTaskShare) {
            TaskShareSheet(taskID: task.id, initialMode: taskShareMode)
                .environment(model)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    private func formattedDueDate(_ dueDate: Date) -> String {
        var style = Date.FormatStyle()
            .month(.abbreviated)
            .day()
        if task.dueTimeEnabled {
            style = style.hour().minute()
        }
        if task.dueTimeEnabled,
           let dueTimeZone = task.dueTimeZone,
           let timeZone = TimeZone(identifier: dueTimeZone) {
            style.timeZone = timeZone
        }
        return dueDate.formatted(style)
    }

    /// Touch-down path: this is what makes a check-off feel instant. Skipped in selection mode
    /// (selection stays a deliberate touch-up action) and while the list is coasting, in which
    /// case the touch-up below still completes the task — a skipped early fire costs a little
    /// latency, never the tap itself.
    private func handleCompletionPressDown(origin: CGPoint, isSelectionMode: Bool) {
        guard !isSelectionMode, !BoardScrollActivity.isMoving else { return }
        handleCompletionTap(origin: origin)
    }

    private func handleCompletionTap(origin: CGPoint) {
        // Touch-down and touch-up can both reach here for one physical tap, and `isPressed` can
        // cycle more than once within a single press. Collapsing them by task id keeps the
        // toggle idempotent per tap without any cross-interaction state to leak — the earlier
        // "did the press already fire?" flag could never be cleared reliably, because completing
        // a task re-renders the row and tears the button down before its action ever runs, so a
        // stale flag went on to swallow the *next* real tap.
        guard CompletionTapCoalescer.shouldHandle(taskID: task.id) else { return }

        if task.completed {
            withAnimation(.snappy) {
                model.toggleCompletion(task.id)
            }
            return
        }

        TaskCompletionHaptics.completed()
        if completedTabEnabled, !reduceMotion {
            completionAnimations?.launch(from: origin)
        }
        // Deliberately *not* wrapped in `withAnimation`: the row must vanish on this runloop
        // turn so a rapid second tap lands on the next task's checkbox rather than on a row
        // that is still animating out (see `testRapidCompletionRemovesEachTaskBeforeTheNextTap`).
        // The flight dot carries the visual continuity instead.
        model.toggleCompletion(task.id)
    }
}

/// Reuses one prepared generator. Allocating a generator per tap spins the haptic engine up from
/// cold each time, which costs main-thread time on exactly the taps that need to stay cheap — a
/// burst of rapid check-offs.
///
/// A `.rigid` impact rather than the previous `.success` notification: the notification pattern is
/// two pulses with a gap between them, so the confirmation you feel arrives well after the tap and
/// smears together when several tasks are checked off quickly. A single crisp pulse lands with the
/// finger.
@MainActor
private enum TaskCompletionHaptics {
    private static let generator = UIImpactFeedbackGenerator(style: .rigid)
    private static let subtaskGenerator = UISelectionFeedbackGenerator()

    static func completed() {
        generator.impactOccurred()
        // Keeps the engine warm for the next check-off in a burst.
        generator.prepare()
    }

    /// The Taptic engine idles down after a couple of seconds, and playing on a cold engine adds
    /// its own lag to the very taps that should feel immediate. Warm it when the board appears.
    static func warmUp() {
        generator.prepare()
        subtaskGenerator.prepare()
    }

    static func subtaskToggled() {
        subtaskGenerator.selectionChanged()
        subtaskGenerator.prepare()
    }
}

private extension TaskPriority {
    var cardColor: Color {
        switch self {
        case .low: Color.blue
        case .medium: Color.orange
        case .high: Color.red
        }
    }

    var cardLabel: String {
        switch self {
        case .low: "Low"
        case .medium: "Medium"
        case .high: "High"
        }
    }
}
