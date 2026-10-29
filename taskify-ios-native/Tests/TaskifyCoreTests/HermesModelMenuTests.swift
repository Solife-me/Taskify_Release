import Foundation
import XCTest
@testable import TaskifyCore

final class HermesModelMenuTests: XCTestCase {
    private struct VectorFile: Decodable {
        let modelListings: [ModelListingVector]
        let providerCatalogs: [ProviderCatalogVector]
        let confirmations: [ConfirmationVector]
        let invalidModelListings: [String]
        let invalidProviderCatalogs: [String]
    }

    private struct ModelListingVector: Decodable {
        let name: String
        let text: String
        let expected: HermesModelListing
    }

    private struct ProviderCatalogVector: Decodable {
        let name: String
        let text: String
        let expectedProviderSlug: String
        let expected: HermesProviderCatalog
    }

    private struct ConfirmationVector: Decodable {
        let name: String
        let text: String
        let expected: HermesModelSwitchConfirmation
    }

    private static let fixtureURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appendingPathComponent("taskify-core/fixtures/hermes-bot-menu-vectors.json")

    private func fixture() throws -> VectorFile {
        try JSONDecoder().decode(VectorFile.self, from: Data(contentsOf: Self.fixtureURL))
    }

    func testModelListingsMatchSharedVectors() throws {
        for vector in try fixture().modelListings {
            XCTAssertEqual(HermesModelMenuParser.parseListing(vector.text), vector.expected, vector.name)
        }
    }

    func testProviderCatalogsMatchSharedVectors() throws {
        for vector in try fixture().providerCatalogs {
            XCTAssertEqual(
                HermesModelMenuParser.parseProviderCatalog(vector.text, expectedProviderSlug: vector.expectedProviderSlug),
                vector.expected,
                vector.name
            )
        }
    }

    func testConfirmationsMatchSharedVectors() throws {
        for vector in try fixture().confirmations {
            XCTAssertEqual(HermesModelMenuParser.parseConfirmation(vector.text), vector.expected, vector.name)
        }
    }

    func testInvalidShapesAreIgnored() throws {
        let file = try fixture()
        for text in file.invalidModelListings {
            XCTAssertNil(HermesModelMenuParser.parseListing(text))
        }
        for text in file.invalidProviderCatalogs {
            XCTAssertNil(HermesModelMenuParser.parseProviderCatalog(text, expectedProviderSlug: "custom:local"))
        }
        XCTAssertNil(HermesModelMenuParser.parseConfirmation("Model not changed."))
    }

    func testIdentifiersAndPageSizesMatchPWA() {
        XCTAssertEqual(HermesModelMenuParser.providerPageSize, 10)
        XCTAssertEqual(HermesModelMenuParser.modelPageSize, 8)
        XCTAssertTrue(HermesModelMenuParser.isValidProviderSlug("custom:local"))
        XCTAssertFalse(HermesModelMenuParser.isValidProviderSlug("bad provider"))
        XCTAssertTrue(HermesModelMenuParser.isValidModelId("openai/gpt-6-astra"))
        XCTAssertFalse(HermesModelMenuParser.isValidModelId("model with spaces"))
    }
}
