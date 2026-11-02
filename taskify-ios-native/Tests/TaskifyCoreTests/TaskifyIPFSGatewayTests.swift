import Foundation
import XCTest
import TaskifyWatchShared

final class TaskifyIPFSGatewayTests: XCTestCase {
    /// The CID from a real upload to originless.solife.me.
    private let cid = "QmS5cF4AsRFFvHZW8pRRVk7XxN516jqcTeXMYwFJwRgWc1"

    func testBuildsAGatewayURLForACID() {
        XCTAssertEqual(
            TaskifyIPFSGateway.url(forCID: cid),
            "https://ipfs.filebase.io/ipfs/\(cid)"
        )
    }

    func testAcceptsCIDv1() {
        let v1 = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy"
        XCTAssertEqual(TaskifyIPFSGateway.url(forCID: v1), "https://ipfs.filebase.io/ipfs/\(v1)")
    }

    func testTrimsWhitespaceAroundTheCID() {
        XCTAssertEqual(
            TaskifyIPFSGateway.url(forCID: "  \(cid)\n"),
            "https://ipfs.filebase.io/ipfs/\(cid)"
        )
    }

    func testHonoursAnAlternateGatewayWithoutDoublingSlashes() {
        XCTAssertEqual(
            TaskifyIPFSGateway.url(forCID: cid, base: "https://ipfs.io/"),
            "https://ipfs.io/ipfs/\(cid)"
        )
    }

    func testSupportsAGatewayServedFromASubpath() {
        XCTAssertEqual(
            TaskifyIPFSGateway.url(forCID: cid, base: "https://example.com/gw"),
            "https://example.com/gw/ipfs/\(cid)"
        )
    }

    /// A malformed value must produce no URL rather than a plausible-looking one that 404s -- the
    /// caller falls through to its other resolution strategies instead.
    func testRejectsValuesThatArentCIDs() {
        for junk in ["", "   ", "/ipfs/abc", "https://example.com/file", "not a cid", "abc"] {
            XCTAssertNil(
                TaskifyIPFSGateway.url(forCID: junk),
                "expected nil for \(junk.isEmpty ? "<empty>" : junk)"
            )
        }
    }

    func testRejectsAnUnusableGatewayBase() {
        XCTAssertNil(TaskifyIPFSGateway.url(forCID: cid, base: ""))
        XCTAssertNil(TaskifyIPFSGateway.url(forCID: cid, base: "ftp://example.com"))
    }

    private func candidates(_ raw: String) -> [String] {
        TaskifyIPFSGateway.retrievalCandidates(for: URL(string: raw)!).map(\.absoluteString)
    }

    private var liveGateways: [String] {
        ["https://ipfs.filebase.io/ipfs/\(cid)", "https://gateway.pinata.cloud/ipfs/\(cid)"]
    }

    /// Messages sent before the 2026 shutdown carry these URLs for good; they must keep loading.
    func testRetiredGatewayURLsResolveToLiveGatewaysOnly() {
        XCTAssertEqual(candidates("https://dweb.link/ipfs/\(cid)"), liveGateways)
        XCTAssertEqual(candidates("https://ipfs.io/ipfs/\(cid)"), liveGateways)
        XCTAssertEqual(candidates("https://gateway.ipfs.io/ipfs/\(cid)"), liveGateways)
        XCTAssertEqual(candidates("https://w3s.link/ipfs/\(cid)"), liveGateways)
    }

    func testSubdomainGatewayURLsResolveToo() {
        let v1 = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy"
        XCTAssertEqual(candidates("https://\(v1).ipfs.dweb.link/"), [
            "https://ipfs.filebase.io/ipfs/\(v1)", "https://gateway.pinata.cloud/ipfs/\(v1)",
        ])
    }

    func testALiveGatewayIsTriedFirstWithoutDuplicates() {
        XCTAssertEqual(candidates("https://gateway.pinata.cloud/ipfs/\(cid)"), [
            "https://gateway.pinata.cloud/ipfs/\(cid)", "https://ipfs.filebase.io/ipfs/\(cid)",
        ])
        XCTAssertEqual(candidates("https://my.gateway.example/ipfs/\(cid)"),
                       ["https://my.gateway.example/ipfs/\(cid)"] + liveGateways)
    }

    func testOtherHostsAreLeftAlone() {
        for raw in ["https://blossom.band/\(cid)", "https://nostr.build/i/photo.jpg",
                    "https://files.example/ipfs/short"] {
            XCTAssertEqual(candidates(raw), [raw])
        }
    }

    func testFallsBackUntilACandidateSucceeds() async throws {
        var tried: [String] = []
        let result = try await TaskifyIPFSGateway.withRetrievalCandidates(
            for: URL(string: "https://dweb.link/ipfs/\(cid)")!
        ) { candidate, isLast -> String in
            tried.append(candidate.absoluteString)
            guard isLast else { throw URLError(.timedOut) }
            return candidate.absoluteString
        }
        XCTAssertEqual(tried, liveGateways)
        XCTAssertEqual(result, liveGateways[1])
    }

    func testRethrowsTheLastFailure() async {
        do {
            let _: Int = try await TaskifyIPFSGateway.withRetrievalCandidates(
                for: URL(string: "https://ipfs.filebase.io/ipfs/\(cid)")!
            ) { _, isLast in throw URLError(isLast ? .badServerResponse : .timedOut) }
            XCTFail("expected a failure")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .badServerResponse)
        }
    }

    func testCancellationStopsTheFallback() async {
        var attempts = 0
        do {
            let _: Int = try await TaskifyIPFSGateway.withRetrievalCandidates(
                for: URL(string: "https://ipfs.filebase.io/ipfs/\(cid)")!
            ) { _, _ in
                attempts += 1
                throw URLError(.cancelled)
            }
            XCTFail("expected cancellation")
        } catch {
            XCTAssertEqual(attempts, 1)
        }
    }
}
