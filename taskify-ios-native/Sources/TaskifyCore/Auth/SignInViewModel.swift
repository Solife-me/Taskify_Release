import Foundation
import Combine

@MainActor
public final class SignInViewModel: ObservableObject {
    @Published public var secretKeyInput: String
    @Published public var profileName: String
    @Published public private(set) var errorMessage: String?
    @Published public private(set) var isSubmitting: Bool

    private let submitAction: (_ secretKeyInput: String, _ profileName: String) -> AuthState

    public init(
        secretKeyInput: String = "",
        profileName: String = "",
        submitAction: @escaping (_ secretKeyInput: String, _ profileName: String) -> AuthState
    ) {
        self.secretKeyInput = secretKeyInput
        self.profileName = profileName
        self.submitAction = submitAction
        self.errorMessage = nil
        self.isSubmitting = false
    }

    public var canSubmit: Bool {
        !secretKeyInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSubmitting
    }

    @discardableResult
    public func submit() -> Bool {
        guard canSubmit else { return false }

        isSubmitting = true
        errorMessage = nil
        let next = submitAction(secretKeyInput, profileName)
        isSubmitting = false

        switch next {
        case .signedIn:
            errorMessage = nil
            return true
        case .error(let message):
            errorMessage = message
            return false
        default:
            return false
        }
    }

    public func applyExternalError(_ message: String?) {
        guard let message, !message.isEmpty else {
            errorMessage = nil
            return
        }
        errorMessage = message
    }

    public func reset(secretKeyInput: String = "", profileName: String = "") {
        self.secretKeyInput = secretKeyInput
        self.profileName = profileName
        errorMessage = nil
        isSubmitting = false
    }
}
