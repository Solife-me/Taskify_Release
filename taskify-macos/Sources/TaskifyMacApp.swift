import AppKit
import SwiftUI
import TaskifyCore

@MainActor
final class MacRuntime: ObservableObject {
    let model: AppModel
    let bible = BibleTrackerStore()
    let calendar = DeviceCalendarStore()
    let wallet = WalletViewModel()
    private var started = false
    private var dayChangeObservers: [NSObjectProtocol] = []

    init() {
#if DEBUG
        if Bundle.main.object(forInfoDictionaryKey: "TaskifyMacPreview") as? Bool == true {
            setenv("TASKIFY_MAC_PREVIEW", "1", 1)
            setenv("TASKIFY_UI_TEST_CHAT_FIXTURE", "1", 1)
            setenv("TASKIFY_UI_TEST_CHAT_LOCAL_SENDS", "1", 1)
            setenv("TASKIFY_UI_TEST_CHAT_COUNT", "40", 1)
            setenv("TASKIFY_UI_TEST_ONBOARDING", "skip", 1)
        }
        if ProcessInfo.processInfo.environment["TASKIFY_MAC_PREVIEW"] == "1" {
            let path = Bundle.main.object(forInfoDictionaryKey: "TaskifyMacPreviewStore") as? String
                ?? FileManager.default.temporaryDirectory.appendingPathComponent("taskify-mac-preview.json").path
            let file = URL(fileURLWithPath: path)
            model = AppModel(store: JSONTaskStore(fileURL: file),
                             syncEngine: TaskSyncEngine(outbox: NostrOutboxStore(fileURL: file.appendingPathExtension("outbox"))))
        } else {
            model = AppModel()
        }
#else
        model = AppModel()
#endif
        model.registerWalletPaymentReceiver(wallet)
        TaskNotificationActionRouter.shared.register(model: model)

        // Unlike a phone, a Mac routinely stays open and active straight through midnight
        // instead of backgrounding and resuming with a fresh Date() of its own accord, so the
        // "today" agenda would otherwise stay stuck on yesterday until something else happened
        // to re-render it. `resume()` below covers waking from sleep; these two notifications
        // cover staying awake and active the whole time.
        for name: Notification.Name in [.NSCalendarDayChanged, .NSSystemTimeZoneDidChange] {
            dayChangeObservers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak model] _ in
                Task { @MainActor in model?.refreshCalendarDayIfNeeded() }
            })
        }
    }

    deinit {
        for observer in dayChangeObservers { NotificationCenter.default.removeObserver(observer) }
    }

    func start() async {
        guard !started, !model.isLoading else { return }
        started = true
        model.initialContentDidAppear()
#if DEBUG
        guard ProcessInfo.processInfo.environment["TASKIFY_MAC_PREVIEW"] != "1" else { return }
#endif
        await wallet.start()
    }

    func resume() {
#if DEBUG
        guard ProcessInfo.processInfo.environment["TASKIFY_MAC_PREVIEW"] != "1" else { return }
#endif
        model.reloadIfChangedExternally()
        model.refreshCalendarDayIfNeeded()
        model.refreshNotificationStatus()
        model.refreshSyncIfNeeded()
        model.refreshFullWeekRecurrencesIfNeeded()
        model.refreshContactsIfNeeded()
        model.refreshAccountSyncIfNeeded()
        wallet.appDidBecomeActive()
    }
}

@MainActor
final class MacApplicationDelegate: NSObject, NSApplicationDelegate {
    weak var runtime: MacRuntime?
    private var terminating = false

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let runtime, !terminating else { return .terminateNow }
        terminating = true
        Task {
            runtime.wallet.appDidEnterBackground()
            let saved = await runtime.model.persistBeforeTermination()
            if !saved { terminating = false }
            sender.reply(toApplicationShouldTerminate: saved)
        }
        return .terminateLater
    }
}

@main
@MainActor
struct TaskifyMacApp: App {
    @NSApplicationDelegateAdaptor(MacApplicationDelegate.self) private var delegate
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var runtime = MacRuntime()

    var body: some Scene {
        WindowGroup {
            MacWorkspace()
                .environment(runtime.model)
                .environmentObject(runtime.wallet)
                .environmentObject(runtime.bible)
                .environmentObject(runtime.calendar)
                .frame(minWidth: 850, minHeight: 560)
                .task(id: runtime.model.isLoading) {
                    delegate.runtime = runtime
                    await runtime.start()
                }
        }
        .defaultSize(width: 1280, height: 820)
        .commands { MacCommands() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { runtime.resume() }
        }
        Settings {
            MacSettingsView()
                .environment(runtime.model)
                .environmentObject(runtime.wallet)
                .environmentObject(runtime.bible)
                .environmentObject(runtime.calendar)
                .frame(width: 640, height: 580)
        }
    }
}

struct MacWindowActions {
    var newTask: () -> Void
    var newBoard: () -> Void
    var sync: () -> Void
}
private struct MacWindowActionsKey: FocusedValueKey { typealias Value = MacWindowActions }
extension FocusedValues {
    var taskifyActions: MacWindowActions? {
        get { self[MacWindowActionsKey.self] }
        set { self[MacWindowActionsKey.self] = newValue }
    }
}
struct MacCommands: Commands {
    @FocusedValue(\.taskifyActions) private var actions
    var body: some Commands {
        CommandGroup(after: .newItem) {
            Button("New Task…") { actions?.newTask() }.keyboardShortcut("n", modifiers: [.command, .shift])
                .disabled(actions == nil)
            Button("New Board…") { actions?.newBoard() }.keyboardShortcut("b", modifiers: [.command, .shift])
                .disabled(actions == nil)
        }
        CommandMenu("Task") {
            Button("Sync Now") { actions?.sync() }.keyboardShortcut("r", modifiers: [.command, .shift])
                .disabled(actions == nil)
        }
        SidebarCommands()
        TextEditingCommands()
    }
}

func macCopy(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
}
