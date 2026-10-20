import Foundation
import TaskifyCore

/// Local device settings for the first-run onboarding flow, matching the PWA's
/// `taskify_onboarding_done_v1` gating in `useFirstRunOnboarding.ts`.
enum OnboardingSettings {
    private static let completedKey = "taskify.onboarding.completed"
    private static let eligibilityDeterminedKey = "taskify.onboarding.eligibilityDetermined"

    static var completed: Bool {
        #if DEBUG
        switch ProcessInfo.processInfo.environment["TASKIFY_UI_TEST_ONBOARDING"] {
        case "force":
            // A forced first run starts with no key-backup history either.
            UserDefaults.standard.removeObject(forKey: KeyBackupSettings.storageKey)
            return false
        case "skip":
            return true
        default:
            break
        }
        #endif
        return UserDefaults.standard.bool(forKey: completedKey)
    }

    static func setCompleted(_ completed: Bool) {
        UserDefaults.standard.set(completed, forKey: completedKey)
    }

    private static var eligibilityDetermined: Bool {
        UserDefaults.standard.bool(forKey: eligibilityDeterminedKey)
    }

    /// Runs at most once per install. Native always auto-creates a Nostr identity on first
    /// launch (unlike the PWA, which only creates one once the user picks an onboarding option),
    /// so onboarding can't gate on "is there a valid key" the way the PWA does — that would be
    /// true immediately. Instead, an existing identity found *before* this check ever ran means
    /// this is an existing install picking up the feature, not a new user, so grandfather it in.
    /// Once determined, this never re-runs, so quitting mid-onboarding on a genuinely new install
    /// won't cause the next launch to look like an "existing" one.
    static func determineEligibilityIfNeeded(hadExistingIdentity: Bool) {
        #if DEBUG
        if ProcessInfo.processInfo.environment["TASKIFY_UI_TEST_ONBOARDING"] != nil {
            return
        }
        #endif
        guard !eligibilityDetermined else { return }
        UserDefaults.standard.set(true, forKey: eligibilityDeterminedKey)
        if hadExistingIdentity {
            setCompleted(true)
        }
    }
}

/// The key-backup reminder's state on this device (C9-5), stored as JSON so views can follow it
/// with `@AppStorage(KeyBackupSettings.storageKey)`.
enum KeyBackupSettings {
    static let storageKey = "taskify.keyBackup.v1"

    static var state: KeyBackupState { decode(UserDefaults.standard.string(forKey: storageKey)) }

    static func decode(_ raw: String?) -> KeyBackupState {
        guard let data = raw?.data(using: .utf8),
              let state = try? JSONDecoder().decode(KeyBackupState.self, from: data) else { return KeyBackupState() }
        return state
    }

    private static func update(_ change: (inout KeyBackupState) -> Void) {
        var next = state
        change(&next)
        guard let data = try? JSONEncoder().encode(next), let raw = String(data: data, encoding: .utf8) else { return }
        UserDefaults.standard.set(raw, forKey: storageKey)
    }

    /// "Start using Taskify" kept the key the app made here.
    static func markCreatedHere(now: Date = Date()) { update { if $0.createdHereAt == nil { $0.createdHereAt = now } } }
    /// The user copied their key.
    static func markSaved(now: Date = Date()) { update { $0.savedAt = now } }
    static func snooze(now: Date = Date()) { update { $0.snooze(now: now) } }
}
