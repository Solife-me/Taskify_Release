import Foundation
import Testing
@testable import TaskifyCore

@Suite("TaskifyBackupRestoreParser")
struct TaskifyBackupRestoreParserTests {
    @Test("parser extracts nostr key relays and settings")
    func parseBackupPayload() throws {
        let data = Data(
            """
            {
              "nostrSk": "nsec1abc",
              "defaultRelays": ["wss://relay.one", "wss://relay.two"],
              "settings": {
                "accent": "green",
                "pushNotifications": {
                  "enabled": true,
                  "platform": "ios",
                  "permission": "granted"
                }
              }
            }
            """.utf8
        )

        let payload = try TaskifyBackupRestoreParser.parse(data: data)

        #expect(payload.secretKeyInput == "nsec1abc")
        #expect(payload.relays == ["wss://relay.one", "wss://relay.two"])
        #expect(payload.settings?.accent == .green)
        #expect(payload.settings?.pushNotifications.permission == .granted)
    }

    @Test("parser filters ATS-blocked relays from backups")
    func parseBackupFiltersBlockedRelays() throws {
        let data = Data(
            """
            {
              "nostrSk": "nsec1abc",
              "defaultRelays": ["wss://relay.primal.net", "wss://relay.two"]
            }
            """.utf8
        )

        let payload = try TaskifyBackupRestoreParser.parse(data: data)
        #expect(payload.relays == ["wss://relay.two"])
    }

    @Test("parser rejects backup files without a nostr key")
    func parseBackupMissingPrivateKey() {
        let data = Data(#"{"settings":{"accent":"blue"}}"#.utf8)

        do {
            _ = try TaskifyBackupRestoreParser.parse(data: data)
            Issue.record("Expected missingPrivateKey error")
        } catch let error as TaskifyBackupRestoreError {
            #expect(error == .missingPrivateKey)
        } catch {
            Issue.record("Expected TaskifyBackupRestoreError, received \(error)")
        }
    }
}
