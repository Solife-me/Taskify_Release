import TaskifyCore

public enum MacWalletOutcome: Equatable {
    case received(UInt64), alreadyReceived, receiveQueued, paid, paymentPending

    public init(receive: CashuReceiveSubmissionResult) {
        switch receive {
        case .received(let amount): self = .received(amount)
        case .alreadyReceived: self = .alreadyReceived
        case .queued: self = .receiveQueued
        }
    }
    public init(payment: CashuLightningPaymentResult) {
        self = payment.state == .pending ? .paymentPending : .paid
    }
    public var isPending: Bool { self == .receiveQueued || self == .paymentPending }
}

@MainActor
func macAuthenticatedRecovery(replace: Bool,
                              authenticate: () async throws -> Void,
                              recover: (Bool) async throws -> Void) async throws {
    try await authenticate()
    try await recover(replace)
}
