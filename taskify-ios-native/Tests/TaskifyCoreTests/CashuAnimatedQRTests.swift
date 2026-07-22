import XCTest
@testable import TaskifyCore

final class CashuAnimatedQRTests: XCTestCase {
    func testAnimatedCashuQRRoundTripsOutOfOrderAndIgnoresDuplicates() throws {
        let token = "cashuB" + String(repeating: "test-token-payload-", count: 80)
        let animation = try XCTUnwrap(
            CashuAnimatedQRAnimation(token: token, maxFragmentLength: 80)
        )
        XCTAssertGreaterThan(animation.frames.count, 1)
        XCTAssertTrue(animation.frames.allSatisfy { $0.lowercased().hasPrefix("ur:bytes/") })

        let collector = CashuAnimatedQRCollector()
        if let first = animation.frames.first {
            guard case let .progress(received, expected, duplicate) = collector.add(first) else {
                return XCTFail("Expected initial scan progress")
            }
            XCTAssertEqual(received, 1)
            XCTAssertEqual(expected, animation.frames.count)
            XCTAssertFalse(duplicate)

            guard case let .progress(duplicateCount, _, isDuplicate) = collector.add(first) else {
                return XCTFail("Expected duplicate scan progress")
            }
            XCTAssertEqual(duplicateCount, 1)
            XCTAssertTrue(isDuplicate)
        }

        var result: CashuAnimatedQRCollectionResult = .notAnimated
        for frame in animation.frames.dropFirst().reversed() {
            result = collector.add(frame)
        }
        XCTAssertEqual(result, .complete(token: token))
    }

    func testSmallTokenDoesNotCreateAnimation() {
        XCTAssertNil(CashuAnimatedQRAnimation(token: "cashuBsmall", maxFragmentLength: 200))
    }

    func testCollectorRejectsMalformedURFrame() {
        let collector = CashuAnimatedQRCollector()
        XCTAssertEqual(
            collector.add("ur:bytes/not-valid"),
            .invalid(message: "That animated Cashu QR frame is invalid.")
        )
    }

    func testLegacyPWAFramesRoundTrip() {
        let token = "cashuBlegacy-token"
        let encoded = Data(token.utf8)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let midpoint = encoded.index(encoded.startIndex, offsetBy: encoded.count / 2)
        let chunks = [String(encoded[..<midpoint]), String(encoded[midpoint...])]
        let frames = chunks.enumerated().map {
            "cashuA:1:\($0.offset + 1):2:testdigest:\($0.element)"
        }

        let collector = CashuAnimatedQRCollector()
        guard case .progress(received: 1, expected: 2, duplicate: false) = collector.add(frames[0]) else {
            return XCTFail("Expected legacy scan progress")
        }
        XCTAssertEqual(collector.add(frames[1]), .complete(token: token))
    }
}
