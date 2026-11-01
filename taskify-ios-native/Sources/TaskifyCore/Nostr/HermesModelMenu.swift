import Foundation

/// Taskify's native adapter for Hermes's text-only `/model` experience.
/// Hermes cannot emit Taskify UI metadata, so only values recognized in its known response shapes
/// become buttons. The shared fixture in `taskify-core/fixtures/hermes-bot-menu-vectors.json`
/// keeps this parser aligned with the PWA parser.
public struct HermesModelProvider: Codable, Equatable, Sendable {
    public var name: String
    public var slug: String
    public var previewModels: [String]
    public var totalModels: Int
    public var isCurrent: Bool

    public init(name: String, slug: String, previewModels: [String], totalModels: Int, isCurrent: Bool) {
        self.name = name
        self.slug = slug
        self.previewModels = previewModels
        self.totalModels = totalModels
        self.isCurrent = isCurrent
    }
}

public struct HermesModelListing: Codable, Equatable, Sendable {
    public var currentModel: String?
    public var currentProviderSlug: String?
    public var providers: [HermesModelProvider]

    public init(currentModel: String?, currentProviderSlug: String?, providers: [HermesModelProvider]) {
        self.currentModel = currentModel
        self.currentProviderSlug = currentProviderSlug
        self.providers = providers
    }
}

public struct HermesProviderCatalog: Codable, Equatable, Sendable {
    public var providerName: String?
    public var providerSlug: String
    public var models: [String]

    public init(providerName: String?, providerSlug: String, models: [String]) {
        self.providerName = providerName
        self.providerSlug = providerSlug
        self.models = models
    }
}

public struct HermesModelSwitchConfirmation: Codable, Equatable, Sendable {
    public var modelId: String
    public var providerName: String?

    public init(modelId: String, providerName: String?) {
        self.modelId = modelId
        self.providerName = providerName
    }
}

public enum HermesModelMenuParser {
    public static let providerPageSize = 10
    public static let modelPageSize = 8

    private static let providerPattern = #"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"#
    private static let modelPattern = #"^[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,199}$"#

    public static func isValidProviderSlug(_ value: String) -> Bool {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
            .range(of: providerPattern, options: .regularExpression) != nil
    }

    public static func isValidModelId(_ value: String) -> Bool {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
            .range(of: modelPattern, options: .regularExpression) != nil
    }

    private static func normalizedLines(_ text: String) -> [String] {
        text.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: "\n")
    }

    private static func cleanLabel(_ value: String, limit: Int = 120) -> String {
        value.components(separatedBy: .controlCharacters)
            .joined(separator: " ")
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
            .prefix(limit)
            .description
    }

    private static func codeSpans(in text: String) -> [String] {
        var spans: [String] = []
        var cursor = text.startIndex
        while let open = text[cursor...].firstIndex(of: "`") {
            let contentStart = text.index(after: open)
            guard let close = text[contentStart...].firstIndex(of: "`") else { break }
            let value = String(text[contentStart..<close]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty { spans.append(value) }
            cursor = text.index(after: close)
        }
        return spans
    }

    private static func uniqueModels(_ values: [String]) -> [String] {
        var models: [String] = []
        var seen = Set<String>()
        for raw in values {
            let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard isValidModelId(value) else { continue }
            let key = value.lowercased()
            guard seen.insert(key).inserted else { continue }
            models.append(value)
        }
        return models
    }

    private static func providerHeading(
        _ line: String
    ) -> (name: String, slug: String, isCurrent: Bool)? {
        guard let openBold = line.range(of: "**"),
              let closeBold = line[openBold.upperBound...].range(of: "**"),
              let marker = line.range(of: "`--provider "),
              let closeSlug = line[marker.upperBound...].firstIndex(of: "`") else { return nil }
        let name = cleanLabel(String(line[openBold.upperBound..<closeBold.lowerBound]))
        let slug = String(line[marker.upperBound..<closeSlug]).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, isValidProviderSlug(slug) else { return nil }
        let tail = String(line[line.index(after: closeSlug)...])
        let current = tail.range(of: "(current)", options: .caseInsensitive) != nil
        guard tail.contains(":") || current else { return nil }
        return (name, slug, current)
    }

    public static func parseListing(_ text: String) -> HermesModelListing? {
        let lines = normalizedLines(text)
        let headings = lines.enumerated().compactMap { index, line -> (index: Int, name: String, slug: String, isCurrent: Bool)? in
            guard let parsed = providerHeading(line) else { return nil }
            return (index, parsed.name, parsed.slug, parsed.isCurrent)
        }
        guard !headings.isEmpty else { return nil }

        var providers: [HermesModelProvider] = []
        var seen = Set<String>()
        for (offset, heading) in headings.enumerated() {
            var end = headings.dropFirst(offset + 1).first?.index ?? lines.count
            if let usage = lines.indices.first(where: { index in
                index > heading.index && lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("`/model")
            }) {
                end = min(end, usage)
            }
            let block = lines[(heading.index + 1)..<end].joined(separator: "\n")
            let preview = uniqueModels(codeSpans(in: block))
            var hidden = 0
            if let match = block.range(of: #"\(\+\d+\s+more\)"#, options: .regularExpression) {
                let digits = block[match].filter(\.isNumber)
                hidden = Int(digits) ?? 0
            }
            let key = heading.slug.lowercased()
            guard seen.insert(key).inserted else { continue }
            providers.append(HermesModelProvider(
                name: heading.name,
                slug: heading.slug,
                previewModels: preview,
                totalModels: preview.count + hidden,
                isCurrent: heading.isCurrent
            ))
        }
        guard !providers.isEmpty else { return nil }

        var currentModel: String?
        var currentProviderSlug: String?
        let pattern = #"^\s*Current:\s*`([^`]+)`\s+on\s+([^\s`]+)\s*$"#
        if let expression = try? NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines]),
           let match = expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
           let modelRange = Range(match.range(at: 1), in: text),
           let providerRange = Range(match.range(at: 2), in: text) {
            let model = String(text[modelRange]).trimmingCharacters(in: .whitespacesAndNewlines)
            let provider = String(text[providerRange]).trimmingCharacters(in: .whitespacesAndNewlines)
            if isValidModelId(model) { currentModel = model }
            if isValidProviderSlug(provider) { currentProviderSlug = provider }
        }
        if currentProviderSlug == nil {
            currentProviderSlug = providers.first(where: \.isCurrent)?.slug
        }
        return HermesModelListing(
            currentModel: currentModel,
            currentProviderSlug: currentProviderSlug,
            providers: providers
        )
    }

    private static func jsonObjectText(_ text: String) -> String? {
        var candidate = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let fence = candidate.range(of: "```json", options: .caseInsensitive) {
            let contentStart = fence.upperBound
            if let close = candidate[contentStart...].range(of: "```") {
                candidate = String(candidate[contentStart..<close.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
            }
        } else if let fence = candidate.range(of: "```") {
            let contentStart = fence.upperBound
            if let close = candidate[contentStart...].range(of: "```") {
                candidate = String(candidate[contentStart..<close.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        if candidate.hasPrefix("{"), candidate.hasSuffix("}") { return candidate }
        guard let start = candidate.firstIndex(of: "{"),
              let end = candidate.lastIndex(of: "}"),
              start < end else { return nil }
        return String(candidate[start...end])
    }

    private static func catalogCandidate(_ value: Any) -> (name: String?, slug: String, models: [Any])? {
        guard let row = value as? [String: Any],
              let slug = (row["slug"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              isValidProviderSlug(slug),
              let models = row["models"] as? [Any] else { return nil }
        let name = (row["name"] as? String).map { cleanLabel($0) }.flatMap { $0.isEmpty ? nil : $0 }
        return (name, slug, models)
    }

    public static func parseProviderCatalog(
        _ text: String,
        expectedProviderSlug: String? = nil
    ) -> HermesProviderCatalog? {
        guard let json = jsonObjectText(text),
              let data = json.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let expected = expectedProviderSlug?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? ""
        var candidate: (name: String?, slug: String, models: [Any])?

        if let provider = (root["provider"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
           let models = root["models"] as? [Any] {
            guard isValidProviderSlug(provider) else { return nil }
            if !expected.isEmpty, provider.lowercased() != expected { return nil }
            let name = (root["name"] as? String).map { cleanLabel($0) }.flatMap { $0.isEmpty ? nil : $0 }
            candidate = (name, provider, models)
        } else if let rows = root["providers"] as? [Any] {
            let candidates = rows.compactMap(catalogCandidate)
            if expected.isEmpty {
                candidate = candidates.count == 1 ? candidates[0] : nil
            } else {
                candidate = candidates.first { $0.slug.lowercased() == expected }
            }
        }
        guard let candidate else { return nil }
        let models = uniqueModels(candidate.models.compactMap { $0 as? String })
        return HermesProviderCatalog(
            providerName: candidate.name,
            providerSlug: candidate.slug,
            models: models
        )
    }

    public static func parseConfirmation(_ text: String) -> HermesModelSwitchConfirmation? {
        var modelId: String?
        var providerName: String?
        for line in normalizedLines(text) {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.lowercased().hasPrefix("model switched to ") {
                let value = String(trimmed.dropFirst("Model switched to ".count))
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .trimmingCharacters(in: CharacterSet(charactersIn: "`"))
                if isValidModelId(value) { modelId = value }
            } else if trimmed.lowercased().hasPrefix("provider:") {
                let value = String(trimmed.dropFirst("Provider:".count))
                let cleaned = cleanLabel(value)
                if !cleaned.isEmpty { providerName = cleaned }
            }
        }
        guard let modelId else { return nil }
        return HermesModelSwitchConfirmation(modelId: modelId, providerName: providerName)
    }
}

/// Encrypted rumor tags used to hide Taskify bot-UI commands and correlate their replies.
public struct TaskifyBotUiAction: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Equatable, Sendable {
        case catalogRequest = "catalog-request"
        case modelSelect = "model-select"
    }

    public var kind: Kind
    public var menuId: String
    public var providerSlug: String
    public var modelId: String?

    public init(kind: Kind, menuId: String, providerSlug: String, modelId: String? = nil) {
        self.kind = kind
        self.menuId = menuId
        self.providerSlug = providerSlug
        self.modelId = modelId
    }
}

public enum TaskifyBotUiError: Error {
    case invalidAction
}

public enum TaskifyBotUiContract {
    public static let tagName = "taskify-bot-ui"
    public static let version = "v1"
    private static let menuPattern = #"^[A-Za-z0-9_-]{1,64}$"#

    public static func tag(for action: TaskifyBotUiAction) throws -> [String] {
        guard action.menuId.range(of: menuPattern, options: .regularExpression) != nil,
              HermesModelMenuParser.isValidProviderSlug(action.providerSlug) else {
            throw TaskifyBotUiError.invalidAction
        }
        switch action.kind {
        case .catalogRequest:
            return [tagName, version, action.kind.rawValue, action.menuId, action.providerSlug]
        case .modelSelect:
            guard let modelId = action.modelId,
                  HermesModelMenuParser.isValidModelId(modelId) else {
                throw TaskifyBotUiError.invalidAction
            }
            return [tagName, version, action.kind.rawValue, action.menuId, action.providerSlug, modelId]
        }
    }

    public static func action(from tags: [[String]]) -> TaskifyBotUiAction? {
        for tag in tags where tag.count >= 5 && tag[0] == tagName && tag[1] == version {
            guard tag[3].range(of: menuPattern, options: .regularExpression) != nil,
                  HermesModelMenuParser.isValidProviderSlug(tag[4]) else { continue }
            guard let kind = TaskifyBotUiAction.Kind(rawValue: tag[2]) else { continue }
            if kind == .catalogRequest, tag.count == 5 {
                return TaskifyBotUiAction(kind: kind, menuId: tag[3], providerSlug: tag[4])
            }
            if kind == .modelSelect, tag.count == 6,
               HermesModelMenuParser.isValidModelId(tag[5]) {
                return TaskifyBotUiAction(kind: kind, menuId: tag[3], providerSlug: tag[4], modelId: tag[5])
            }
        }
        return nil
    }

    public static func catalogRequestPrompt(providerSlug: String) throws -> String {
        let slug = providerSlug.trimmingCharacters(in: .whitespacesAndNewlines)
        guard HermesModelMenuParser.isValidProviderSlug(slug) else {
            throw TaskifyBotUiError.invalidAction
        }
        return """
        List only the models available for provider slug `\(slug)` on this Hermes instance. Include every model ID accepted by `/model <model-id> --provider \(slug)`, without truncating or omitting any. Do not include API keys, credentials, endpoints, filesystem paths, or other secrets. Return only one fenced JSON code block in this exact shape:

        {"provider":"\(slug)","models":["model-id"]}
        """
    }

    public static func modelSwitchCommand(providerSlug: String, modelId: String) throws -> String {
        let slug = providerSlug.trimmingCharacters(in: .whitespacesAndNewlines)
        let model = modelId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard HermesModelMenuParser.isValidProviderSlug(slug),
              HermesModelMenuParser.isValidModelId(model) else {
            throw TaskifyBotUiError.invalidAction
        }
        return "/model \(model) --provider \(slug)"
    }
}

public struct HermesSelectedModel: Equatable, Sendable {
    public var modelId: String
    public var providerSlug: String
    public var providerName: String?

    public init(modelId: String, providerSlug: String, providerName: String?) {
        self.modelId = modelId
        self.providerSlug = providerSlug
        self.providerName = providerName
    }
}

public struct HermesBotUiFailure: Equatable, Sendable {
    public var action: TaskifyBotUiAction
    public var responseEventId: String
    public var responseContent: String

    public init(action: TaskifyBotUiAction, responseEventId: String, responseContent: String) {
        self.action = action
        self.responseEventId = responseEventId
        self.responseContent = responseContent
    }
}

public struct HermesModelMenuProjection: Equatable, Sendable {
    public var listingEventId: String
    public var menuId: String
    public var listing: HermesModelListing
    public var catalogs: [String: HermesProviderCatalog]
    public var selectedModel: HermesSelectedModel?
    public var pendingAction: TaskifyBotUiAction?
    public var failure: HermesBotUiFailure?

    public init(
        listingEventId: String,
        menuId: String,
        listing: HermesModelListing,
        catalogs: [String: HermesProviderCatalog] = [:],
        selectedModel: HermesSelectedModel? = nil,
        pendingAction: TaskifyBotUiAction? = nil,
        failure: HermesBotUiFailure? = nil
    ) {
        self.listingEventId = listingEventId
        self.menuId = menuId
        self.listing = listing
        self.catalogs = catalogs
        self.selectedModel = selectedModel
        self.pendingAction = pendingAction
        self.failure = failure
    }
}

public struct HermesBotUiProjection: Equatable, Sendable {
    public var hiddenMessageIDs: Set<String>
    public var menusByListingMessageID: [String: HermesModelMenuProjection]

    public init(
        hiddenMessageIDs: Set<String> = [],
        menusByListingMessageID: [String: HermesModelMenuProjection] = [:]
    ) {
        self.hiddenMessageIDs = hiddenMessageIDs
        self.menusByListingMessageID = menusByListingMessageID
    }
}

/// Reconstructs Hermes's button menu from encrypted message history. Internal commands carry a
/// typed tag; only the next incoming message that parses as the exact expected response is hidden.
public enum HermesModelPickerProjection {
    public static func project(messages: [NostrDirectMessage], enabled: Bool) -> HermesBotUiProjection {
        guard enabled else { return HermesBotUiProjection() }
        let ordered = messages.enumerated().sorted {
            if $0.element.createdAt != $1.element.createdAt {
                return $0.element.createdAt < $1.element.createdAt
            }
            return $0.offset < $1.offset
        }.map(\.element)

        var hidden = Set<String>()
        var menusByListingMessageID: [String: HermesModelMenuProjection] = [:]
        var menusByMenuID: [String: HermesModelMenuProjection] = [:]
        for message in ordered where message.isIncoming && message.groupID == nil && message.attachment == nil {
            guard let listing = HermesModelMenuParser.parseListing(message.content) else { continue }
            let menuId = message.rumorEventID
            guard menuId.range(of: #"^[A-Za-z0-9_-]{1,64}$"#, options: .regularExpression) != nil else {
                continue
            }
            let menu = HermesModelMenuProjection(
                listingEventId: message.rumorEventID,
                menuId: menuId,
                listing: listing
            )
            menusByListingMessageID[message.rumorEventID] = menu
            menusByMenuID[menuId] = menu
        }
        guard !menusByMenuID.isEmpty else {
            return HermesBotUiProjection(hiddenMessageIDs: hidden, menusByListingMessageID: menusByListingMessageID)
        }

        var pending: TaskifyBotUiAction?
        for message in ordered {
            if !message.isIncoming, let action = message.botUiAction {
                hidden.insert(message.rumorEventID)
                guard var menu = menusByMenuID[action.menuId] else { continue }
                menu.pendingAction = action
                menu.failure = nil
                menusByMenuID[action.menuId] = menu
                menusByListingMessageID[menu.listingEventId] = menu
                pending = action
                continue
            }
            guard message.isIncoming, let action = pending else { continue }
            guard var menu = menusByMenuID[action.menuId] else {
                pending = nil
                continue
            }

            if action.kind == .catalogRequest {
                if let catalog = HermesModelMenuParser.parseProviderCatalog(
                    message.content,
                    expectedProviderSlug: action.providerSlug
                ) {
                    hidden.insert(message.rumorEventID)
                    menu.catalogs[catalog.providerSlug.lowercased()] = catalog
                    menu.pendingAction = nil
                    menu.failure = nil
                    menusByMenuID[action.menuId] = menu
                    menusByListingMessageID[menu.listingEventId] = menu
                    pending = nil
                    continue
                }
            } else if let expectedModel = action.modelId,
                      let confirmation = HermesModelMenuParser.parseConfirmation(message.content),
                      confirmation.modelId.lowercased() == expectedModel.lowercased() {
                hidden.insert(message.rumorEventID)
                let catalog = menu.catalogs[action.providerSlug.lowercased()]
                menu.selectedModel = HermesSelectedModel(
                    modelId: confirmation.modelId,
                    providerSlug: action.providerSlug,
                    providerName: confirmation.providerName ?? catalog?.providerName
                )
                menu.pendingAction = nil
                menu.failure = nil
                menusByMenuID[action.menuId] = menu
                menusByListingMessageID[menu.listingEventId] = menu
                pending = nil
                continue
            }

            menu.pendingAction = nil
            menu.failure = HermesBotUiFailure(
                action: action,
                responseEventId: message.rumorEventID,
                responseContent: message.content
            )
            menusByMenuID[action.menuId] = menu
            menusByListingMessageID[menu.listingEventId] = menu
            pending = nil
        }

        return HermesBotUiProjection(
            hiddenMessageIDs: hidden,
            menusByListingMessageID: menusByListingMessageID
        )
    }
}
