import SwiftUI

/// Searchable IANA time zone picker for a task's due time, ported from the PWA's
/// `TimeZoneSheet.tsx`. Unlike the print/scan or bounty features, this needed no new backend
/// plumbing — `TaskItem.dueTimeZone`, notification scheduling (`TaskScheduling.swift`), and Nostr
/// sync already thread a per-task time zone identifier through end to end; only the picker UI and
/// the editor's hardcoded "always use the device's current zone" were missing.
struct TimeZonePickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var selection: String
    let referenceDate: Date
    @State private var query = ""

    private struct Option: Identifiable {
        let id: String
        let displayName: String
        let offsetLabel: String
        let offsetSeconds: Int
        let searchText: String
    }

    private var allOptions: [Option] {
        TimeZone.knownTimeZoneIdentifiers.compactMap { identifier -> Option? in
            guard let timeZone = TimeZone(identifier: identifier) else { return nil }
            let displayName = timeZone.localizedName(for: .generic, locale: .current) ?? identifier
            let offsetSeconds = timeZone.secondsFromGMT(for: referenceDate)
            let offsetLabel = Self.offsetLabel(seconds: offsetSeconds)
            let searchableNames = [
                displayName,
                timeZone.localizedName(for: .standard, locale: .current),
                timeZone.localizedName(for: .daylightSaving, locale: .current),
                timeZone.localizedName(for: .shortStandard, locale: .current),
                timeZone.localizedName(for: .shortDaylightSaving, locale: .current),
                timeZone.abbreviation(for: referenceDate),
            ]
                .compactMap { $0 }
                .joined(separator: " ")
            return Option(
                id: identifier,
                displayName: displayName,
                offsetLabel: offsetLabel,
                offsetSeconds: offsetSeconds,
                searchText: "\(identifier) \(searchableNames) \(offsetLabel)".lowercased()
            )
        }
        .sorted {
            $0.offsetSeconds != $1.offsetSeconds
                ? $0.offsetSeconds < $1.offsetSeconds
                : $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }
    }

    private static func offsetLabel(seconds: Int) -> String {
        let hours = seconds / 3600
        let minutes = abs(seconds / 60 % 60)
        return String(format: "GMT%@%d:%02d", hours >= 0 ? "+" : "-", abs(hours), minutes)
    }

    private var filteredOptions: [Option] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmed.isEmpty else { return allOptions }
        return allOptions.filter { $0.searchText.contains(trimmed) }
    }

    var body: some View {
        NavigationStack {
            List(filteredOptions) { option in
                Button {
                    selection = option.id
                    dismiss()
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(option.displayName)
                                .foregroundStyle(TaskifyTheme.primaryText)
                            Text("\(option.id) • \(option.offsetLabel)")
                                .font(.caption)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                        }
                        Spacer()
                        if option.id == selection {
                            Image(systemName: "checkmark")
                                .foregroundStyle(TaskifyTheme.accent)
                        }
                    }
                }
            }
            .listStyle(.plain)
            .searchable(text: $query, prompt: "Search by city, abbreviation, or name")
            .navigationTitle("Time Zone")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}
