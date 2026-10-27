import EventKit
import SwiftUI
import TaskifyCore
import UIKit

struct UpcomingSortOptionsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let sortMode: UpcomingSortMode
    let sortDirection: UpcomingSortDirection
    let boardGrouping: UpcomingBoardGrouping
    let filterGroups: [UpcomingFilterGroup]
    let selectedOptionIDs: Set<String>
    let deviceCalendarEnabled: Bool
    let deviceRemindersEnabled: Bool
    let usHolidaysEnabled: Bool
    let filterPresets: [UpcomingFilterPreset]
    let onSelectSort: (UpcomingSortMode) -> Void
    let onSelectGrouping: (UpcomingBoardGrouping) -> Void
    let onToggleOption: (String) -> Void
    let onSelectAllBoards: () -> Void
    let onToggleDeviceCalendar: () -> Void
    let onToggleDeviceReminders: () -> Void
    let onToggleUsHolidays: () -> Void
    let onApplyPreset: (UpcomingFilterPreset) -> Void
    let onSavePreset: (String) -> Void
    let onDeletePreset: (UpcomingFilterPreset) -> Void

    @State private var showingSavePresetAlert = false
    @State private var newPresetName = ""
    @State private var presetPendingDeletion: UpcomingFilterPreset?

    private let columns = [GridItem(.flexible()), GridItem(.flexible())]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    sectionTitle("Sort tasks by")
                    LazyVGrid(columns: columns, spacing: 10) {
                        ForEach(UpcomingSortMode.allCases, id: \.rawValue) { mode in
                            Button {
                                onSelectSort(mode)
                            } label: {
                                HStack(spacing: 7) {
                                    Text(mode.label)
                                    if sortMode == mode, mode.supportsDirection {
                                        Image(systemName: sortDirection == .ascending ? "arrow.up" : "arrow.down")
                                    }
                                }
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(sortMode == mode ? .white : TaskifyTheme.secondaryText)
                                .frame(maxWidth: .infinity)
                                .frame(height: 44)
                                .background(
                                    sortMode == mode ? TaskifyTheme.accent : TaskifyTheme.raisedFill,
                                    in: Capsule()
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }

                    sectionTitle("Boards")
                    Picker(
                        "Board grouping",
                        selection: Binding(
                            get: { boardGrouping },
                            set: onSelectGrouping
                        )
                    ) {
                        ForEach(UpcomingBoardGrouping.allCases, id: \.rawValue) { option in
                            Text(option.label).tag(option)
                        }
                    }
                    .pickerStyle(.segmented)

                    sectionTitle("Apple")

                    Button(action: onToggleDeviceCalendar) {
                        HStack(spacing: 12) {
                            Image(systemName: deviceCalendarEnabled
                                ? "checkmark.circle.fill"
                                : "circle")
                                .foregroundStyle(deviceCalendarEnabled
                                    ? TaskifyTheme.accent
                                    : TaskifyTheme.tertiaryText)
                            Image(systemName: "calendar")
                                .foregroundStyle(Color.orange)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Apple Calendar")
                                    .foregroundStyle(TaskifyTheme.primaryText)
                                Text("Show device calendar events")
                                    .font(.caption)
                                    .foregroundStyle(TaskifyTheme.tertiaryText)
                            }
                            Spacer()
                        }
                        .padding(.horizontal, 14)
                        .frame(height: 56)
                        .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18))
                    }
                    .buttonStyle(.plain)

                    Button(action: onToggleDeviceReminders) {
                        HStack(spacing: 12) {
                            Image(systemName: deviceRemindersEnabled
                                ? "checkmark.circle.fill"
                                : "circle")
                                .foregroundStyle(deviceRemindersEnabled
                                    ? TaskifyTheme.accent
                                    : TaskifyTheme.tertiaryText)
                            Image(systemName: "checklist")
                                .foregroundStyle(Color.purple)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Apple Reminders")
                                    .foregroundStyle(TaskifyTheme.primaryText)
                                Text("Show and complete due reminders")
                                    .font(.caption)
                                    .foregroundStyle(TaskifyTheme.tertiaryText)
                            }
                            Spacer()
                        }
                        .padding(.horizontal, 14)
                        .frame(height: 56)
                        .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18))
                    }
                    .buttonStyle(.plain)

                    Button(action: onToggleUsHolidays) {
                        HStack(spacing: 12) {
                            Image(systemName: usHolidaysEnabled
                                ? "checkmark.circle.fill"
                                : "circle")
                                .foregroundStyle(usHolidaysEnabled
                                    ? TaskifyTheme.accent
                                    : TaskifyTheme.tertiaryText)
                            Image(systemName: "star.fill")
                                .foregroundStyle(Color.pink)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("US Holidays")
                                    .foregroundStyle(TaskifyTheme.primaryText)
                                Text("Show federal holidays and DST changes")
                                    .font(.caption)
                                    .foregroundStyle(TaskifyTheme.tertiaryText)
                            }
                            Spacer()
                        }
                        .padding(.horizontal, 14)
                        .frame(height: 56)
                        .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18))
                    }
                    .buttonStyle(.plain)

                    HStack {
                        sectionTitle("Filter presets")
                        Spacer()
                        Button {
                            newPresetName = ""
                            showingSavePresetAlert = true
                        } label: {
                            Label("Save current", systemImage: "plus.circle")
                        }
                        .font(.caption.weight(.semibold))
                    }

                    if filterPresets.isEmpty {
                        Text("Select boards below, then save the combination as a reusable preset.")
                            .font(.caption)
                            .foregroundStyle(TaskifyTheme.tertiaryText)
                    } else {
                        ScrollView(.horizontal) {
                            HStack(spacing: 8) {
                                ForEach(filterPresets) { preset in
                                    Button {
                                        onApplyPreset(preset)
                                    } label: {
                                        Text(preset.name)
                                            .font(.caption.weight(.semibold))
                                            .foregroundStyle(TaskifyTheme.primaryText)
                                            .padding(.horizontal, 14)
                                            .frame(height: 36)
                                            .background(TaskifyTheme.raisedFill, in: Capsule())
                                    }
                                    .buttonStyle(.plain)
                                    .onLongPressGesture(minimumDuration: 0.5) {
                                        presetPendingDeletion = preset
                                    }
                                }
                            }
                        }
                        .scrollIndicators(.hidden)
                        Text("Touch and hold a preset to delete it.")
                            .font(.caption2)
                            .foregroundStyle(TaskifyTheme.tertiaryText)
                    }

                    HStack {
                        sectionTitle("Taskify boards")
                        Spacer()
                        Button("Select all", action: onSelectAllBoards)
                            .font(.caption.weight(.semibold))
                    }

                    VStack(spacing: 0) {
                        ForEach(filterGroups) { group in
                            filterOptionRow(group.boardOption, subtitle: group.board.kind == .list ? "List" : "Week")
                            if group.board.id != filterGroups.last?.board.id || !group.listOptions.isEmpty {
                                Divider().overlay(TaskifyTheme.border)
                            }
                            ForEach(group.listOptions) { listOption in
                                filterOptionRow(listOption, indented: true)
                                if listOption.id != group.listOptions.last?.id || group.board.id != filterGroups.last?.board.id {
                                    Divider().overlay(TaskifyTheme.border)
                                }
                            }
                        }
                    }
                    .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18))
                }
                .padding(18)
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Sort & Filter")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .alert("Save preset", isPresented: $showingSavePresetAlert) {
                TextField("Preset name", text: $newPresetName)
                Button("Cancel", role: .cancel) { newPresetName = "" }
                Button("Save") {
                    onSavePreset(newPresetName)
                    newPresetName = ""
                }
                .disabled(newPresetName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            } message: {
                Text("Saves the boards currently selected below as a reusable filter.")
            }
            .confirmationDialog(
                "Delete \(presetPendingDeletion?.name ?? "preset")?",
                isPresented: Binding(
                    get: { presetPendingDeletion != nil },
                    set: { isPresented in
                        if !isPresented { presetPendingDeletion = nil }
                    }
                ),
                titleVisibility: .visible
            ) {
                Button("Delete", role: .destructive) {
                    if let preset = presetPendingDeletion {
                        onDeletePreset(preset)
                    }
                    presetPendingDeletion = nil
                }
                Button("Cancel", role: .cancel) { presetPendingDeletion = nil }
            }
        }
        .preferredColorScheme(.dark)
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(title.uppercased())
            .font(.caption.weight(.bold))
            .tracking(0.8)
            .foregroundStyle(TaskifyTheme.secondaryText)
    }

    private func filterOptionRow(_ option: UpcomingFilterOption, subtitle: String? = nil, indented: Bool = false) -> some View {
        let isSelected = selectedOptionIDs.contains(option.id)
        return Button {
            onToggleOption(option.id)
        } label: {
            HStack(spacing: 12) {
                if indented {
                    Image(systemName: "arrow.turn.down.right")
                        .font(.caption2)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                }
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(isSelected ? TaskifyTheme.accent : TaskifyTheme.tertiaryText)
                Text(option.label)
                    .font(indented ? .subheadline : .body)
                    .foregroundStyle(indented ? TaskifyTheme.secondaryText : TaskifyTheme.primaryText)
                Spacer()
                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                }
            }
            .padding(.horizontal, 14)
            .padding(.leading, indented ? 14 : 0)
            .frame(height: indented ? 42 : 50)
        }
        .buttonStyle(.plain)
    }
}
