import CryptoKit
import Foundation
import XCTest
@testable import TaskifyCore

final class DMPushRegistrationClientTests: XCTestCase {
    private let privateKey = try! Data(hex: String(repeating: "0", count: 63) + "1")

    func testRegistrationURLUsesAnEscapedInstallationPath() throws {
        let baseURL = try XCTUnwrap(URL(string: "https://push.solife.me"))
        XCTAssertEqual(
            DMPushRegistrationClient.registrationURL(baseURL: baseURL, installationID: "phone one").absoluteString,
            "https://push.solife.me/v1/registrations/phone%20one"
        )
    }

    func testAuthHeaderBindsMethodURLAndPayload() throws {
        let url = try XCTUnwrap(URL(string: "https://push.solife.me/v1/registrations/device-1"))
        let body = Data(#"{"deviceToken":"aabb","environment":"production"}"#.utf8)
        let header = try DMPushRegistrationClient.authHeader(
            privateKey: privateKey,
            url: url,
            method: "PUT",
            body: body,
            now: Date(timeIntervalSince1970: 1_700_000_000)
        )
        let encoded = String(header.dropFirst("Nostr ".count))
        let event = try JSONDecoder().decode(
            NostrEvent.self,
            from: try XCTUnwrap(Data(base64Encoded: encoded))
        )

        XCTAssertEqual(event.kind, 27_235)
        XCTAssertTrue(event.verify())
        XCTAssertTrue(event.tags.contains(["u", url.absoluteString]))
        XCTAssertTrue(event.tags.contains(["method", "PUT"]))
        XCTAssertTrue(event.tags.contains(["payload", Data(SHA256.hash(data: body)).hexString]))
    }
}
