import Foundation
import Testing
@testable import TaskifyCore

@MainActor
@Suite("SignInViewModel")
struct SignInViewModelTests {

    @Test("canSubmit is false when secret key is blank")
    func canSubmitBlank() {
        let vm = SignInViewModel(submitAction: { _, _ in .signedOut })
        vm.secretKeyInput = "   "
        #expect(vm.canSubmit == false)
    }

    @Test("canSubmit is true when secret key has value")
    func canSubmitWithValue() {
        let vm = SignInViewModel(submitAction: { _, _ in .signedOut })
        vm.secretKeyInput = "nsec1abc"
        #expect(vm.canSubmit == true)
    }

    @Test("submit success returns true and clears error")
    func submitSuccess() {
        let vm = SignInViewModel(submitAction: { _, _ in .signedIn(TaskifyProfile(name: "N", nsecHex: String(repeating: "a", count: 64), npub: "npub1x", relays: [], boards: [])) })
        vm.secretKeyInput = "nsec1abc"
        vm.applyExternalError("old")

        let ok = vm.submit()
        #expect(ok == true)
        #expect(vm.errorMessage == nil)
    }

    @Test("submit failure maps auth error message")
    func submitFailureShowsError() {
        let vm = SignInViewModel(submitAction: { _, _ in .error("Enter a valid nsec or 64-hex private key.") })
        vm.secretKeyInput = "bad"

        let ok = vm.submit()
        #expect(ok == false)
        #expect(vm.errorMessage == "Enter a valid nsec or 64-hex private key.")
    }

    @Test("submit is blocked when key is empty")
    func submitBlockedWhenEmpty() {
        var calls = 0
        let vm = SignInViewModel(submitAction: { _, _ in calls += 1; return .signedOut })
        vm.secretKeyInput = " "

        let ok = vm.submit()
        #expect(ok == false)
        #expect(calls == 0)
    }
}
