import CryptoKit
import Foundation
import XCTest
import TaskifyWatchShared
@testable import TaskifyWatchChatRuntime

private final class PreferenceTransport: URLProtocol {
    struct Captured {
        let request: URLRequest
        let data: Data
        let body: [String: Any]
    }
    private static let lock = NSLock()
    private static var captured: [Captured] = []
    private static var response: [String: Any] = [:]
    private static var status = 200

    static func configure(_ response: [String: Any], status: Int = 200) {
        lock.lock()
        defer { lock.unlock() }
        Self.response = response
        Self.status = status
        captured = []
    }

    static var requests: [Captured] {
        lock.lock()
        defer { lock.unlock() }
        return captured
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

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
        Self.captured.append(Captured(request: request, data: data, body: body))
        var response = Self.response
        var status = Self.status
        Self.lock.unlock()
        if request.url?.path == "/v1/watch/outbox/submit" {
            let event = body["event"] as? [String: Any] ?? [:]
            response = [
                "eventID": event["id"] as? String ?? "", "accepted": 1,
                "results": (body["relays"] as? [String] ?? []).map {
                    ["relay": $0, "status": "accepted"]
                },
            ]
            status = 200
        }
        let encoded = try! JSONSerialization.data(withJSONObject: response)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil
        )!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: encoded)
        client?.urlProtocolDidFinishLoading(self)
    }
}

final class TaskifyWatchPreferenceLookupTests: XCTestCase {
    private let senderKey = Data(repeating: 1, count: 32)
    private let recipientKey = Data(repeating: 2, count: 32)
    private let discoveryRelays = ["wss://first.example", "wss://second.example"]

    private func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PreferenceTransport.self]
        let session = URLSession(configuration: configuration)
        addTeardownBlock { session.invalidateAndCancel() }
        return session
    }

    private func preference(
        key: Data? = nil,
        relays: [String] = ["wss://inbox.example"],
        createdAt: Int = 1_700_000_000,
        kind: Int = 10_050
    ) throws -> TaskifyWatchNostrEvent {
        try TaskifyWatchNostrCrypto.signedEvent(
            privateKey: key ?? recipientKey, createdAt: createdAt, kind: kind,
            tags: relays.map { ["relay", $0] }, content: ""
        )
    }

    private func json(_ event: TaskifyWatchNostrEvent) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(event)) as! [String: Any]
    }

    private func lookup() async throws -> TaskifyWatchRelayDiscoveryResult {
        let client = try TaskifyWatchChatGatewayClient(
            baseURL: URL(string: "https://gateway.example")!, session: session()
        )
        return try await client.preferenceEvents(
            recipientPublicKey: TaskifyWatchNostrCrypto.publicKeyHex(for: recipientKey),
            relayURLs: discoveryRelays, privateKey: senderKey
        )
    }

    func testLookupUsesSignedHTTPSAndOnlySendsPublicRecipientAndDiscoveryRelays() async throws {
        let event = try preference()
        PreferenceTransport.configure(["events": [try json(event)], "completedRelays": discoveryRelays])
        let result = try await lookup()
        XCTAssertEqual(result.events, [event])
        XCTAssertTrue(result.discoveryComplete)
        let captured = try XCTUnwrap(PreferenceTransport.requests.first)
        XCTAssertEqual(captured.request.url?.absoluteString, "https://gateway.example/v1/watch/inbox-preference/query")
        XCTAssertEqual(captured.request.httpMethod, "POST")
        XCTAssertEqual(Set(captured.body.keys), ["recipientPublicKey", "relays"])
        XCTAssertEqual(captured.body["recipientPublicKey"] as? String, event.publicKey)
        let header = try XCTUnwrap(captured.request.value(forHTTPHeaderField: "Authorization"))
        let auth = try JSONDecoder().decode(TaskifyWatchNostrEvent.self, from: XCTUnwrap(
            Data(base64Encoded: String(header.dropFirst("Nostr ".count)))
        ))
        XCTAssertTrue(TaskifyWatchNostrCrypto.verify(auth))
        XCTAssertEqual(auth.publicKey, try TaskifyWatchNostrCrypto.publicKeyHex(for: senderKey))
        XCTAssertEqual(auth.kind, 27_235)
        XCTAssertEqual(auth.firstTagValue(named: "u"), captured.request.url?.absoluteString)
        XCTAssertEqual(auth.firstTagValue(named: "payload"), SHA256.hash(data: captured.data).map {
            String(format: "%02x", $0)
        }.joined())
    }

    func testGatewayCannotSubstituteAnUnsignedWrongAuthorOrWrongKindPreference() async throws {
        var forged = try json(preference())
        forged["tags"] = [["relay", "wss://forged.example"]]
        for event in [forged, try json(preference(key: senderKey)), try json(preference(kind: 1))] {
            PreferenceTransport.configure(["events": [event], "completedRelays": discoveryRelays])
            do {
                _ = try await lookup()
                XCTFail("Unverified preference must not become a routing or absence decision")
            } catch TaskifyWatchChatClientError.invalidResponse {} // Expected.
        }
    }

    func testIncompleteDiscoveryRemainsDistinctFromConfirmedAbsence() async throws {
        for completed in [[], [discoveryRelays[0]], discoveryRelays] {
            PreferenceTransport.configure(["events": [], "completedRelays": completed])
            let result = try await lookup()
            XCTAssertEqual(result.discoveryComplete, completed.count == 2)
        }
        PreferenceTransport.configure(["events": [], "completedRelays": ["wss://unrequested.example"]])
        do {
            _ = try await lookup()
            XCTFail("Unrequested relays cannot establish absence")
        } catch TaskifyWatchChatClientError.invalidResponse {}
    }

    private func coordinator() async throws -> TaskifyWatchChatCoordinator {
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString).appendingPathComponent("chat.json")
        addTeardownBlock { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let coordinator = TaskifyWatchChatCoordinator(fileURL: fileURL, session: session())
        _ = try await coordinator.configure(TaskifyWatchChatProvisioningContext(
            contacts: [TaskifyWatchContact(
                publicKey: TaskifyWatchNostrCrypto.publicKeyHex(for: recipientKey), npub: "", displayName: "Recipient"
            )],
            discoveryRelayURLs: discoveryRelays,
            accountInboxPreferenceEvent: preference(
                key: senderKey, relays: ["wss://sender.example"], createdAt: Int(Date().timeIntervalSince1970)
            ),
            pushRelayHTTPSURL: URL(string: "https://gateway.example")!,
            pushRelayWSSURL: "wss://gateway.example"
        ))
        return coordinator
    }

    func testColdSendSelectsNewestSignedListAndReusesLookupAcrossMessages() async throws {
        let old = try preference(relays: ["wss://old.example"])
        let newest = try preference(relays: ["wss://published.example"], createdAt: old.createdAt + 1)
        PreferenceTransport.configure(["events": [try json(old), try json(newest)], "completedRelays": []])
        let coordinator = try await coordinator()
        for content in ["First private message", "Second private message"] {
            _ = try await coordinator.send(content: content, memberPublicKeys: [newest.publicKey], privateKey: senderKey)
            let delivered = try await coordinator.retryOutbox(privateKey: senderKey)
            XCTAssertTrue(delivered.outbox.allSatisfy(\.areRecipientCopiesDelivered))
        }
        let requests = PreferenceTransport.requests
        XCTAssertEqual(requests.filter { $0.request.url?.path.hasSuffix("/query") == true }.count, 1)
        let publishes = requests.filter { $0.request.url?.path.hasSuffix("/submit") == true }
        XCTAssertEqual(publishes.count, 4)
        XCTAssertEqual(publishes.map { $0.body["relays"] as? [String] }, [
            ["wss://published.example"], ["wss://sender.example"],
            ["wss://published.example"], ["wss://sender.example"],
        ])
    }

    func testUnavailableLookupKeepsFirstSendQueuedWithoutClaimingAbsence() async throws {
        PreferenceTransport.configure(["error": "not available"], status: 503)
        let coordinator = try await coordinator()
        _ = try await coordinator.send(
            content: "Keep this durable", memberPublicKeys: [TaskifyWatchNostrCrypto.publicKeyHex(for: recipientKey)],
            privateKey: senderKey
        )
        let pending = try await coordinator.retryOutbox(privateKey: senderKey)
        XCTAssertEqual(pending.messages.first?.deliveryState, .queued)
        XCTAssertTrue(pending.outbox.first!.wraps.allSatisfy { $0.routingDecision.status == .indeterminate })
        XCTAssertEqual(PreferenceTransport.requests.count, 1)
        XCTAssertNil(pending.contacts.first?.confirmedAbsentAt)
    }
}
