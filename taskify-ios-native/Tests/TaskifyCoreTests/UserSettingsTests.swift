import Foundation
import Testing
@testable import TaskifyCore

@Suite("UserSettings")
struct UserSettingsTests {

    @Test("resolves startup board using Taskify weekday mapping")
    func startupBoardResolution() {
        let settings = UserSettings(
            startBoardByDay: [
                0: "sunday-board",
                1: "monday-board",
                6: "saturday-board",
            ]
        )

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!

        let saturday = calendar.date(from: DateComponents(year: 2026, month: 3, day: 28))!
        let sunday = calendar.date(from: DateComponents(year: 2026, month: 3, day: 29))!
        let monday = calendar.date(from: DateComponents(year: 2026, month: 3, day: 30))!

        #expect(settings.startBoardId(for: saturday, calendar: calendar) == "saturday-board")
        #expect(settings.startBoardId(for: sunday, calendar: calendar) == "sunday-board")
        #expect(settings.startBoardId(for: monday, calendar: calendar) == "monday-board")
    }

    @Test("ignores blank startup board ids")
    func blankStartupBoardIgnored() {
        let settings = UserSettings(startBoardByDay: [0: "  "])
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let sunday = calendar.date(from: DateComponents(year: 2026, month: 3, day: 29))!
        #expect(settings.startBoardId(for: sunday, calendar: calendar) == nil)
    }

    @Test("decodes PWA-style settings payloads with native-safe normalization")
    func decodesPwaSettingsPayload() throws {
        let json = """
        {
          "accent": "background",
          "backgroundImage": "data:image/png;base64,abc",
          "backgroundAccent": { "fill": "#4488ff" },
          "weekStart": 1,
          "newTaskPosition": "bottom",
          "fileStorageServer": "nostr.build/",
          "bibleTrackerEnabled": false,
          "scriptureMemoryEnabled": true,
          "scriptureMemoryBoardId": "board-1",
          "fastingRemindersEnabled": true,
          "fastingRemindersMode": "random",
          "fastingRemindersPerMonth": 40,
          "fastingRemindersWeekday": 9,
          "pushNotifications": {
            "enabled": true,
            "platform": "android",
            "permission": "granted",
            "deviceId": "device-1"
          },
          "walletPrimaryCurrency": "usd",
          "customField": "preserve-me"
        }
        """

        let settings = try JSONDecoder().decode(UserSettings.self, from: Data(json.utf8))

        #expect(settings.accent == .background)
        #expect(settings.weekStart == 1)
        #expect(settings.newTaskPosition == .bottom)
        #expect(settings.fileStorageServer == "https://nostr.build")
        #expect(settings.scriptureMemoryEnabled == false)
        #expect(settings.scriptureMemoryBoardId == nil)
        #expect(settings.fastingRemindersPerMonth == 31)
        #expect(settings.fastingRemindersWeekday == 1)
        #expect(settings.pushNotifications.platform == .ios)
        #expect(settings.pushNotifications.enabled == true)
        #expect(settings.pushNotifications.deviceId == "device-1")
        #expect(settings.walletPrimaryCurrency == .usd)
    }

    @Test("preserves unsupported PWA fields when re-encoding settings")
    func preservesUnsupportedFields() throws {
        let json = """
        {
          "accent": "background",
          "backgroundImage": "data:image/png;base64,abc",
          "backgroundAccent": { "fill": "#4488ff" },
          "customField": "preserve-me"
        }
        """

        let settings = try JSONDecoder().decode(UserSettings.self, from: Data(json.utf8))
        let encoded = try JSONEncoder().encode(settings)
        let payload = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])

        #expect(payload["customField"] as? String == "preserve-me")
        #expect(payload["backgroundImage"] as? String == "data:image/png;base64,abc")
        #expect(payload["accent"] as? String == "background")
    }

    @Test("resolves imported background accents and preserves palette selection")
    func importedBackgroundAccentSelection() throws {
        let json = """
        {
          "accent": "background",
          "backgroundImage": "data:image/png;base64,abc",
          "backgroundAccentIndex": 1,
          "backgroundAccent": {
            "fill": "#445566",
            "hover": "#556677",
            "active": "#667788",
            "soft": "#778899",
            "border": "#8899aa",
            "borderActive": "#99aabb",
            "ring": "#aabbcc",
            "on": "#ffffff",
            "glow": "#001122",
            "shadow": "#112233",
            "shadowActive": "#223344"
          },
          "backgroundAccents": [
            {
              "fill": "#112233",
              "hover": "#223344",
              "active": "#334455",
              "soft": "#445566",
              "border": "#556677",
              "borderActive": "#667788",
              "ring": "#778899",
              "on": "#ffffff",
              "glow": "#8899aa",
              "shadow": "#99aabb",
              "shadowActive": "#aabbcc"
            },
            {
              "fill": "#445566",
              "hover": "#556677",
              "active": "#667788",
              "soft": "#778899",
              "border": "#8899aa",
              "borderActive": "#99aabb",
              "ring": "#aabbcc",
              "on": "#ffffff",
              "glow": "#001122",
              "shadow": "#112233",
              "shadowActive": "#223344"
            }
          ]
        }
        """

        var settings = try JSONDecoder().decode(UserSettings.self, from: Data(json.utf8))

        #expect(settings.backgroundAppearance?.resolvedAccentIndex == 1)
        #expect(settings.activeAccentFillHex == "#445566")

        settings.selectBackgroundAccent(index: 0)
        let encoded = try JSONEncoder().encode(settings)
        let payload = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let backgroundAccent = try #require(payload["backgroundAccent"] as? [String: Any])

        #expect(payload["backgroundAccentIndex"] as? Double == 0)
        #expect(backgroundAccent["fill"] as? String == "#112233")
    }

    @Test("clearing imported background resets unsupported background fields")
    func clearingImportedBackground() throws {
        let json = """
        {
          "accent": "background",
          "backgroundImage": "data:image/png;base64,abc",
          "backgroundAccent": {
            "fill": "#445566",
            "hover": "#556677",
            "active": "#667788",
            "soft": "#778899",
            "border": "#8899aa",
            "borderActive": "#99aabb",
            "ring": "#aabbcc",
            "on": "#ffffff",
            "glow": "#001122",
            "shadow": "#112233",
            "shadowActive": "#223344"
          }
        }
        """

        var settings = try JSONDecoder().decode(UserSettings.self, from: Data(json.utf8))
        settings.clearBackgroundAppearance()

        let encoded = try JSONEncoder().encode(settings)
        let payload = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])

        #expect(settings.backgroundAppearance == nil)
        #expect(settings.accent == .blue)
        #expect(payload["backgroundImage"] == nil)
        #expect(payload["backgroundAccent"] == nil)
    }
}
