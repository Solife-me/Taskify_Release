import Foundation
import XCTest
import TaskifyWatchShared
@testable import TaskifyWatchChatRuntime

private final class GatewayStub: URLProtocol {
    private static let lock = NSLock()
    private static var bodies: [[String: Any]] = []
    private let stateLock = NSLock()
    private var stopped = false

    static func reset() {
        lock.lock()
        defer { lock.unlock() }
        bodies = []
    }

    static var requests: [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        return bodies
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var data = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        Self.lock.lock()
        Self.bodies.append(body)
        Self.lock.unlock()
        let event = body["event"] as? [String: Any] ?? [:]
        let relays = body["relays"] as? [String] ?? []
        let reply: [String: Any] = [
            "eventID": event["id"] as? String ?? "",
            "accepted": 1,
            "results": relays.enumerated().map { index, relay in
                ["relay": relay, "status": index == 0 ? "accepted" : "pending"]
            },
        ]
        let encoded = try! JSONSerialization.data(withJSONObject: reply)
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { [self] in
            stateLock.lock()
            defer { stateLock.unlock() }
            guard !stopped else { return }
            client?.urlProtocol(self, didReceive: HTTPURLResponse(
                url: request.url!, statusCode: 202, httpVersion: nil, headerFields: nil
            )!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: encoded)
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {
        stateLock.lock()
        stopped = true
        stateLock.unlock()
    }
}

final class TaskifyWatchSendTests: XCTestCase {
    private let senderKey = Data(repeating: 1, count: 32)
    private let recipientKey = Data(repeating: 2, count: 32)

    override func setUp() { GatewayStub.reset() }

    private func configuredCoordinator() async throws -> (TaskifyWatchChatCoordinator, URL, String) {
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString).appendingPathComponent("chat.json")
        addTeardownBlock { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [GatewayStub.self]
        let session = URLSession(configuration: configuration)
        addTeardownBlock { session.invalidateAndCancel() }
        let coordinator = TaskifyWatchChatCoordinator(fileURL: fileURL, session: session)
        let recipient = try TaskifyWatchNostrCrypto.publicKeyHex(for: recipientKey)
        let recipientPreference = try TaskifyWatchNostrCrypto.signedEvent(
            privateKey: recipientKey, createdAt: Int(Date().timeIntervalSince1970), kind: 10_050,
            tags: [["relay", "wss://recipient.example"], ["relay", "wss://slow.example"]], content: ""
        )
        let senderPreference = try TaskifyWatchNostrCrypto.signedEvent(
            privateKey: senderKey, createdAt: Int(Date().timeIntervalSince1970), kind: 10_050,
            tags: [["relay", "wss://sender.example"]], content: ""
        )
        _ = try await coordinator.configure(TaskifyWatchChatProvisioningContext(
            contacts: [TaskifyWatchContact(publicKey: recipient, npub: "", displayName: "Recipient",
                                          inboxPreferenceEvent: recipientPreference)],
            discoveryRelayURLs: [], accountInboxPreferenceEvent: senderPreference,
            pushRelayHTTPSURL: URL(string: "https://gateway.example")!,
            pushRelayWSSURL: "wss://gateway.example"
        ))
        return (coordinator, fileURL, recipient)
    }

    func testSendReturnsDurableQueuedMessageBeforeAnyNetworkRequest() async throws {
        let (coordinator, fileURL, recipient) = try await configuredCoordinator()
        let queued = try await coordinator.send(
            content: "Send without waiting", memberPublicKeys: [recipient], privateKey: senderKey
        )
        XCTAssertTrue(GatewayStub.requests.isEmpty)
        XCTAssertEqual(queued.messages.first?.deliveryState, .queued)
        XCTAssertEqual(queued.messages.first?.content, "Send without waiting")
        let restored = await TaskifyWatchChatCoordinator(fileURL: fileURL).snapshot()
        XCTAssertEqual(restored.outbox.count, 1)
        XCTAssertEqual(restored.outbox.first?.rumorID, queued.outbox.first?.rumorID)
        XCTAssertEqual(restored.outbox.first?.wraps.map(\.event), queued.outbox.first?.wraps.map(\.event))
        XCTAssertEqual(restored.outbox.first?.deliveryState, .queued)
        XCTAssertEqual(
            try XCTUnwrap(restored.outbox.first).expiresAt.timeIntervalSince1970,
            try XCTUnwrap(queued.outbox.first).expiresAt.timeIntervalSince1970,
            accuracy: 0.001
        )
        XCTAssertEqual(restored.messages, queued.messages)
    }

    func testOverlappingRetriesShareOneFlushAndPreserveUnfinishedReplicas() async throws {
        let (coordinator, _, recipient) = try await configuredCoordinator()
        let queued = try await coordinator.send(
            content: "Deliver once", memberPublicKeys: [recipient], privateKey: senderKey
        )
        async let first = coordinator.retryOutbox(privateKey: senderKey)
        async let second = coordinator.retryOutbox(privateKey: senderKey)
        let (delivered, duplicate) = try await (first, second)
        XCTAssertEqual(GatewayStub.requests.count, 2, "One recipient wrap and one sender copy")
        XCTAssertTrue(GatewayStub.requests.allSatisfy { $0["returnAfterFirstAccepted"] as? Bool == true })
        XCTAssertEqual(delivered.messages.first?.deliveryState, .sent)
        XCTAssertEqual(duplicate.outbox, delivered.outbox)
        XCTAssertEqual(delivered.outbox.first?.wraps.map(\.event.id), queued.outbox.first?.wraps.map(\.event.id))
        let recipientWrap = try XCTUnwrap(delivered.outbox.first?.wraps.first { $0.recipientPublicKey == recipient })
        XCTAssertTrue(recipientWrap.isDelivered)
        XCTAssertFalse(recipientWrap.isFullyReplicated)
        XCTAssertEqual(recipientWrap.acknowledgements.last?.state, .pending)
    }

    func testClearingDuringDeliveryDoesNotRestoreOldMessages() async throws {
        let (coordinator, _, recipient) = try await configuredCoordinator()
        _ = try await coordinator.send(content: "Clear me", memberPublicKeys: [recipient], privateKey: senderKey)
        let retry = Task { try await coordinator.retryOutbox(privateKey: senderKey) }
        for _ in 0..<100 where GatewayStub.requests.isEmpty {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertFalse(GatewayStub.requests.isEmpty)
        _ = try await coordinator.clear()
        _ = try? await retry.value
        let cleared = await coordinator.snapshot()
        XCTAssertTrue(cleared.messages.isEmpty)
        XCTAssertTrue(cleared.outbox.isEmpty)
    }
}
