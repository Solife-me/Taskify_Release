import Foundation

public enum DeviceNotificationSelection {
    private static let defaultsKey = "taskify.apple.notificationSelection"

    public static func eventKey(_ eventID: String) -> String { "event:\(eventID)" }
    public static func reminderKey(_ reminderID: String) -> String { "reminder:\(reminderID)" }

    /// Keys map to the chosen lead time in minutes. Older boolean-style selections are
    /// migrated to an "at time" (0) lead.
    public static func loadMinutes(defaults: UserDefaults = .standard) -> [String: Int] {
        if let dict = defaults.dictionary(forKey: defaultsKey) as? [String: Int] {
            return dict
        }
        let legacy = Set(defaults.stringArray(forKey: defaultsKey) ?? [])
        guard !legacy.isEmpty else { return [:] }
        let migrated = Dictionary(uniqueKeysWithValues: legacy.map { ($0, 0) })
        defaults.set(migrated, forKey: defaultsKey)
        return migrated
    }

    public static func saveMinutes(_ selection: [String: Int], defaults: UserDefaults = .standard) {
        defaults.set(selection, forKey: defaultsKey)
    }

    /// Resolve every persisted selection, independent of a screen's fetch range.
    /// Event keys include the occurrence timestamp so recurring events remain distinct.
    public static func resolve<Event, Reminder>(
        _ selection: [String: Int],
        event: (String, Date) -> Event?,
        reminder: (String) -> Reminder?
    ) -> (events: [Event], reminders: [Reminder]) {
        var events: [Event] = []
        var reminders: [Reminder] = []
        for key in selection.keys.sorted() {
            if key.hasPrefix("event:") {
                let id = String(key.dropFirst("event:".count))
                guard let separator = id.lastIndex(of: "-"),
                      let timestamp = Double(id[id.index(after: separator)...]),
                      timestamp.isFinite else { continue }
                if let item = event(id, Date(timeIntervalSince1970: timestamp)) {
                    events.append(item)
                }
            } else if key.hasPrefix("reminder:"),
                      let item = reminder(String(key.dropFirst("reminder:".count))) {
                reminders.append(item)
            }
        }
        return (events, reminders)
    }
}

