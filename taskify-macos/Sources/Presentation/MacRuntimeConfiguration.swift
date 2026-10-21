import Foundation

/// The process boundary for the real Mac app and its isolated UI-test host.
///
/// UI tests get a different bundle identifier at build time. This value adds the remaining
/// runtime isolation without mutating process-global environment variables: a session-scoped
/// temporary store/outbox, a separate Keychain service, no relay startup and no wallet startup.
enum MacRuntimeConfiguration: Equatable {
    case production
    case uiTest(MacUITestRuntimeConfiguration)

    var uiTest: MacUITestRuntimeConfiguration? {
        guard case .uiTest(let configuration) = self else { return nil }
        return configuration
    }

    var startsDeferredServices: Bool { self == .production }

    /// Resolve every startup side effect before executing one. Recovery mode deliberately keeps
    /// the ordinary task/sync services but never opens the wallet database or starts its monitors.
    func startPlan(isWalletRecoveryMode: Bool) -> MacRuntimeStartPlan {
        MacRuntimeStartPlan(
            startsDeferredServices: startsDeferredServices,
            startsWallet: self == .production && !isWalletRecoveryMode
        )
    }

    static func resolve(
        isUITestHost: Bool,
        arguments: [String] = ProcessInfo.processInfo.arguments,
        temporaryDirectory: URL = FileManager.default.temporaryDirectory,
        bundleIdentifier: String = Bundle.main.bundleIdentifier ?? "solife.me.Taskify.Mac"
    ) -> MacRuntimeConfiguration {
        guard isUITestHost else { return .production }

        let requestedSession = value(after: "--taskify-ui-test-session", in: arguments)
        let sessionID = sanitizedSessionID(requestedSession ?? "default")
        let root = temporaryDirectory
            .appendingPathComponent("TaskifyMacUITests", isDirectory: true)
            .appendingPathComponent(sessionID, isDirectory: true)
        let initialLink = value(after: "--taskify-ui-test-open-url", in: arguments)
            .flatMap(URL.init(string:))

        return .uiTest(MacUITestRuntimeConfiguration(
            sessionID: sessionID,
            rootDirectory: root,
            storeURL: root.appendingPathComponent("taskify-ui-test.json", isDirectory: false),
            outboxURL: root.appendingPathComponent("taskify-ui-test-outbox.json", isDirectory: false),
            identityService: "\(bundleIdentifier).identity.\(sessionID)",
            initialLink: initialLink,
            resetsStore: !arguments.contains("--taskify-ui-test-preserve-store"),
            walletRecoveryPreview: arguments.contains("--taskify-ui-test-wallet-recovery")
        ))
    }

    private static func value(after option: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: option), arguments.indices.contains(index + 1) else {
            return nil
        }
        let value = arguments[index + 1].trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    private static func sanitizedSessionID(_ value: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        let scalars = value.unicodeScalars.map { allowed.contains($0) ? Character(String($0)) : "-" }
        let collapsed = String(scalars)
            .split(separator: "-", omittingEmptySubsequences: true)
            .joined(separator: "-")
        return String((collapsed.isEmpty ? "default" : collapsed).prefix(80))
    }
}

struct MacUITestRuntimeConfiguration: Equatable {
    let sessionID: String
    let rootDirectory: URL
    let storeURL: URL
    let outboxURL: URL
    let identityService: String
    let initialLink: URL?
    let resetsStore: Bool
    let walletRecoveryPreview: Bool
}

struct MacRuntimeStartPlan: Equatable {
    let startsDeferredServices: Bool
    let startsWallet: Bool
}

/// Executes the resolved startup plan. Keeping the decision outside `MacRuntime` makes the
/// “recovery never starts the wallet” guarantee testable without constructing the app graph.
@MainActor
enum MacRuntimeStartExecutor {
    static func run(
        plan: MacRuntimeStartPlan,
        startDeferredServices: () -> Void,
        startWallet: () async -> Void
    ) async {
        if plan.startsDeferredServices { startDeferredServices() }
        if plan.startsWallet { await startWallet() }
    }
}
