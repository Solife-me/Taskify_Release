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

extension HermesModelMenuTests {
    private static let listingText = """
    Current: `deepseek-v4.1-flash:cloud` on custom:local

    **local** `--provider custom:local` (current):
      `lfm3-audio:latest`, `deepseek-v4.1-flash:cloud` (+11 more)

    **Nous Portal** `--provider nous`:
      `anthropic/claude-opus-5.5`, `anthropic/claude-sonnet-5.5` (+67 more)
    """

    private static let menuID = String(repeating: "c", count: 64)
    private static let peer = String(repeating: "b", count: 64)

    private func message(
        id: String,
        content: String,
        incoming: Bool,
        createdAt: Int,
        action: TaskifyBotUiAction? = nil
    ) -> NostrDirectMessage {
        NostrDirectMessage(
            rumorEventID: id,
            wrapEventID: id,
            peerPublicKey: Self.peer,
            senderPublicKey: incoming ? Self.peer : String(repeating: "a", count: 64),
            content: content,
            createdAt: createdAt,
            isIncoming: incoming,
            botUiAction: action
        )
    }

    func testProjectionHidesCatalogTrafficAndReconstructsCatalog() throws {
        let listing = message(id: Self.menuID, content: Self.listingText, incoming: true, createdAt: 1)
        let action = TaskifyBotUiAction(kind: .catalogRequest, menuId: Self.menuID, providerSlug: "custom:local")
        let request = message(
            id: String(repeating: "d", count: 64),
            content: try TaskifyBotUiContract.catalogRequestPrompt(providerSlug: "custom:local"),
            incoming: false,
            createdAt: 2,
            action: action
        )
        let response = message(
            id: String(repeating: "e", count: 64),
            content: #"{"provider":"custom:local","models":["lfm3-audio:latest","deepseek-v4.1-flash:cloud"]}"#,
            incoming: true,
            createdAt: 3
        )

        let projection = HermesModelPickerProjection.project(
            messages: [listing, request, response],
            enabled: true
        )
        XCTAssertTrue(projection.hiddenMessageIDs.contains(request.id))
        XCTAssertTrue(projection.hiddenMessageIDs.contains(response.id))
        XCTAssertEqual(
            projection.menusByListingMessageID[listing.id]?.catalogs["custom:local"]?.models,
            ["lfm3-audio:latest", "deepseek-v4.1-flash:cloud"]
        )
        XCTAssertNil(projection.menusByListingMessageID[listing.id]?.pendingAction)
    }

    func testProjectionReconstructsCompletedModelSwitch() throws {
        let listing = message(id: Self.menuID, content: Self.listingText, incoming: true, createdAt: 1)
        let action = TaskifyBotUiAction(
            kind: .modelSelect,
            menuId: Self.menuID,
            providerSlug: "custom:local",
            modelId: "deepseek-v4.1-flash:cloud"
        )
        let request = message(
            id: String(repeating: "d", count: 64),
            content: try TaskifyBotUiContract.modelSwitchCommand(
                providerSlug: "custom:local",
                modelId: "deepseek-v4.1-flash:cloud"
            ),
            incoming: false,
            createdAt: 2,
            action: action
        )
        let response = message(
            id: String(repeating: "e", count: 64),
            content: "Model switched to `deepseek-v4.1-flash:cloud`\nProvider: local\nContext: 1,048,576 tokens",
            incoming: true,
            createdAt: 3
        )

        let projection = HermesModelPickerProjection.project(
            messages: [listing, request, response],
            enabled: true
        )
        XCTAssertTrue(projection.hiddenMessageIDs.contains(response.id))
        XCTAssertEqual(
            projection.menusByListingMessageID[listing.id]?.selectedModel,
            HermesSelectedModel(
                modelId: "deepseek-v4.1-flash:cloud",
                providerSlug: "custom:local",
                providerName: "local"
            )
        )
    }

    func testUnexpectedResponseStaysVisibleAndActionSurvivesSnapshotRoundTrip() throws {
        let listing = message(id: Self.menuID, content: Self.listingText, incoming: true, createdAt: 1)
        let action = TaskifyBotUiAction(kind: .catalogRequest, menuId: Self.menuID, providerSlug: "nous")
        let request = message(
            id: String(repeating: "d", count: 64),
            content: "request",
            incoming: false,
            createdAt: 2,
            action: action
        )
        let response = message(
            id: String(repeating: "e", count: 64),
            content: "I could not list those models.",
            incoming: true,
            createdAt: 3
        )

        let projection = HermesModelPickerProjection.project(
            messages: [listing, request, response],
            enabled: true
        )
        XCTAssertFalse(projection.hiddenMessageIDs.contains(response.id))
        XCTAssertEqual(
            projection.menusByListingMessageID[listing.id]?.failure?.responseEventId,
            response.id
        )

        let decoded = try JSONDecoder().decode(
            NostrDirectMessage.self,
            from: JSONEncoder().encode(request)
        )
        XCTAssertEqual(decoded.botUiAction, action)
    }

    func testCatalogPromptAndSwitchCommandMatchTheTestedHermesFlow() throws {
        let prompt = try TaskifyBotUiContract.catalogRequestPrompt(providerSlug: "custom:local")
        XCTAssertTrue(prompt.contains("provider slug `custom:local`"))
        XCTAssertTrue(prompt.contains(#"{"provider":"custom:local","models":["model-id"]}"#))
        XCTAssertEqual(
            try TaskifyBotUiContract.modelSwitchCommand(
                providerSlug: "custom:local",
                modelId: "deepseek-v4.1-flash:cloud"
            ),
            "/model deepseek-v4.1-flash:cloud --provider custom:local"
        )
    }
}
