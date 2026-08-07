import Foundation
import XCTest
@testable import TaskifyCore

final class TaskifyFileServerListTests: XCTestCase {
    func testNormalizedURLStripsTrailingSlashQueryFragmentAndCredentials() {
        XCTAssertEqual(
            TaskifyFileServerList.normalizedURL("  https://example.com///  "),
            "https://example.com"
        )
        XCTAssertEqual(
            TaskifyFileServerList.normalizedURL("https://example.com/path/?query=1#frag"),
            "https://example.com/path"
        )
        XCTAssertEqual(
            TaskifyFileServerList.normalizedURL("https://user:pass@example.com"),
            "https://example.com"
        )
    }

    func testNormalizedURLAddsHTTPSSchemeWhenMissing() {
        XCTAssertEqual(TaskifyFileServerList.normalizedURL("example.com"), "https://example.com")
    }

    func testNormalizedURLRejectsEmptyInput() {
        XCTAssertNil(TaskifyFileServerList.normalizedURL(""))
        XCTAssertNil(TaskifyFileServerList.normalizedURL("   "))
    }

    func testParseFallsBackToDefaultsForNilEmptyOrInvalidJSON() {
        XCTAssertEqual(TaskifyFileServerList.parse(nil), TaskifyFileServerList.defaults)
        XCTAssertEqual(TaskifyFileServerList.parse("not json"), TaskifyFileServerList.defaults)
        XCTAssertEqual(TaskifyFileServerList.parse("[]"), TaskifyFileServerList.defaults)
    }

    func testParseDecodesPWAShapedJSONAndNormalizesURLs() {
        let json = #"[{"url":"https://blossom.band/","type":"blossom","label":"blossom.band"},{"url":"nostr.build","type":"nip96"}]"#
        let servers = TaskifyFileServerList.parse(json)

        XCTAssertEqual(servers.count, 2)
        XCTAssertEqual(servers[0].url, "https://blossom.band")
        XCTAssertEqual(servers[0].type, .blossom)
        XCTAssertEqual(servers[0].label, "blossom.band")
        XCTAssertEqual(servers[1].url, "https://nostr.build")
        XCTAssertEqual(servers[1].type, .nip96)
    }

    func testParseDropsEntriesWithUnrecognizedURLsAndFallsBackIfAllDropped() {
        let mixed = #"[{"url":"","type":"blossom"},{"url":"https://good.example","type":"originless"}]"#
        XCTAssertEqual(TaskifyFileServerList.parse(mixed).map(\.url), ["https://good.example"])

        let allInvalid = #"[{"url":"","type":"blossom"}]"#
        XCTAssertEqual(TaskifyFileServerList.parse(allInvalid), TaskifyFileServerList.defaults)
    }

    func testSerializeRoundTripsThroughParse() {
        let servers = [
            TaskifyFileServerEntry(url: "https://one.example", type: .blossom, label: "One"),
            TaskifyFileServerEntry(url: "https://two.example/", type: .originless),
        ]
        let json = TaskifyFileServerList.serialize(servers)
        let reparsed = TaskifyFileServerList.parse(json)

        XCTAssertEqual(reparsed.map(\.url), ["https://one.example", "https://two.example"])
        XCTAssertEqual(reparsed.map(\.type), [.blossom, .originless])
        XCTAssertEqual(reparsed[0].label, "One")
    }

    func testFindMatchesByNormalizedURL() {
        let servers = [TaskifyFileServerEntry(url: "https://example.com", type: .originless)]
        XCTAssertEqual(TaskifyFileServerList.find(servers, url: "https://example.com/")?.url, "https://example.com")
        XCTAssertNil(TaskifyFileServerList.find(servers, url: "https://other.example"))
    }

    func testEntryDisplayLabelPrefersExplicitLabelThenHost() {
        let labeled = TaskifyFileServerEntry(url: "https://example.com", type: .originless, label: "My server")
        let unlabeled = TaskifyFileServerEntry(url: "https://example.com/path", type: .originless)

        XCTAssertEqual(labeled.displayLabel, "My server")
        XCTAssertEqual(unlabeled.displayLabel, "example.com")
    }
}
