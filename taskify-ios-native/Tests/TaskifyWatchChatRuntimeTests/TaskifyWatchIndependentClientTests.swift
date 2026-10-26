import Foundation
import XCTest
import TaskifyWatchShared
@testable import TaskifyWatchChatRuntime

private final class WatchIndependentTransport: URLProtocol {
    private static let lock = NSLock()
    private static var capturedURLs: [URL] = []

    static func reset() {
        lock.lock()
        defer { lock.unlock() }
        capturedURLs = []
    }

    static var urls: [URL] {
        lock.lock()
        defer { lock.unlock() }
        return capturedURLs
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let url = request.url!
        Self.lock.lock()
        Self.capturedURLs.append(url)
        Self.lock.unlock()

        let isWorker = url.host == "taskify.solife.me"
        let status = isWorker ? 200 : 503
        let workerBody = url.path.hasSuffix("/publish") ? #"{"accepted":1}"# : #"{"events":[]}"#
        let data = Data(isWorker ? workerBody.utf8 : #"{"error":"offline"}"#.utf8)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(
            url: url, statusCode: status, httpVersion: nil, headerFields: nil
        )!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
}

final class TaskifyWatchIndependentClientTests: XCTestCase {
    private let privateKey = Data(repeating: 7, count: 32)

    private func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WatchIndependentTransport.self]
        let session = URLSession(configuration: configuration)
        addTeardownBlock { session.invalidateAndCancel() }
        return session
    }

    private func profile() throws -> TaskifyWatchIndependentProfile {
        TaskifyWatchIndependentProfile(
            publicKeyHex: try TaskifyWatchNostrCrypto.publicKeyHex(for: privateKey),
            publicKeyNpub: "npub-test",
            relayURLs: ["wss://relay.example"]
        )
    }

    private func board() -> TaskifyWatchBoard {
        TaskifyWatchBoard(
            id: "board",
            name: "Board",
            openTaskCount: 0,
            nostrBoardID: "private-board-secret",
            relayURLs: ["wss://relay.example"]
        )
    }

    override func setUp() {
        super.setUp()
        WatchIndependentTransport.reset()
    }

    func testSelfHostedGatewayFailureNeverFallsBackToTaskifyWorker() async throws {
        let client = TaskifyWatchIndependentClient(session: session())

        do {
            _ = try await client.fetchTasks(
                boards: [board()],
                gatewayBaseURL: URL(string: "https://relay.example")!,
                profile: profile(),
                privateKey: privateKey
            )
            XCTFail("An unavailable self-hosted gateway must remain unavailable")
        } catch TaskifyWatchIndependentError.serviceUnavailable {
            // Expected. The request must not leave the configured self-hosted service.
        }

        XCTAssertEqual(
            WatchIndependentTransport.urls.map(\.absoluteString),
            ["https://relay.example/v1/watch/tasks/query"]
        )
    }

    func testTaskifyGatewayFailureStillUsesTemporaryWorkerFallback() async throws {
        let client = TaskifyWatchIndependentClient(session: session())

        let events = try await client.fetchTasks(
            boards: [board()],
            gatewayBaseURL: URL(string: "https://push.solife.me")!,
            profile: profile(),
            privateKey: privateKey
        )

        XCTAssertEqual(events, [])
        XCTAssertEqual(WatchIndependentTransport.urls.map(\.absoluteString), [
            "https://push.solife.me/v1/watch/tasks/query",
            "https://taskify.solife.me/api/watch/nostr/query",
        ])
    }

    func testSelfHostedPublishFailureNeverFallsBackToTaskifyWorker() async throws {
        let client = TaskifyWatchIndependentClient(session: session())
        let event = try TaskifyWatchNostrCrypto.taskEvent(
            taskID: "task",
            boardID: "private-board-secret",
            columnTag: "",
            status: "open",
            payload: Data("{}".utf8),
            createdAt: 1_793_000_000
        )

        do {
            try await client.publish(
                event,
                relayURLs: ["wss://relay.example"],
                boardID: "private-board-secret",
                gatewayBaseURL: URL(string: "https://relay.example")!,
                profile: profile(),
                privateKey: privateKey
            )
            XCTFail("An unavailable self-hosted gateway must remain unavailable")
        } catch TaskifyWatchIndependentError.serviceUnavailable {
            // Expected. The signed event must not leave the configured self-hosted service.
        }

        XCTAssertEqual(
            WatchIndependentTransport.urls.map(\.absoluteString),
            ["https://relay.example/v1/watch/task-events/publish"]
        )
    }
}
