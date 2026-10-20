import Foundation
import Network
import XCTest
@testable import TaskifyCore

/// C10-4: an edit made outside the app is sent to the relays at once. The store keeps it marked
/// for publishing until every relay of its board has accepted it, so the app sends anything left.
final class ExternalPublishTests: XCTestCase {
    private var directory: URL!
    private var storeURL: URL { directory.appendingPathComponent(TaskifySharedContainer.storeFilename) }

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private actor Sent {
        var relays: [String] = []
        func add(_ relay: String) { relays.append(relay) }
    }

    /// Signs without proof of work, so no relay is asked for its limits.
    private static let prepare: TaskifyExternalPublisher.Prepare = { stamp in
        try TaskEventCodec.taskEvent(task: stamp.task, board: stamp.board, createdAt: stamp.timestamp)
    }

    private func seed() async throws -> JSONTaskStore {
        var snapshot = TaskifySnapshot.empty
        snapshot.tasks = [
            TaskItem(id: "milk", boardID: snapshot.selectedBoardID, title: "Buy milk"),
            TaskItem(id: "bread", boardID: snapshot.selectedBoardID, title: "Buy bread"),
        ]
        let store = JSONTaskStore(fileURL: storeURL, migratesLegacyStore: true)
        try await store.save(snapshot)
        return JSONTaskStore(fileURL: storeURL)
    }

    private func task(_ id: String) async throws -> TaskItem {
        let snapshot = try await JSONTaskStore(fileURL: storeURL).load()
        return try XCTUnwrap(snapshot.tasks.first { $0.id == id })
    }

    func testACompletionAcceptedByEveryRelayIsNoLongerPending() async throws {
        let store = try await seed()
        let sent = Sent()
        let publisher = TaskifyExternalPublisher(prepare: Self.prepare) { _, relay in
            await sent.add(relay)
            return true
        }
        let changed = try await TaskifyExternalActions.completeTask(
            "milk", store: store, settings: TaskifyDeviceTaskSettings(), publisher: publisher
        )
        XCTAssertTrue(changed)

        let milk = try await task("milk")
        XCTAssertTrue(milk.completed)
        XCTAssertNil(milk.publishPending)
        XCTAssertEqual(milk.nostrEventVersion?.createdAt, milk.nostrUpdatedAt)
        let board = try await JSONTaskStore(fileURL: storeURL).load().boards[0]
        let relays = await sent.relays
        XCTAssertEqual(Set(relays), Set(board.syncRelayURLs))
    }

    func testARelayThatRefusesLeavesItForTheApp() async throws {
        let store = try await seed()
        let board = try await JSONTaskStore(fileURL: storeURL).load().boards[0]
        let refusing = board.syncRelayURLs.last
        let publisher = TaskifyExternalPublisher(prepare: Self.prepare) { _, relay in relay != refusing }
        try await TaskifyExternalActions.completeTask("milk", store: store, settings: TaskifyDeviceTaskSettings(), publisher: publisher)

        let milk = try await task("milk")
        XCTAssertTrue(milk.completed)
        XCTAssertEqual(milk.publishPending, true)
        let stored = try await JSONTaskStore(fileURL: storeURL).load()
        XCTAssertEqual(TaskPublishPlanner.pendingTaskIDs(in: stored), ["milk"], "the app publishes it at launch")
    }

    func testTheTimeLimitLeavesItPending() async throws {
        let store = try await seed()
        let publisher = TaskifyExternalPublisher(timeLimit: .milliseconds(100), prepare: Self.prepare) { _, _ in
            try? await Task.sleep(for: .seconds(30))
            return true
        }
        let started = Date()
        try await TaskifyExternalActions.completeTask("milk", store: store, settings: TaskifyDeviceTaskSettings(), publisher: publisher)
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
        let pending = try await task("milk").publishPending
        XCTAssertEqual(pending, true)
    }

    func testAnAppSaveWhileTheRelaysAnswerIsKept() async throws {
        let store = try await seed()
        let storeURL = storeURL
        let publisher = TaskifyExternalPublisher(prepare: Self.prepare) { _, _ in
            // The app saves another edit in the meantime.
            let app = JSONTaskStore(fileURL: storeURL)
            if var snapshot = try? await app.load(),
               let index = snapshot.tasks.firstIndex(where: { $0.id == "bread" }),
               snapshot.tasks[index].title == "Buy bread" {
                snapshot.tasks[index].title = "Buy rye bread"
                _ = try? await app.save(snapshot)
            }
            return true
        }
        try await TaskifyExternalActions.completeTask("milk", store: store, settings: TaskifyDeviceTaskSettings(), publisher: publisher)

        let bread = try await task("bread")
        XCTAssertEqual(bread.title, "Buy rye bread")
        let milk = try await task("milk")
        XCTAssertTrue(milk.completed)
        XCTAssertNil(milk.publishPending)
    }

    func testDisabledPublishingStillSavesTheMark() async throws {
        let store = try await seed()
        try await TaskifyExternalActions.completeTask(
            "milk", store: store, settings: TaskifyDeviceTaskSettings(), publisher: .disabled
        )
        let milk = try await task("milk")
        XCTAssertTrue(milk.completed)
        XCTAssertEqual(milk.publishPending, true)
    }
}

/// The real sender against a relay on this machine: EVENT in, OK out.
final class ExternalPublishRelayTests: XCTestCase {
    /// Answers every EVENT with `OK <id> <accepted> <message>`.
    private final class LocalRelay: @unchecked Sendable {
        let listener: NWListener
        private let reply: (String) -> (Bool, String)
        private let queue = DispatchQueue(label: "LocalRelay")

        init(reply: @escaping (String) -> (Bool, String)) throws {
            self.reply = reply
            let parameters = NWParameters.tcp
            let websocket = NWProtocolWebSocket.Options()
            parameters.defaultProtocolStack.applicationProtocols.insert(websocket, at: 0)
            listener = try NWListener(using: parameters, on: .any)
            listener.newConnectionHandler = { [weak self] connection in
                guard let self else { return }
                connection.start(queue: self.queue)
                self.receive(on: connection)
            }
        }

        func start() async throws -> UInt16 {
            listener.start(queue: queue)
            for _ in 0..<100 {
                if let port = listener.port?.rawValue, port != 0 { return port }
                try await Task.sleep(for: .milliseconds(20))
            }
            throw URLError(.cannotConnectToHost)
        }

        private func receive(on connection: NWConnection) {
            connection.receiveMessage { [weak self] data, _, _, error in
                guard let self, error == nil else { return }
                if let data, let array = try? JSONSerialization.jsonObject(with: data) as? [Any],
                   array.first as? String == "EVENT", let event = array.last as? [String: Any],
                   let id = event["id"] as? String {
                    let (accepted, message) = self.reply(id)
                    let response = try! JSONSerialization.data(withJSONObject: ["OK", id, accepted, message])
                    let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
                    let context = NWConnection.ContentContext(identifier: "ok", metadata: [metadata])
                    connection.send(content: response, contentContext: context, completion: .idempotent)
                }
                self.receive(on: connection)
            }
        }
    }

    private func event() throws -> NostrEvent {
        let board = Board.week()
        return try TaskEventCodec.taskEvent(
            task: TaskItem(id: "milk", boardID: board.id, title: "Buy milk"), board: board, createdAt: 1_790_000_000
        )
    }

    func testTheSenderReadsTheRelaysAnswer() async throws {
        for (answer, expected) in [((true, ""), true), ((false, "blocked: no"), false), ((false, "duplicate: have it"), true)] {
            let relay = try LocalRelay { _ in answer }
            let port = try await relay.start()
            defer { relay.listener.cancel() }
            let accepted = await TaskifyExternalPublisher.sendToRelay(try event(), relay: "ws://127.0.0.1:\(port)")
            XCTAssertEqual(accepted, expected, "\(answer)")
        }
    }
}
