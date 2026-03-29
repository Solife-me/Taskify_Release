import Foundation

public struct TaskifyBackupRestorePayload: Equatable, Sendable {
    public let secretKeyInput: String
    public let relays: [String]
    public let settings: UserSettings?

    public init(secretKeyInput: String, relays: [String], settings: UserSettings?) {
        self.secretKeyInput = secretKeyInput
        self.relays = relays
        self.settings = settings
    }
}

public enum TaskifyBackupRestoreError: LocalizedError {
    case invalidBackupFile
    case invalidBackupData
    case missingPrivateKey

    public var errorDescription: String? {
        switch self {
        case .invalidBackupFile:
            return "Invalid backup file."
        case .invalidBackupData:
            return "Invalid backup data."
        case .missingPrivateKey:
            return "Backup file does not contain a Taskify private key."
        }
    }
}

public enum TaskifyBackupRestoreParser {
    public static func parse(data: Data) throws -> TaskifyBackupRestorePayload {
        let json: Any
        do {
            json = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw TaskifyBackupRestoreError.invalidBackupFile
        }

        guard let object = json as? [String: Any] else {
            throw TaskifyBackupRestoreError.invalidBackupData
        }

        let secretKeyInput = (object["nostrSk"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let secretKeyInput, !secretKeyInput.isEmpty else {
            throw TaskifyBackupRestoreError.missingPrivateKey
        }

        let relays = normalizedRelays(object["defaultRelays"] as? [Any] ?? [])
        let settings = decodedSettings(from: object["settings"])

        return TaskifyBackupRestorePayload(
            secretKeyInput: secretKeyInput,
            relays: relays,
            settings: settings
        )
    }

    private static func normalizedRelays(_ values: [Any]) -> [String] {
        normalizeRelayList(values.compactMap { $0 as? String })
    }

    private static func decodedSettings(from value: Any?) -> UserSettings? {
        guard let value else { return nil }
        guard JSONSerialization.isValidJSONObject(value) else { return nil }
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        guard let settings = try? JSONDecoder().decode(UserSettings.self, from: data) else { return nil }
        return settings.normalized()
    }
}
