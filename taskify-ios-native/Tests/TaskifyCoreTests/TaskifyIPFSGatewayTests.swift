import Foundation
import XCTest
@testable import TaskifyCore

final class TaskifyIPFSGatewayTests: XCTestCase {
    /// The CID from a real upload to originless.solife.me, whose gateway URL was verified serving
    /// the uploaded bytes.
    private let cid = "QmS5cF4AsRFFvHZW8pRRVk7XxN516jqcTeXMYwFJwRgWc1"

    func testBuildsAGatewayURLForACID() {
        XCTAssertEqual(
            TaskifyIPFSGateway.url(forCID: cid),
            "https://dweb.link/ipfs/\(cid)"
        )
    }

    func testAcceptsCIDv1() {
        let v1 = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy"
        XCTAssertEqual(TaskifyIPFSGateway.url(forCID: v1), "https://dweb.link/ipfs/\(v1)")
    }

    func testTrimsWhitespaceAroundTheCID() {
        XCTAssertEqual(
            TaskifyIPFSGateway.url(forCID: "  \(cid)\n"),
            "https://dweb.link/ipfs/\(cid)"
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
}
