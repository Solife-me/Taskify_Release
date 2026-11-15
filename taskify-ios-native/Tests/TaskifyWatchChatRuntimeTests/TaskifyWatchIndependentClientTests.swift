import Foundation
import XCTest
import TaskifyWatchShared
@testable import TaskifyWatchChatRuntime

private final class WatchIndependentTransport: URLProtocol {
    private static let lock = NSLock()
    private static var capturedURLs: [URL] = []
    private static var responder: ((URLRequest) -> Data)?

    static func reset() {
        lock.lock()
        defer { lock.unlock() }
        capturedURLs = []
        responder = nil
    }

    static func respond(_ response: @escaping (URLRequest) -> Data) {
        lock.lock()
        defer { lock.unlock() }
        responder = response
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
        let responder = Self.responder
        Self.lock.unlock()

        let isWorker = url.host == "taskify.solife.me"
        let status = isWorker || responder != nil ? 200 : 503
        let workerBody = url.path.hasSuffix("/publish") ? #"{"accepted":1}"# : #"{"events":[]}"#
        let data = responder?(request) ?? Data(isWorker ? workerBody.utf8 : #"{"error":"offline"}"#.utf8)
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

    func testHistoryResumesCappedPagesAndRecoversOlderTasksFromEveryBoard() async throws {
        struct Page: Encodable {
            let historyPage = true
            let refreshed = true
            let events: [TaskifyWatchNostrEvent]
        }
        let boardIDs = ["first-board-private-key", "second-board-private-key"]
        let boards = boardIDs.map { TaskifyWatchBoard(id: $0, name: $0, openTaskCount: 0, nostrBoardID: $0) }
        let stamp = Int(Date().timeIntervalSince1970)
        var fixtures: [String: [TaskifyWatchNostrEvent]] = [:]
        for boardID in boardIDs {
            let author = try TaskifyWatchNostrCrypto.boardPublicKeyHex(for: boardID)
            fixtures[author] = try (0..<7).map { number in
                try TaskifyWatchNostrCrypto.taskEvent(
                    taskID: "\(boardID)-\(number)", boardID: boardID, columnTag: "", status: "open",
                    payload: Data("{}".utf8), createdAt: stamp - 30 - number / 2
                )
            }
        }
        WatchIndependentTransport.respond { request in
            let body = request.httpBody ?? {
                guard let stream = request.httpBodyStream else { return Data() }
                stream.open()
                defer { stream.close() }
                var data = Data()
                var buffer = [UInt8](repeating: 0, count: 4_096)
                while stream.hasBytesAvailable {
                    let read = stream.read(&buffer, maxLength: buffer.count)
                    if read <= 0 { break }
                    data.append(buffer, count: read)
                }
                return data
            }()
            let object = try! JSONSerialization.jsonObject(with: body) as! [String: Any]
            let filter = object["filter"] as! [String: Any]
            let author = (filter["authors"] as! [String])[0]
            let until = filter["until"] as! Int
            let events = (fixtures[author] ?? []).filter { $0.createdAt <= until && $0.createdAt >= (filter["since"] as! Int) }
            return try! JSONEncoder().encode(Page(events: Array(events.prefix(3))))
        }
        let client = TaskifyWatchIndependentClient(session: session())
        let profile = TaskifyWatchIndependentProfile(
            publicKeyHex: try TaskifyWatchNostrCrypto.publicKeyHex(for: privateKey),
            publicKeyNpub: "npub-test", relayURLs: []
        )
        let started = try await client.recoverTaskHistory(
            boards: boards, gatewayBaseURL: nil, profile: profile, privateKey: privateKey, pageBudget: 3
        )
        XCTAssertFalse(started.completed)
        XCTAssertEqual(Set(started.events.map(\.publicKey)).count, 2)
        let continued = try await client.recoverTaskHistory(
            boards: boards, gatewayBaseURL: nil, profile: profile, privateKey: privateKey, previous: started.cursors
        )
        XCTAssertTrue(continued.completed)
        XCTAssertEqual(Set((started.events + continued.events).map(\.id)), Set(fixtures.values.flatMap { $0.map(\.id) }))
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
