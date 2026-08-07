import Foundation

/// Local device settings for the first-run onboarding flow, matching the PWA's
/// `taskify_onboarding_done_v1` gating in `useFirstRunOnboarding.ts`.
enum OnboardingSettings {
    private static let completedKey = "taskify.onboarding.completed"
    private static let eligibilityDeterminedKey = "taskify.onboarding.eligibilityDetermined"

    static var completed: Bool {
        #if DEBUG
        switch ProcessInfo.processInfo.environment["TASKIFY_UI_TEST_ONBOARDING"] {
        case "force":
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
