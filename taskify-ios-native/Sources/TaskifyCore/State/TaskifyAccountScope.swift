import Foundation

/// A deliberately strict comparison for work that carries an account identifier. Missing or
/// blank identifiers never match, so a delayed callback cannot fall back to whichever account
/// happens to be active when it finishes.
public enum TaskifyAccountScope {
    public static func isSame(_ first: String?, _ second: String?) -> Bool {
        guard let first = normalized(first), let second = normalized(second) else { return false }
        return first == second
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !value.isEmpty else { return nil }
        return value
    }
}
