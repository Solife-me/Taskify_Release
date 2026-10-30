import AppKit
import SwiftUI
import TaskifyCore

@MainActor
final class MacRuntime: ObservableObject {
    @Published private(set) var model: AppModel
    @Published private(set) var savedAccounts: [MacAccountSummary] = []
    @Published private(set) var isSwitchingAccount = false
    @Published private(set) var accountError: String?
    var bible: BibleTrackerStore { model.bibleTrackerStore }
    let calendar = DeviceCalendarStore()
    let wallet = WalletViewModel()
    let configuration: MacRuntimeConfiguration
    let isWalletRecoveryMode: Bool
    private let requestsDMPushProvisioningSpike: Bool
    private let identityStore: KeychainIdentityStore
    private let accountVault: MacAccountVault?
    private var accountVaultState: MacAccountVaultState
    private var startedAccountID: String?
    private var startingAccountID: String?
    private var walletStarted = false
    private var dayChangeObservers: [NSObjectProtocol] = []

    init(configuration: MacRuntimeConfiguration = .production) {
        self.configuration = configuration
        self.isWalletRecoveryMode = WalletPhaseOut.isRecoveryMode
#if DEBUG
        requestsDMPushProvisioningSpike = MacDMPushProvisioningSpike.isRequested(
            configuration: configuration
        )
#else
        requestsDMPushProvisioningSpike = false
#endif

        let initialModel: AppModel
        let identityStore: KeychainIdentityStore
        let accountVault: MacAccountVault?
        let accountVaultState: MacAccountVaultState
        var initialAccountError: String?
        switch configuration {
        case .production:
            let store = KeychainIdentityStore()
            let service = (Bundle.main.bundleIdentifier ?? "solife.me.Taskify.Mac") + ".accounts"
            let vault = MacAccountVault(service: service, usesSharedAccessGroup: true)
            var state = MacAccountVaultState()
            do {
                state = try vault.load()
            } catch {
                initialAccountError = error.localizedDescription
            }
            let currentIdentity = try? store.load()
            let currentAccount = currentIdentity.flatMap { identity in
                state.accounts.first { $0.publicKeyHex == identity.publicKeyHex }
            }
            if let currentAccount,
               state.primaryAccountID != currentAccount.publicKeyHex {
                initialModel = Self.makeScopedModel(account: currentAccount, identityStore: store)
            } else {
                initialModel = Self.makePrimaryModel(identityStore: store)
            }
            identityStore = store
            accountVault = vault
            accountVaultState = state
        case .uiTest(let test):
#if TASKIFY_MAC_UI_TEST
            do {
                try MacUITestFixture.prepare(test)
            } catch {
                fatalError("Could not prepare isolated Mac UI-test data: \(error)")
            }
            OnboardingSettings.setCompleted(true)
            let store = KeychainIdentityStore(
                service: test.identityService,
                usesSharedAccessGroup: false
            )
            initialModel = AppModel(
                store: JSONTaskStore(fileURL: test.storeURL, migratesLegacyStore: true),
                identityStore: store,
                syncEngine: TaskSyncEngine(
                    outbox: NostrOutboxStore(fileURL: test.outboxURL),
                    networkingEnabled: false
                )
            )
            identityStore = store
            accountVault = nil
            accountVaultState = MacAccountVaultState()
#else
            preconditionFailure("The UI-test runtime is available only in the UI-test build configuration.")
#endif
        }

        self.identityStore = identityStore
        self.accountVault = accountVault
        self.accountVaultState = accountVaultState
        self.model = initialModel
        self.accountError = initialAccountError
        registerCurrentModel()
        refreshAccountSummaries()

        // Unlike a phone, a Mac routinely stays open and active straight through midnight
        // instead of backgrounding and resuming with a fresh Date() of its own accord, so the
        // "today" agenda would otherwise stay stuck on yesterday until something else happened
        // to re-render it. `resume()` below covers waking from sleep; these two notifications
        // cover staying awake and active the whole time.
        for name: Notification.Name in [.NSCalendarDayChanged, .NSSystemTimeZoneDidChange] {
            dayChangeObservers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.model.refreshCalendarDayIfNeeded() }
            })
        }
    }

    deinit {
        for observer in dayChangeObservers { NotificationCenter.default.removeObserver(observer) }
    }

    func start() async {
        guard !model.isLoading, !model.identityPublicKey.isEmpty else { return }
        let accountID = model.identityPublicKey
        guard startedAccountID != accountID, startingAccountID != accountID else { return }
        startingAccountID = accountID
        defer { startingAccountID = nil }
        synchronizeCurrentAccountIntoVault()
#if DEBUG
        if requestsDMPushProvisioningSpike {
            await model.enableDMPushNotifications(
                selection: TaskifyDMPushSettings.selection,
                relayURL: TaskifyDMPushSettings.relayURL,
                serverURL: TaskifyDMPushSettings.serverURL
            )
        }
#endif
        let shouldStartWallet = !walletStarted
        if shouldStartWallet { walletStarted = true }
        await MacRuntimeStartExecutor.run(
            plan: configuration.startPlan(isWalletRecoveryMode: isWalletRecoveryMode),
            startDeferredServices: { model.initialContentDidAppear() },
            startWallet: {
                if shouldStartWallet { await wallet.start() }
            }
        )
        startedAccountID = accountID
    }

    func resume() {
        model.reloadIfChangedExternally()
        model.refreshCalendarDayIfNeeded()
        model.refreshNotificationStatus()
        guard configuration.startsDeferredServices else { return }
        model.refreshSyncIfNeeded()
        model.refreshFullWeekRecurrencesIfNeeded()
        model.refreshAccountSyncIfNeeded()
        wallet.appDidBecomeActive()
    }

    func addAndSwitchAccount(nsec: String, label: String?) async -> Bool {
        guard let accountVault else {
            let imported = model.importIdentity(nsec)
            accountError = imported ? nil : model.errorMessage
            return imported
        }
        do {
            let identity = try NostrIdentity(importedValue: nsec)
            let trimmedLabel = label?.trimmingCharacters(in: .whitespacesAndNewlines)
            let account = MacSavedAccount(
                identity: identity,
                label: trimmedLabel?.isEmpty == false ? trimmedLabel : nil
            )
            accountVaultState.accounts = MacAccountCollection.upsert(account, into: accountVaultState.accounts)
            if accountVaultState.primaryAccountID == nil {
                accountVaultState.primaryAccountID = account.publicKeyHex
            }
            try accountVault.save(accountVaultState)
            accountError = nil
            refreshAccountSummaries()
            return await switchAccount(to: account.publicKeyHex)
        } catch {
            accountError = error.localizedDescription
            return false
        }
    }

    func switchAccount(to accountID: String) async -> Bool {
        guard !isSwitchingAccount else { return false }
        guard accountID != model.identityPublicKey else { return true }
        guard accountVault != nil else {
            accountError = "Multiple accounts are unavailable in this runtime."
            return false
        }
        guard let account = accountVaultState.accounts.first(where: { $0.publicKeyHex == accountID }),
              let identity = account.identity else {
            accountError = "That saved account is unavailable."
            return false
        }

        isSwitchingAccount = true
        accountError = nil
        defer { isSwitchingAccount = false }
        guard await model.persistBeforeTermination() else {
            accountError = "The current account could not be saved before switching."
            return false
        }
        do {
            try identityStore.save(identity)
        } catch {
            accountError = error.localizedDescription
            return false
        }

        model = accountVaultState.primaryAccountID == account.publicKeyHex
            ? Self.makePrimaryModel(identityStore: identityStore)
            : Self.makeScopedModel(account: account, identityStore: identityStore)
        startedAccountID = nil
        startingAccountID = nil
        registerCurrentModel()
        refreshAccountSummaries()
        await waitForCurrentModelLoad()
        await start()
        return true
    }

    func removeAccount(_ accountID: String) -> Bool {
        guard accountID != model.identityPublicKey,
              accountID != accountVaultState.primaryAccountID,
              let accountVault else { return false }
        accountVaultState.accounts = MacAccountCollection.remove(accountID, from: accountVaultState.accounts)
        do {
            try accountVault.save(accountVaultState)
            accountError = nil
            refreshAccountSummaries()
            return true
        } catch {
            accountError = error.localizedDescription
            return false
        }
    }

    func clearAccountError() {
        accountError = nil
    }

    private func registerCurrentModel() {
        model.registerWalletPaymentReceiver(wallet)
        TaskNotificationActionRouter.shared.register(model: model)
        if configuration.registersForRemoteNotifications {
            TaskifyDMPushCoordinator.shared.register(model: model)
        }
    }

    private func synchronizeCurrentAccountIntoVault() {
        guard let accountVault,
              let identity = try? identityStore.load(),
              identity.publicKeyHex == model.identityPublicKey else { return }
        let existing = accountVaultState.accounts.first {
            $0.publicKeyHex == identity.publicKeyHex
        }
        let account = MacSavedAccount(identity: identity, label: existing?.label)
        accountVaultState.accounts = MacAccountCollection.upsert(account, into: accountVaultState.accounts)
        if accountVaultState.primaryAccountID == nil {
            accountVaultState.primaryAccountID = account.publicKeyHex
        }
        do {
            try accountVault.save(accountVaultState)
            refreshAccountSummaries()
        } catch {
            accountError = error.localizedDescription
        }
    }

    private func refreshAccountSummaries() {
        savedAccounts = MacAccountCollection.summaries(
            accounts: accountVaultState.accounts,
            currentAccountID: model.identityPublicKey,
            primaryAccountID: accountVaultState.primaryAccountID
        )
    }

    private func waitForCurrentModelLoad() async {
        for _ in 0..<200 where model.isLoading {
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    private static func makePrimaryModel(identityStore: KeychainIdentityStore) -> AppModel {
        AppModel(
            store: JSONTaskStore(migratesLegacyStore: true),
            identityStore: identityStore
        )
    }

    private static func makeScopedModel(
        account: MacSavedAccount,
        identityStore: KeychainIdentityStore
    ) -> AppModel {
        let storeURL = MacAccountStoragePaths.storeURL(
            primaryURL: JSONTaskStore.defaultURL,
            accountID: account.publicKeyHex,
            usesPrimaryStore: false
        )
        let outboxURL = MacAccountStoragePaths.outboxURL(
            primaryURL: NostrOutboxStore.defaultURL,
            accountID: account.publicKeyHex,
            usesPrimaryStore: false
        )
        return AppModel(
            store: JSONTaskStore(fileURL: storeURL),
            identityStore: identityStore,
            syncEngine: TaskSyncEngine(outbox: NostrOutboxStore(fileURL: outboxURL))
        )
    }
}

@MainActor
final class MacApplicationDelegate: NSObject, NSApplicationDelegate {
    weak var runtime: MacRuntime?
    private var terminating = false

    func application(
        _ application: NSApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        TaskifyDMPushCoordinator.shared.didRegister(deviceToken: deviceToken)
    }

    func application(
        _ application: NSApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        TaskifyDMPushCoordinator.shared.didFailRegistration(error)
    }

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
    @StateObject private var runtime: MacRuntime

    init() {
#if TASKIFY_MAC_UI_TEST
        let configuration = MacRuntimeConfiguration.resolve(isUITestHost: true)
#else
        let configuration = MacRuntimeConfiguration.production
#endif
        _runtime = StateObject(wrappedValue: MacRuntime(configuration: configuration))
#if TASKIFY_MAC_SHORTCUTS
        // Keep the system's parameter and phrase data current after a Mac launch, matching iOS.
        TaskifyShortcuts.updateAppShortcutParameters()
#endif
    }

    var body: some Scene {
        WindowGroup {
            MacWorkspace(
                initialLink: runtime.configuration.uiTest?.initialLink,
                isWalletRecoveryMode: runtime.isWalletRecoveryMode
            )
                .environment(runtime.model)
                .environmentObject(runtime.wallet)
                .environmentObject(runtime.bible)
                .environmentObject(runtime.calendar)
                .environmentObject(runtime)
                .frame(minWidth: 850, minHeight: 560)
                .task(id: "\(runtime.model.identityPublicKey):\(runtime.model.isLoading)") {
                    delegate.runtime = runtime
                    await runtime.start()
                }
        }
        .defaultSize(width: 1280, height: 820)
        .commands { MacCommands() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { runtime.resume() }
            if phase == .background { runtime.model.flushAppStateSync() }
        }
        Settings {
            MacSettingsView()
                .environment(runtime.model)
                .environmentObject(runtime.wallet)
                .environmentObject(runtime.bible)
                .environmentObject(runtime.calendar)
                .environmentObject(runtime)
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

/// For a private key or a Cashu token: kept to this Mac (no Universal Clipboard), marked concealed
/// so clipboard managers that honour the nspasteboard.org convention skip it, and cleared after
/// two minutes unless something else has been copied since.
func macCopySecret(_ text: String) {
    let pasteboard = NSPasteboard.general
    pasteboard.prepareForNewContents(with: .currentHostOnly)
    pasteboard.setString(text, forType: .string)
    pasteboard.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
    clearPasteboard(after: 120, ifStill: pasteboard.changeCount)
}

/// For a board share, which carries the board ID: it may still be pasted on another device, but it
/// is cleared after ten minutes unless something else has been copied since.
func macCopyExpiring(_ text: String) {
    macCopy(text)
    clearPasteboard(after: 600, ifStill: NSPasteboard.general.changeCount)
}

private func clearPasteboard(after seconds: TimeInterval, ifStill changeCount: Int) {
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
        guard NSPasteboard.general.changeCount == changeCount else { return }
        NSPasteboard.general.clearContents()
    }
}
