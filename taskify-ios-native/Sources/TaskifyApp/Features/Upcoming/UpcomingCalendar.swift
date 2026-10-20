import EventKit
import SwiftUI
import TaskifyCore
import UIKit

struct UpcomingCompactCalendar: View {
    @Binding var selection: Date
    let taskCountsByDate: [Date: Int]
    let taskifyEventDates: Set<Date>
    let eventDates: Set<Date>
    let reminderDates: Set<Date>
    let holidayDates: Set<Date>
    let todayRequest: Int
    let onVisibleMonthChange: (Date) -> Void
    private let calendar: Calendar
    @State private var visibleMonth: Date
    @State private var showingMonthPicker = false

    private let columns = Array(
        repeating: GridItem(.flexible(), spacing: 0),
        count: 7
    )

    init(
        selection: Binding<Date>,
        taskCountsByDate: [Date: Int],
        taskifyEventDates: Set<Date>,
        eventDates: Set<Date>,
        reminderDates: Set<Date>,
        holidayDates: Set<Date>,
        todayRequest: Int,
        calendar: Calendar = .current,
        onVisibleMonthChange: @escaping (Date) -> Void
    ) {
        _selection = selection
        self.taskCountsByDate = taskCountsByDate
        self.taskifyEventDates = taskifyEventDates
        self.eventDates = eventDates
        self.reminderDates = reminderDates
        self.holidayDates = holidayDates
        self.todayRequest = todayRequest
        self.calendar = calendar
        self.onVisibleMonthChange = onVisibleMonthChange
        _visibleMonth = State(initialValue: Self.startOfMonth(
            containing: selection.wrappedValue,
            calendar: calendar
        ))
    }

    var body: some View {
        VStack(spacing: 6) {
            monthHeader

            LazyVGrid(columns: columns, spacing: 2) {
                ForEach(Array(weekdaySymbols.enumerated()), id: \.offset) { _, symbol in
                    Text(symbol.uppercased())
                        .scaledFont(size: 11, weight: .bold)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                        .frame(maxWidth: .infinity)
                        .frame(height: 22)
                        .accessibilityHidden(true)
                }

                ForEach(Array(monthDays.enumerated()), id: \.offset) { _, date in
                    if let date {
                        dayButton(date)
                    } else {
                        Color.clear
                            .frame(height: 44)
                            .accessibilityHidden(true)
                    }
                }
            }
        }
        .onChange(of: selection) { _, newSelection in
            let selectedMonth = Self.startOfMonth(
                containing: newSelection,
                calendar: calendar
            )
            guard !calendar.isDate(
                selectedMonth,
                equalTo: visibleMonth,
                toGranularity: .month
            ) else { return }
            withAnimation(.snappy) {
                visibleMonth = selectedMonth
            }
        }
        .simultaneousGesture(
            DragGesture(minimumDistance: 24)
                .onEnded { value in
                    guard abs(value.translation.width) > abs(value.translation.height),
                          abs(value.translation.width) > 44 else { return }
                    changeMonth(by: value.translation.width < 0 ? 1 : -1)
                }
        )
        .sensoryFeedback(.selection, trigger: selection)
        .onAppear {
            onVisibleMonthChange(visibleMonth)
        }
        .onChange(of: visibleMonth) { _, newMonth in
            onVisibleMonthChange(newMonth)
        }
        .onChange(of: todayRequest) { _, _ in
            showMonth(containing: Date())
        }
    }

    private var monthHeader: some View {
        ZStack {
            HStack {
                monthButton(systemName: "chevron.left", offset: -1)

                Spacer()

                monthButton(systemName: "chevron.right", offset: 1)
            }

            Button {
                showingMonthPicker = true
            } label: {
                HStack(spacing: 6) {
                    Text(visibleMonth.formatted(.dateTime.month(.wide).year()))
                        .scaledFont(size: 17, weight: .bold, design: .rounded)
                        .foregroundStyle(
                            showingMonthPicker
                                ? TaskifyTheme.accent
                                : TaskifyTheme.primaryText
                        )
                        .lineLimit(1)
                        .contentTransition(.numericText())

                    Image(systemName: showingMonthPicker ? "chevron.down" : "chevron.right")
                        .scaledFont(size: 16, weight: .semibold)
                        .foregroundStyle(TaskifyTheme.accent)
                        .contentTransition(.symbolEffect(.replace))
                }
                .frame(height: 38)
                .contentShape(Rectangle())
                .animation(.snappy, value: showingMonthPicker)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Choose month and year")
            .popover(
                isPresented: $showingMonthPicker,
                attachmentAnchor: .rect(.bounds),
                arrowEdge: .top
            ) {
                MonthYearWheelPicker(
                    initialDate: visibleMonth,
                    calendar: calendar
                ) { month, year in
                    showMonth(month: month, year: year)
                }
                .frame(width: 320, height: 232)
                .presentationCompactAdaptation(.popover)
            }
        }
    }

    private var weekdaySymbols: [String] {
        let symbols = calendar.shortStandaloneWeekdaySymbols
        let firstIndex = max(0, calendar.firstWeekday - 1)
        return (0..<7).map { symbols[(firstIndex + $0) % symbols.count] }
    }

    private var monthDays: [Date?] {
        guard let dayRange = calendar.range(of: .day, in: .month, for: visibleMonth) else {
            return []
        }

        let firstWeekday = calendar.component(.weekday, from: visibleMonth)
        let leadingSpaces = (firstWeekday - calendar.firstWeekday + 7) % 7
        let leading: [Date?] = Array(repeating: nil, count: leadingSpaces)
        let days: [Date?] = dayRange.map { day in
            calendar.date(byAdding: .day, value: day - 1, to: visibleMonth)
        }
        return leading + days
    }

    private func dayButton(_ date: Date) -> some View {
        let isSelected = calendar.isDate(date, inSameDayAs: selection)
        let isToday = calendar.isDateInToday(date)
        let day = calendar.startOfDay(for: date)
        let taskCount = taskCountsByDate[day, default: 0]
        let hasTaskifyEvent = taskifyEventDates.contains(day)
        let hasCalendarEvent = eventDates.contains(day)
        let hasReminder = reminderDates.contains(day)
        let hasHoliday = holidayDates.contains(day)

        return Button {
            withAnimation(.snappy) {
                selection = calendar.startOfDay(for: date)
            }
        } label: {
            VStack(spacing: 1) {
                Text("\(calendar.component(.day, from: date))")
                    .font(.system(
                        size: 16,
                        weight: isSelected ? .bold : .medium,
                        design: .rounded
                    ))
                    .foregroundStyle(
                        isSelected
                            ? Color.white
                            : (isToday ? TaskifyTheme.accent : TaskifyTheme.primaryText)
                    )
                    .frame(width: 34, height: 34)
                    .background {
                        if isSelected {
                            Circle().fill(TaskifyTheme.accent)
                        } else if isToday {
                            Circle().stroke(TaskifyTheme.accent.opacity(0.72), lineWidth: 1)
                        }
                    }

                HStack(spacing: 2) {
                    Circle()
                        .fill(taskCount > 0
                            ? (isSelected ? Color.white.opacity(0.9) : TaskifyTheme.accent)
                            : Color.clear)
                        .frame(width: 4, height: 4)

                    Circle()
                        .fill(hasTaskifyEvent
                            ? (isSelected ? Color.white.opacity(0.9) : Color.green)
                            : Color.clear)
                        .frame(width: 4, height: 4)

                    Circle()
                        .fill(hasCalendarEvent
                            ? (isSelected ? Color.white.opacity(0.9) : Color.orange)
                            : Color.clear)
                        .frame(width: 4, height: 4)

                    Circle()
                        .fill(hasReminder
                            ? (isSelected ? Color.white.opacity(0.9) : Color.purple)
                            : Color.clear)
                        .frame(width: 4, height: 4)

                    Circle()
                        .fill(hasHoliday
                            ? (isSelected ? Color.white.opacity(0.9) : Color.pink)
                            : Color.clear)
                        .frame(width: 4, height: 4)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(date.formatted(.dateTime.weekday(.wide).month(.wide).day().year()))
        .accessibilityValue(dayAccessibilityValue(
            taskCount: taskCount,
            hasTaskifyEvent: hasTaskifyEvent,
            hasCalendarEvent: hasCalendarEvent,
            hasReminder: hasReminder,
            hasHoliday: hasHoliday
        ))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func dayAccessibilityValue(
        taskCount: Int,
        hasTaskifyEvent: Bool,
        hasCalendarEvent: Bool,
        hasReminder: Bool,
        hasHoliday: Bool
    ) -> String {
        var parts: [String] = []
        if taskCount > 0 {
            parts.append("\(taskCount) \(taskCount == 1 ? "task" : "tasks")")
        }
        if hasTaskifyEvent {
            parts.append("Taskify event")
        }
        if hasCalendarEvent {
            parts.append("Apple Calendar event")
        }
        if hasReminder {
            parts.append("Apple Reminder")
        }
        if hasHoliday {
            parts.append("US holiday")
        }
        return parts.isEmpty ? "Nothing scheduled" : parts.joined(separator: ", ")
    }

    private func monthButton(systemName: String, offset: Int) -> some View {
        Button {
            changeMonth(by: offset)
        } label: {
            Image(systemName: systemName)
                .scaledFont(size: 17, weight: .semibold)
                .foregroundStyle(TaskifyTheme.accent)
                .frame(width: 38, height: 38)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(offset < 0 ? "Previous month" : "Next month")
    }

    private func changeMonth(by offset: Int) {
        guard let nextMonth = calendar.date(
            byAdding: .month,
            value: offset,
            to: visibleMonth
        ) else { return }
        withAnimation(.snappy) {
            visibleMonth = Self.startOfMonth(containing: nextMonth, calendar: calendar)
        }
    }

    private func showMonth(containing date: Date) {
        withAnimation(.snappy) {
            visibleMonth = Self.startOfMonth(containing: date, calendar: calendar)
        }
    }

    private func showMonth(month: Int, year: Int) {
        var components = calendar.dateComponents([.era], from: visibleMonth)
        components.calendar = calendar
        components.timeZone = calendar.timeZone
        components.year = year
        components.month = month
        components.day = 1
        guard let date = calendar.date(from: components) else { return }
        showMonth(containing: date)
    }

    private static func startOfMonth(containing date: Date, calendar: Calendar) -> Date {
        calendar.date(
            from: calendar.dateComponents([.year, .month], from: date)
        ) ?? calendar.startOfDay(for: date)
    }
}

struct MonthYearWheelPicker: View {
    let calendar: Calendar
    let onApply: (Int, Int) -> Void

    @State private var month: Int
    @State private var year: Int

    private var yearRange: ClosedRange<Int> {
        let currentYear = calendar.component(.year, from: Date())
        return (currentYear - 100)...(currentYear + 100)
    }

    init(
        initialDate: Date,
        calendar: Calendar,
        onApply: @escaping (Int, Int) -> Void
    ) {
        self.calendar = calendar
        self.onApply = onApply
        _month = State(initialValue: calendar.component(.month, from: initialDate))
        _year = State(initialValue: calendar.component(.year, from: initialDate))
    }

    var body: some View {
        CombinedMonthYearWheelPicker(
            month: $month,
            year: $year,
            monthNames: calendar.monthSymbols,
            years: Array(yearRange)
        )
        .padding(.horizontal, 12)
        .preferredColorScheme(.dark)
        .onChange(of: month) { _, newMonth in
            onApply(newMonth, year)
        }
        .onChange(of: year) { _, newYear in
            onApply(month, newYear)
        }
    }
}

struct CombinedMonthYearWheelPicker: UIViewRepresentable {
    @Binding var month: Int
    @Binding var year: Int
    let monthNames: [String]
    let years: [Int]

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> UIPickerView {
        let picker = UIPickerView()
        picker.dataSource = context.coordinator
        picker.delegate = context.coordinator
        picker.backgroundColor = .clear
        picker.overrideUserInterfaceStyle = .dark
        selectCurrentValues(in: picker, animated: false)
        return picker
    }

    func updateUIView(_ picker: UIPickerView, context: Context) {
        context.coordinator.parent = self
        selectCurrentValues(in: picker, animated: false)
    }

    private func selectCurrentValues(in picker: UIPickerView, animated: Bool) {
        let monthRow = min(max(month - 1, 0), max(monthNames.count - 1, 0))
        if picker.selectedRow(inComponent: 0) != monthRow {
            picker.selectRow(monthRow, inComponent: 0, animated: animated)
        }
        if let yearRow = years.firstIndex(of: year) {
            if picker.selectedRow(inComponent: 1) != yearRow {
                picker.selectRow(yearRow, inComponent: 1, animated: animated)
            }
        }
    }

    final class Coordinator: NSObject, UIPickerViewDataSource, UIPickerViewDelegate {
        var parent: CombinedMonthYearWheelPicker
        private let selectionFeedback = UISelectionFeedbackGenerator()

        init(parent: CombinedMonthYearWheelPicker) {
            self.parent = parent
            super.init()
            selectionFeedback.prepare()
        }

        func numberOfComponents(in pickerView: UIPickerView) -> Int {
            2
        }

        func pickerView(_ pickerView: UIPickerView, numberOfRowsInComponent component: Int) -> Int {
            component == 0 ? parent.monthNames.count : parent.years.count
        }

        func pickerView(
            _ pickerView: UIPickerView,
            widthForComponent component: Int
        ) -> CGFloat {
            pickerView.bounds.width * (component == 0 ? 0.57 : 0.43)
        }

        func pickerView(
            _ pickerView: UIPickerView,
            titleForRow row: Int,
            forComponent component: Int
        ) -> String? {
            if component == 0 {
                guard parent.monthNames.indices.contains(row) else { return nil }
                return parent.monthNames[row]
            }
            guard parent.years.indices.contains(row) else { return nil }
            return String(parent.years[row])
        }

        func pickerView(
            _ pickerView: UIPickerView,
            didSelectRow row: Int,
            inComponent component: Int
        ) {
            selectionFeedback.selectionChanged()
            selectionFeedback.prepare()

            if component == 0, parent.monthNames.indices.contains(row) {
                parent.month = row + 1
            } else if component == 1, parent.years.indices.contains(row) {
                parent.year = parent.years[row]
            }
        }
    }
}
