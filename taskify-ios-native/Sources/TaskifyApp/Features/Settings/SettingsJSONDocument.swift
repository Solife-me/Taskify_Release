import SwiftUI
import UniformTypeIdentifiers
import TaskifyCore

struct SettingsJSONDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }

    var settings: UserSettings

    init(settings: UserSettings) {
        self.settings = settings.normalized()
    }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents else {
            throw SettingsJSONDocumentError.unreadableFile
        }
        self.settings = try JSONDecoder().decode(UserSettings.self, from: data).normalized()
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(settings.normalized())
        return FileWrapper(regularFileWithContents: data)
    }
}

private enum SettingsJSONDocumentError: LocalizedError {
    case unreadableFile

    var errorDescription: String? {
        switch self {
        case .unreadableFile:
            return "The selected settings file could not be read."
        }
    }
}
