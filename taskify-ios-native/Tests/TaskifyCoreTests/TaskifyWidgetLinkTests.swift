import Foundation
import XCTest
@testable import TaskifyCore

final class TaskifyWidgetLinkTests: XCTestCase {
    private struct VectorFile: Decodable {
        let vectors: [Vector]
        let invalidAppURLs: [String]
    }

    private struct Vector: Decodable {
        struct Destination: Decodable {
            let kind: String
            let id: String?
            let boardId: String?
            let columnId: String?
        }

        let name: String
        let destination: Destination
        let appURL: String
    }

    private static let vectorsURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // TaskifyCoreTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // taskify-ios-native
        .deletingLastPathComponent() // repository root
        .appendingPathComponent("taskify-core/fixtures/taskify-link-vectors.json")

    private static func link(for destination: Vector.Destination) throws -> TaskifyWidgetLink {
        switch destination.kind {
        case "upcoming":
            return .upcoming
        case "boards":
            return .boards
        case "task":
            return .task(
                id: try XCTUnwrap(destination.id),
                boardID: destination.boardId ?? ""
            )
        case "event":
            return .event(
                id: try XCTUnwrap(destination.id),
                boardID: destination.boardId ?? ""
            )
        case "quick-add":
            return .quickAdd(boardID: destination.boardId, columnID: destination.columnId)
        default:
            throw XCTSkip("Unknown shared link kind \(destination.kind)")
        }
    }

    func testMatchesSharedLinkVectors() throws {
        let data = try Data(contentsOf: Self.vectorsURL)
        let fixture = try JSONDecoder().decode(VectorFile.self, from: data)
        XCTAssertFalse(fixture.vectors.isEmpty)

        for vector in fixture.vectors {
            let expected = try Self.link(for: vector.destination)
            XCTAssertEqual(expected.url.absoluteString, vector.appURL, vector.name)
            XCTAssertEqual(TaskifyWidgetLink(url: try XCTUnwrap(URL(string: vector.appURL))), expected, vector.name)
        }

        for raw in fixture.invalidAppURLs {
            XCTAssertNil(TaskifyWidgetLink(url: try XCTUnwrap(URL(string: raw))), raw)
        }
    }

    /// The widget builds these and the app parses them. A disagreement is silent -- the app just
    /// ignores the URL and nothing happens, which is how the Control Center button ended up dead.
    func testEveryLinkRoundTrips() {
        let links: [TaskifyWidgetLink] = [
            .upcoming,
            .boards,
            .task(id: "task-1", boardID: "board-1"),
            .event(id: "event-1", boardID: "board-1"),
            .quickAdd(boardID: "board-1", columnID: "column-1"),
            .quickAdd(boardID: "board-1", columnID: nil),
            .quickAdd(boardID: nil, columnID: nil),
        ]
        for link in links {
            XCTAssertEqual(TaskifyWidgetLink(url: link.url), link, "\(link.url)")
        }
    }

    func testUsesTheRegisteredScheme() {
        XCTAssertEqual(TaskifyWidgetLink.scheme, "taskify")
        for link in [TaskifyWidgetLink.upcoming, .boards, .quickAdd(boardID: nil, columnID: nil)] {
            XCTAssertEqual(link.url.scheme, "taskify")
        }
    }

    func testTaskLinkCarriesBothIdentifiers() {
        let url = TaskifyWidgetLink.task(id: "t1", boardID: "b1").url
        XCTAssertEqual(url.absoluteString, "taskify://task?id=t1&board=b1")
    }

    func testEventLinkCarriesBothIdentifiers() {
        let url = TaskifyWidgetLink.event(id: "e1", boardID: "b1").url
        XCTAssertEqual(url.absoluteString, "taskify://event?id=e1&board=b1")
    }

    func testQuickAddOmitsAnEmptyBoard() {
        XCTAssertEqual(TaskifyWidgetLink.quickAdd(boardID: nil, columnID: nil).url.absoluteString, "taskify://quick-add")
        XCTAssertEqual(TaskifyWidgetLink.quickAdd(boardID: "", columnID: "").url.absoluteString, "taskify://quick-add")
    }

    func testQuickAddCarriesBoardAndColumn() {
        let link = TaskifyWidgetLink.quickAdd(boardID: "b1", columnID: "c1")
        XCTAssertEqual(link.url.absoluteString, "taskify://quick-add?board=b1&column=c1")
        XCTAssertEqual(TaskifyWidgetLink(url: link.url), link)
    }

    func testRejectsForeignAndUnknownURLs() {
        for raw in [
            "https://example.com/upcoming",
            "taskify://nonsense",
            "taskify://task",           // no id
            "taskify://task?board=b1",  // still no id
            "taskify://event",          // no id
        ] {
            XCTAssertNil(TaskifyWidgetLink(url: URL(string: raw)!), raw)
        }
    }

    /// A task link with no board still opens the task's app section rather than being dropped.
    func testTaskLinkToleratesAMissingBoard() {
        let url = URL(string: "taskify://task?id=t1")!
        XCTAssertEqual(TaskifyWidgetLink(url: url), .task(id: "t1", boardID: ""))
    }
}
