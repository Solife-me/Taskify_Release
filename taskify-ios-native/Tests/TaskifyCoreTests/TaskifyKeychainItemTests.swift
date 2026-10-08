import Foundation
import Security
import XCTest
@testable import TaskifyCore

/// Round-trips a uniquely named item and removes it again. On macOS an unsigned test runner cannot
/// use the data protection keychain, so this exercises the fallback a development build takes.
final class TaskifyKeychainItemTests: XCTestCase {
    private var query: [String: Any] = [:]

    override func setUp() {
        super.setUp()
        query = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "solife.me.Taskify.tests.\(UUID().uuidString)",
            kSecAttrAccount as String: "item",
        ]
    }

    override func tearDown() {
        TaskifyKeychainItem.delete(query)
        super.tearDown()
    }

    func testSaveLoadReplaceAndDelete() throws {
        do {
            XCTAssertNil(try TaskifyKeychainItem.load(query))
            try TaskifyKeychainItem.save(query, value: Data("first".utf8))
            XCTAssertEqual(try TaskifyKeychainItem.load(query), Data("first".utf8))
            try TaskifyKeychainItem.save(query, value: Data("second".utf8))
            XCTAssertEqual(try TaskifyKeychainItem.load(query), Data("second".utf8))
            TaskifyKeychainItem.delete(query)
            XCTAssertNil(try TaskifyKeychainItem.load(query))
        } catch let failure as TaskifyKeychainItem.Failure where failure.status == errSecMissingEntitlement
            || failure.status == errSecInteractionNotAllowed || failure.status == errSecNotAvailable {
            throw XCTSkip("No usable keychain in this test environment (\(failure.status)).")
        }
    }
}
