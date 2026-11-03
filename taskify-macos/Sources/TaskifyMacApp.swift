import AppKit
import SwiftUI
import TaskifyCore

@MainActor
final class MacRuntime: ObservableObject {
    @Published private(set) var model: AppModel
    @Published private(set) var savedAccounts: [MacAccountSummary] = []
    @Published private(set) var isSwitchingAccount = false
    @Published private(set) var accountError: String?
    @Published private(set) var completedTabEnabled: Bool
    @Published private(set) var hideCompletedSubtasks: Bool
    var bible: BibleTrackerStore { model.bibleTrackerStore }
    let calendar = DeviceCalendarStore()
    let configuration: MacRuntimeConfiguration
    private let requestsDMPushProvisioningSpike: Bool
    private let identityStore: KeychainIdentityStore
    private let accountVault: MacAccountVault?
    private var accountVaultStateLoaded: Bool
    private var accountVaultState: MacAccountVaultState
    private var startedAccountID: String?
    private var startingAccountID: String?
    private var dayChangeObservers: [NSObjectProtocol] = []

    init(configuration: MacRuntimeConfiguration = .production) {
        self.configuration = configuration
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
        let accountVaultStateLoaded: Bool
        var initialAccountError: String?
        switch configuration {
        case .production:
            let store = KeychainIdentityStore()
            let service = (Bundle.main.bundleIdentifier ?? "solife.me.Taskify.Mac") + ".accounts"
            let vault = MacAccountVault(service: service, usesSharedAccessGroup: true)
            var state = MacAccountVaultState()
            var vaultStateLoaded = false
            do {
                state = try vault.load()
                vaultStateLoaded = true
            } catch {
                initialAccountError = error.localizedDescription
            }

            state.accounts = MacAccountCollection.validAccounts(state.accounts)
            if let primaryID = state.primaryAccountID,
               let primary = state.accounts.first(where: {
                   $0.publicKeyHex.caseInsensitiveCompare(primaryID) == .orderedSame
               }) {
                state.primaryAccountID = primary.publicKeyHex
            } else if state.primaryAccountID == nil {
                state.primaryAccountID = state.accounts.first?.publicKeyHex
            } else {
                state.primaryAccountID = state.accounts.first?.publicKeyHex
            }

            let storedIdentity = try? store.load()
            let currentAccount: MacSavedAccount?
            if state.accounts.isEmpty {
                if let generated = try? store.loadOrCreate() {
                    let account = MacSavedAccount(identity: generated)
                    state.accounts = [account]
                    state.primaryAccountID = account.publicKeyHex
                    currentAccount = account
                } else {
                    currentAccount = nil
                }
            } else {
                currentAccount = MacAccountCollection.startupAccount(
                    storedIdentityID: storedIdentity?.publicKeyHex,
                    accounts: state.accounts,
                    primaryAccountID: state.primaryAccountID
                )
                if let currentAccount,
                   storedIdentity?.publicKeyHex != currentAccount.publicKeyHex,
                   let identity = currentAccount.identity {
                    do {
                        try store.save(identity)
                    } catch {
                        initialAccountError = error.localizedDescription
                    }
                }
            }

            if let currentAccount {
                initialModel = state.primaryAccountID == currentAccount.publicKeyHex
                    ? Self.makePrimaryModel(accountID: currentAccount.publicKeyHex, identityStore: store)
                    : Self.makeScopedModel(accountID: currentAccount.publicKeyHex, identityStore: store)
            } else {
                initialModel = Self.makePrimaryModel(
                    accountID: state.primaryAccountID,
                    identityStore: store
                )
            }
            if vaultStateLoaded {
                do {
                    try vault.save(state)
                } catch {
                    initialAccountError = error.localizedDescription
                    vaultStateLoaded = false
                }
            }
            identityStore = store
            accountVault = vault
            accountVaultState = state
            accountVaultStateLoaded = vaultStateLoaded
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
            accountVaultStateLoaded = true
#else
            preconditionFailure("The UI-test runtime is available only in the UI-test build configuration.")
#endif
        }

        let viewPreferences = MacAccountViewPreferences(defaults: initialModel.accountDefaults)
        self.completedTabEnabled = viewPreferences.completedTabEnabled
        self.hideCompletedSubtasks = viewPreferences.hideCompletedSubtasks
        self.identityStore = identityStore
        self.accountVault = accountVault
        self.accountVaultState = accountVaultState
        self.accountVaultStateLoaded = accountVaultStateLoaded
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
                Task { @MainActor in
                    guard let self, self.model.isAccountActive else { return }
                    self.model.refreshCalendarDayIfNeeded()
                }
            })
        }
    }

    deinit {
        for observer in dayChangeObservers { NotificationCenter.default.removeObserver(observer) }
    }

    func start() async {
        guard model.isAccountActive,
              !model.isLoading,
              !model.identityPublicKey.isEmpty else { return }
        let startingModel = model
        let accountID = model.identityPublicKey
        guard startedAccountID != accountID, startingAccountID != accountID else { return }
        startingAccountID = accountID
        defer {
            if startingModel === model { startingAccountID = nil }
        }
        synchronizeCurrentAccountIntoVault()
#if DEBUG
        if requestsDMPushProvisioningSpike {
            await model.enableDMPushNotifications(
                selection: model.dmPushSelection,
                relayURL: model.dmPushRelayURL,
                serverURL: model.dmPushServerURL
            )
        }
#endif
        if configuration.startsDeferredServices,
           startingModel === model,
           startingModel.isAccountActive {
            startingModel.initialContentDidAppear()
        }
        guard startingModel === model, startingModel.isAccountActive else { return }
        startedAccountID = accountID
    }

    func resume() {
        guard model.isAccountActive else { return }
        model.reloadIfChangedExternally()
        model.refreshCalendarDayIfNeeded()
        model.refreshNotificationStatus()
        guard configuration.startsDeferredServices else { return }
        model.refreshSyncIfNeeded()
        model.refreshFullWeekRecurrencesIfNeeded()
        model.refreshAccountSyncIfNeeded()
    }

    func addAndSwitchAccount(nsec: String, label: String?) async -> Bool {
        guard let accountVault else {
            let imported = model.importIdentity(nsec)
            accountError = imported ? nil : model.errorMessage
            return imported
        }
        guard accountVaultStateLoaded else {
            accountError = "The saved-account list could not be loaded safely. Restart Taskify before adding an account."
            return false
        }
        let identity: NostrIdentity
        do {
            identity = try NostrIdentity(importedValue: nsec)
        } catch {
            accountError = error.localizedDescription
            return false
        }
        let trimmedLabel = label?.trimmingCharacters(in: .whitespacesAndNewlines)
        let account = MacSavedAccount(
            identity: identity,
            label: trimmedLabel?.isEmpty == false ? trimmedLabel : nil
        )
        if !OnboardingSettings.completed,
           accountVaultState.accounts.count == 1,
           accountVaultState.primaryAccountID == model.identityPublicKey,
           let existingPrimary = accountVaultState.accounts.first,
           existingPrimary.publicKeyHex == model.identityPublicKey {
            if existingPrimary.publicKeyHex == account.publicKeyHex {
                OnboardingSettings.setCompleted(true)
                model.completeFirstRunOnboarding()
                return true
            }
            return await replaceInitialPrimaryAccount(
                with: account,
                replacing: existingPrimary,
                vault: accountVault
            )
        }
        let previousState = accountVaultState
        do {
            accountVaultState.accounts = MacAccountCollection.upsert(account, into: accountVaultState.accounts)
            if accountVaultState.primaryAccountID == nil {
                accountVaultState.primaryAccountID = account.publicKeyHex
            }
            try accountVault.save(accountVaultState)
            accountError = nil
            refreshAccountSummaries()
            return await switchAccount(to: account.publicKeyHex)
        } catch {
            accountVaultState = previousState
            accountVaultStateLoaded = false
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
        guard accountVaultStateLoaded else {
            accountError = "The saved-account list could not be loaded safely. Restart Taskify before switching accounts."
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
        let previousAccountID = model.identityPublicKey
        guard await model.persistBeforeTermination() else {
            accountError = "The current account could not be saved before switching."
            return false
        }
        TaskNotificationActionRouter.shared.unregister(model: model)
        TaskifyDMPushCoordinator.shared.unregister(model: model)
        await model.stopForAccountSwitch()
        guard await model.persistBeforeTermination() else {
            accountError = "The current account could not be saved after it was quiesced."
            await restoreAccountModel(accountID: previousAccountID)
            return false
        }
        await TaskifySpotlightIndexer.shared.activate(accountID: accountID)
        do {
            try identityStore.save(identity)
        } catch {
            if let previousIdentity = accountVaultState.accounts.first(where: {
                $0.publicKeyHex == previousAccountID
            })?.identity {
                try? identityStore.save(previousIdentity)
            }
            accountError = error.localizedDescription
            await restoreAccountModel(accountID: previousAccountID)
            return false
        }

        model = makeAccountModel(accountID: accountID)
        refreshAccountViewPreferences()
        startedAccountID = nil
        startingAccountID = nil
        registerCurrentModel()
        refreshAccountSummaries()
        await waitForCurrentModelLoad()
        await start()
        return true
    }

    func removeAccount(_ accountID: String) async -> Bool {
        guard accountVaultStateLoaded else {
            accountError = "The saved-account list could not be loaded safely. Restart Taskify before removing an account."
            return false
        }
        guard !isSwitchingAccount, let accountVault else { return false }
        guard let plan = MacAccountCollection.removalPlan(
            accountID: accountID,
            currentAccountID: model.identityPublicKey,
            primaryAccountID: accountVaultState.primaryAccountID,
            accounts: accountVaultState.accounts
        ) else {
            accountError = "Taskify needs at least one saved account. Add another account before removing this one."
            return false
        }

        if plan.promotedPrimaryAccountID == nil {
            if plan.activeAccountID != model.identityPublicKey {
                guard await switchAccount(to: plan.activeAccountID) else { return false }
            }
            return persistAccountRemoval(accountID, vault: accountVault)
        }
        return await removePrimaryAccount(plan: plan, vault: accountVault)
    }

    private func persistAccountRemoval(_ accountID: String, vault: MacAccountVault) -> Bool {
        let previousState = accountVaultState
        accountVaultState.accounts = MacAccountCollection.remove(accountID, from: accountVaultState.accounts)
        do {
            try vault.save(accountVaultState)
            accountError = nil
            refreshAccountSummaries()
            return true
        } catch {
            accountVaultState = previousState
            accountVaultStateLoaded = false
            accountError = error.localizedDescription
            return false
        }
    }

    /// Removing the primary requires swapping the generic primary store with the promoted
    /// account's account-scoped store. Both moves are rolled back together if either Keychain
    /// write fails, so no account can inherit another account's task or outbox data.
    private func removePrimaryAccount(
        plan: MacAccountRemovalPlan,
        vault: MacAccountVault
    ) async -> Bool {
        guard let removedPrimaryID = accountVaultState.primaryAccountID,
              let promotedPrimaryID = plan.promotedPrimaryAccountID,
              let targetAccount = accountVaultState.accounts.first(where: {
                  $0.publicKeyHex == plan.activeAccountID
              }),
              let targetIdentity = targetAccount.identity else {
            accountError = "The replacement account is unavailable."
            return false
        }

        isSwitchingAccount = true
        accountError = nil
        defer { isSwitchingAccount = false }
        let previousCurrentID = model.identityPublicKey
        let previousIdentity = accountVaultState.accounts.first(where: {
            $0.publicKeyHex == previousCurrentID
        })?.identity

        guard await model.persistBeforeTermination() else {
            accountError = "The current account could not be saved before removing an account."
            return false
        }
        TaskNotificationActionRouter.shared.unregister(model: model)
        TaskifyDMPushCoordinator.shared.unregister(model: model)
        await model.stopForAccountSwitch()
        guard await model.persistBeforeTermination() else {
            accountError = "The current account could not be saved after it was quiesced."
            await restoreAccountModel(accountID: previousCurrentID)
            return false
        }

        let oldState = accountVaultState
        var newState = oldState
        newState.accounts = MacAccountCollection.remove(
            plan.removedAccountID,
            from: oldState.accounts
        )
        newState.primaryAccountID = promotedPrimaryID
        var demotion = MacPrimaryStorageRelocation(
            primaryStoreURL: JSONTaskStore.defaultURL,
            primaryOutboxURL: NostrOutboxStore.defaultURL,
            accountID: removedPrimaryID
        )
        var promotion = MacPrimaryStorageRelocation(
            promotingAccountID: promotedPrimaryID,
            primaryStoreURL: JSONTaskStore.defaultURL,
            primaryOutboxURL: NostrOutboxStore.defaultURL
        )

        do {
            try demotion.apply()
            try promotion.apply()
            try vault.save(newState)
            if targetIdentity.publicKeyHex != previousIdentity?.publicKeyHex {
                try identityStore.save(targetIdentity)
            }
        } catch {
            try? promotion.rollback()
            try? demotion.rollback()
            accountVaultState = oldState
            accountVaultStateLoaded = (try? vault.save(oldState)) != nil
            if let previousIdentity {
                try? identityStore.save(previousIdentity)
            }
            accountError = error.localizedDescription
            await restoreAccountModel(accountID: previousCurrentID)
            return false
        }

        accountVaultState = newState
        await restoreAccountModel(accountID: plan.activeAccountID)
        return true
    }

    func clearAccountError() {
        accountError = nil
    }

    func setCompletedTabEnabled(_ enabled: Bool) {
        model.accountDefaults.set(enabled, forKey: MacAccountViewPreferences.completedTabKey)
        completedTabEnabled = enabled
    }

    func setHideCompletedSubtasks(_ hidden: Bool) {
        model.accountDefaults.set(hidden, forKey: MacAccountViewPreferences.hideCompletedSubtasksKey)
        hideCompletedSubtasks = hidden
    }

    private func registerCurrentModel() {
        TaskNotificationActionRouter.shared.register(model: model)
        if configuration.registersForRemoteNotifications {
            TaskifyDMPushCoordinator.shared.register(model: model)
        }
    }

    private func restoreAccountModel(accountID: String) async {
        guard accountVaultState.accounts.contains(where: { $0.publicKeyHex == accountID }) else {
            return
        }
        await TaskifySpotlightIndexer.shared.activate(accountID: accountID)
        model = makeAccountModel(accountID: accountID)
        refreshAccountViewPreferences()
        startedAccountID = nil
        startingAccountID = nil
        registerCurrentModel()
        refreshAccountSummaries()
        await waitForCurrentModelLoad()
        await start()
    }

    /// A first launch creates a placeholder identity before onboarding. If the user imports an
    /// existing account, make that account primary without reusing the placeholder's generic
    /// store: move the placeholder's store/outbox into its own account folder first, and roll the
    /// entire operation back if either Keychain write fails.
    private func replaceInitialPrimaryAccount(
        with account: MacSavedAccount,
        replacing previousAccount: MacSavedAccount,
        vault: MacAccountVault
    ) async -> Bool {
        guard !isSwitchingAccount, let identity = account.identity else { return false }
        isSwitchingAccount = true
        accountError = nil
        defer { isSwitchingAccount = false }

        guard await model.persistBeforeTermination() else {
            accountError = "The current account could not be saved before switching."
            return false
        }
        TaskNotificationActionRouter.shared.unregister(model: model)
        TaskifyDMPushCoordinator.shared.unregister(model: model)
        await model.stopForAccountSwitch()
        guard await model.persistBeforeTermination() else {
            accountError = "The current account could not be saved after it was quiesced."
            await restoreAccountModel(accountID: previousAccount.publicKeyHex)
            return false
        }

        let oldState = accountVaultState
        var newState = oldState
        newState.accounts = MacAccountCollection.upsert(account, into: oldState.accounts)
        newState.primaryAccountID = account.publicKeyHex
        var relocation = MacPrimaryStorageRelocation(
            primaryStoreURL: JSONTaskStore.defaultURL,
            primaryOutboxURL: NostrOutboxStore.defaultURL,
            accountID: previousAccount.publicKeyHex
        )

        do {
            try relocation.apply()
            try vault.save(newState)
            try identityStore.save(identity)
        } catch {
            try? relocation.rollback()
            accountVaultState = oldState
            accountVaultStateLoaded = (try? vault.save(oldState)) != nil
            if let previousIdentity = previousAccount.identity {
                try? identityStore.save(previousIdentity)
            }
            await TaskifySpotlightIndexer.shared.activate(accountID: previousAccount.publicKeyHex)
            accountError = error.localizedDescription
            model = Self.makePrimaryModel(
                accountID: previousAccount.publicKeyHex,
                identityStore: identityStore
            )
            refreshAccountViewPreferences()
            startedAccountID = nil
            startingAccountID = nil
            registerCurrentModel()
            refreshAccountSummaries()
            await waitForCurrentModelLoad()
            await start()
            return false
        }

        accountVaultState = newState
        await TaskifySpotlightIndexer.shared.activate(accountID: account.publicKeyHex)
        startedAccountID = nil
        startingAccountID = nil
        model = Self.makePrimaryModel(
            accountID: account.publicKeyHex,
            identityStore: identityStore,
            migratesLegacyPreferences: false
        )
        refreshAccountViewPreferences()
        registerCurrentModel()
        refreshAccountSummaries()
        await waitForCurrentModelLoad()
        await start()
        OnboardingSettings.setCompleted(true)
        model.completeFirstRunOnboarding()
        return true
    }

    private func synchronizeCurrentAccountIntoVault() {
        guard accountVaultStateLoaded,
              let accountVault,
              let identity = try? identityStore.load(),
              identity.publicKeyHex == model.identityPublicKey else { return }
        let previousState = accountVaultState
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
            accountVaultState = previousState
            accountVaultStateLoaded = false
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

    private func refreshAccountViewPreferences() {
        let preferences = MacAccountViewPreferences(defaults: model.accountDefaults)
        completedTabEnabled = preferences.completedTabEnabled
        hideCompletedSubtasks = preferences.hideCompletedSubtasks
    }

    private func waitForCurrentModelLoad() async {
        for _ in 0..<200 where model.isLoading {
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    private func makeAccountModel(accountID: String) -> AppModel {
        guard let account = accountVaultState.accounts.first(where: { $0.publicKeyHex == accountID }) else {
            preconditionFailure("A saved account disappeared during an account model transition.")
        }
        let isPrimary = accountVaultState.primaryAccountID == accountID
        return isPrimary
            ? Self.makePrimaryModel(accountID: accountID, identityStore: identityStore)
            : Self.makeScopedModel(accountID: account.publicKeyHex, identityStore: identityStore)
    }

    private static func makePrimaryModel(
        accountID: String?,
        identityStore: KeychainIdentityStore,
        migratesLegacyPreferences: Bool = true
    ) -> AppModel {
        let defaults = accountID.map {
            MacAccountPreferences.makeDefaults(
                bundleIdentifier: Bundle.main.bundleIdentifier ?? "solife.me.Taskify.Mac",
                accountID: $0,
                migratingFrom: migratesLegacyPreferences ? .standard : nil
            )
        } ?? .standard
        return AppModel(
            store: JSONTaskStore(migratesLegacyStore: true),
            identityStore: identityStore,
            accountDefaults: defaults,
            expectedAccountID: accountID,
            isPrimaryAccount: true
        )
    }

    private static func makeScopedModel(
        accountID: String,
        identityStore: KeychainIdentityStore
    ) -> AppModel {
        let storeURL = MacAccountStoragePaths.storeURL(
            primaryURL: JSONTaskStore.defaultURL,
            accountID: accountID,
            usesPrimaryStore: false
        )
        let outboxURL = MacAccountStoragePaths.outboxURL(
            primaryURL: NostrOutboxStore.defaultURL,
            accountID: accountID,
            usesPrimaryStore: false
        )
        return AppModel(
            store: JSONTaskStore(fileURL: storeURL),
            identityStore: identityStore,
            syncEngine: TaskSyncEngine(outbox: NostrOutboxStore(fileURL: outboxURL)),
            accountDefaults: MacAccountPreferences.makeDefaults(
                bundleIdentifier: Bundle.main.bundleIdentifier ?? "solife.me.Taskify.Mac",
                accountID: accountID
            ),
            expectedAccountID: accountID,
            isPrimaryAccount: false
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
            MacWorkspace(initialLink: runtime.configuration.uiTest?.initialLink)
                // Rebuild every window's transient selection, editor, draft and split-view state
                // at the account boundary instead of relying on each sheet to notice the swap.
                .id(runtime.model.identityPublicKey)
                .environment(runtime.model)
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
                .id(runtime.model.identityPublicKey)
                .environment(runtime.model)
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

/// For a private key or a received Cashu token: kept to this Mac (no Universal Clipboard), marked concealed
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
