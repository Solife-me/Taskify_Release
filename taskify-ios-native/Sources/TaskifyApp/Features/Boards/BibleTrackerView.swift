import SwiftUI
import TaskifyCore
import UIKit
import VisionKit

private enum BibleTrackerDateFormatting {
    static let iso8601 = ISO8601DateFormatter()
}

/// Bible reading tracker board content, ported from the PWA's `BibleTracker.tsx`.
/// Chapter-level progress with optional per-chapter verse selection, book completion,
/// and reset-to-archive, including the PWA-compatible physical print/scan round trip.
struct BibleTrackerView: View {
    @Environment(AppModel.self) private var model
    @StateObject private var store = BibleTrackerStore()
    let showCompletedBooks: Bool

    @State private var selectedTestament: BibleTestament = .old
    @State private var expandedBookIDs: Set<String> = []
    @State private var verseEditorTarget: VerseEditorTarget?
    @State private var showingResetConfirmation = false
    @State private var expandedArchiveIDs: Set<String> = []
    @State private var archivePendingDeletion: BibleTrackerArchiveEntry?
    @State private var showingScripturePicker = false
    @State private var scriptureEntryPendingDeletion: ScriptureMemoryEntry?
    @State private var showingPhysicalChecklist = false

    private struct VerseEditorTarget: Identifiable {
        let bookID: String
        let chapter: Int
        var id: String { "\(bookID):\(chapter)" }
    }

    private var percentComplete: Double {
        guard BibleCatalog.totalChapters > 0 else { return 0 }
        return Double(store.totalChaptersRead) / Double(BibleCatalog.totalChapters)
    }

    private var lastResetDate: Date? {
        BibleTrackerDateFormatting.iso8601.date(from: store.state.lastResetISO)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                progressHeader

                if showCompletedBooks {
                    completedBooksSection
                } else {
                    testamentPicker
                    bookList
                }

                scriptureMemorySection
                archiveSection
            }
            .padding(18)
        }
        .scrollIndicators(.hidden)
        .background(TaskifyContentBackground().ignoresSafeArea())
        .sheet(item: $verseEditorTarget) { target in
            VerseEditorSheet(store: store, bookID: target.bookID, chapter: target.chapter)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .confirmationDialog(
            "Reset your Bible reading progress?",
            isPresented: $showingResetConfirmation,
            titleVisibility: .visible
        ) {
            Button("Reset & Archive", role: .destructive) {
                withAnimation(.snappy) { store.resetProgress() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This archives your current progress and clears the tracker.")
        }
        .confirmationDialog(
            "Delete this archived snapshot?",
            isPresented: Binding(
                get: { archivePendingDeletion != nil },
                set: { isPresented in if !isPresented { archivePendingDeletion = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                if let entry = archivePendingDeletion {
                    store.deleteArchiveEntry(entry.id)
                }
                archivePendingDeletion = nil
            }
            Button("Cancel", role: .cancel) { archivePendingDeletion = nil }
        }
        .sheet(isPresented: $showingScripturePicker) {
            ScripturePickerSheet { bookID, chapter, startVerse, endVerse in
                model.addScriptureMemoryEntry(bookID: bookID, chapter: chapter, startVerse: startVerse, endVerse: endVerse)
            }
        }
        .sheet(isPresented: $showingPhysicalChecklist) {
            PhysicalChecklistSheet(job: biblePrintJob) { scannedIDs in
                withAnimation(.snappy) {
                    store.applyScannedChapters(Set(scannedIDs))
                }
            }
        }
        .confirmationDialog(
            "Remove this passage?",
            isPresented: Binding(
                get: { scriptureEntryPendingDeletion != nil },
                set: { isPresented in if !isPresented { scriptureEntryPendingDeletion = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Remove", role: .destructive) {
                if let entry = scriptureEntryPendingDeletion {
                    model.removeScriptureMemoryEntry(entry.id)
                }
                scriptureEntryPendingDeletion = nil
            }
            Button("Cancel", role: .cancel) { scriptureEntryPendingDeletion = nil }
        }
    }

    private var progressHeader: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Bible Reading Tracker")
                        .font(.system(size: 18, weight: .bold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                    Text(subtitleText)
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
                Spacer()
                Text(percentComplete.formatted(.percent.precision(.fractionLength(0...1))))
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(TaskifyTheme.accent)
            }

            ProgressView(value: percentComplete)
                .tint(TaskifyTheme.accent)

            HStack {
                Button {
                    showingPhysicalChecklist = true
                } label: {
                    Label("Print & Scan", systemImage: "printer")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.bordered)

                Button {
                    showingResetConfirmation = true
                } label: {
                    Label("Reset Progress", systemImage: "arrow.counterclockwise")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(16)
        .taskifyGlass(cornerRadius: 22)
    }

    private var biblePrintJob: PhysicalChecklistJob {
        PhysicalChecklistJob(
            ownerID: "bible-tracker",
            title: "Bible Reading Tracker",
            format: .bibleChapters,
            items: BibleCatalog.books.flatMap { book in
                (1...book.chapterCount).map { chapter in
                    PhysicalChecklistItem(
                        id: "\(book.id):\(chapter)",
                        title: "Chapter \(chapter)",
                        section: book.name,
                        filled: store.chaptersRead(bookID: book.id).contains(chapter)
                    )
                }
            }
        )
    }

    private var subtitleText: String {
        let sinceText = lastResetDate.map { "since \($0.formatted(date: .abbreviated, time: .omitted))" } ?? ""
        return "\(store.totalChaptersRead) of \(BibleCatalog.totalChapters) chapters read \(sinceText)"
    }

    private var testamentPicker: some View {
        Picker("Testament", selection: $selectedTestament) {
            Text("Old Testament").tag(BibleTestament.old)
            Text("New Testament").tag(BibleTestament.new)
        }
        .pickerStyle(.segmented)
    }

    private var activeBooks: [BibleBook] {
        let source = selectedTestament == .old ? BibleCatalog.oldTestamentBooks : BibleCatalog.newTestamentBooks
        return source.filter { !store.isBookCompleted($0.id) }
    }

    @ViewBuilder
    private var bookList: some View {
        if activeBooks.isEmpty {
            Text("Every book in this testament is complete. Check Completed Books to restore one.")
                .font(.subheadline)
                .foregroundStyle(TaskifyTheme.secondaryText)
                .padding(.top, 6)
        } else {
            LazyVStack(spacing: 9) {
                ForEach(activeBooks) { book in
                    BibleBookRow(
                        book: book,
                        store: store,
                        isExpanded: expandedBookIDs.contains(book.id),
                        onToggleExpanded: { toggleExpanded(book.id) },
                        onLongPressChapter: { chapter in
                            verseEditorTarget = VerseEditorTarget(bookID: book.id, chapter: chapter)
                        }
                    )
                }
            }
        }
    }

    private func toggleExpanded(_ bookID: String) {
        withAnimation(.snappy) {
            if expandedBookIDs.contains(bookID) {
                expandedBookIDs.remove(bookID)
            } else {
                expandedBookIDs.insert(bookID)
            }
        }
    }

    private var completedBookEntries: [(book: BibleBook, completedAt: Date?)] {
        BibleCatalog.books
            .filter { store.isBookCompleted($0.id) }
            .map { ($0, store.completedAt($0.id)) }
            .sorted { ($0.completedAt ?? .distantPast) > ($1.completedAt ?? .distantPast) }
    }

    @ViewBuilder
    private var completedBooksSection: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("COMPLETED BOOKS")
                .font(.system(size: 11, weight: .bold))
                .tracking(1)
                .foregroundStyle(TaskifyTheme.tertiaryText)

            if completedBookEntries.isEmpty {
                Text("No completed books yet.")
                    .font(.subheadline)
                    .foregroundStyle(TaskifyTheme.secondaryText)
            } else {
                LazyVStack(spacing: 9) {
                    ForEach(completedBookEntries, id: \.book.id) { entry in
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(entry.book.name)
                                    .font(.system(size: 16, weight: .semibold))
                                    .foregroundStyle(TaskifyTheme.primaryText)
                                Text(entry.completedAt.map {
                                    "Completed \($0.formatted(date: .abbreviated, time: .omitted))"
                                } ?? "Completed")
                                .font(.caption)
                                .foregroundStyle(TaskifyTheme.tertiaryText)
                            }
                            Spacer()
                            Button {
                                withAnimation(.snappy) { store.restoreCompletedBook(bookID: entry.book.id) }
                            } label: {
                                Label("Restore", systemImage: "arrow.uturn.backward")
                                    .font(.caption.weight(.semibold))
                            }
                            .buttonStyle(.bordered)
                        }
                        .padding(14)
                        .taskifyGlass(cornerRadius: 18)
                    }
                }
            }
        }
    }

    private var sortedScriptureEntries: [(entry: ScriptureMemoryEntry, stats: ScriptureMemoryAlgorithm.Stats)] {
        ScriptureMemoryAlgorithm.sortedEntries(
            model.scriptureMemoryState.entries,
            sort: model.scriptureMemorySort,
            baseDays: Double(model.scriptureMemoryFrequency.days),
            now: Date()
        )
    }

    private var scriptureMemoryTargetBoardName: String? {
        model.scriptureMemoryBoardID.flatMap { boardID in
            model.scriptureMemoryEligibleBoards.first(where: { $0.id == boardID })?.name
        }
    }

    @ViewBuilder
    private var scriptureMemorySection: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline) {
                Text("SCRIPTURE MEMORY")
                    .font(.system(size: 11, weight: .bold))
                    .tracking(1)
                    .foregroundStyle(TaskifyTheme.tertiaryText)
                Spacer()
                if model.scriptureMemoryEnabled {
                    Button {
                        showingScripturePicker = true
                    } label: {
                        Label("Add", systemImage: "plus.circle")
                            .font(.caption.weight(.semibold))
                    }
                }
            }

            if !model.scriptureMemoryEnabled {
                Text("Enable Scripture Memory from Settings to start adding passages you want to review.")
                    .font(.subheadline)
                    .foregroundStyle(TaskifyTheme.secondaryText)
            } else {
                Text("Tasks appear on \(scriptureMemoryTargetBoardName ?? "your selected board"). Frequency: \(model.scriptureMemoryFrequency.label).")
                    .font(.caption2)
                    .foregroundStyle(TaskifyTheme.tertiaryText)

                if sortedScriptureEntries.isEmpty {
                    Text("Add scriptures you want to memorize. Taskify will schedule review tasks based on your settings.")
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                } else {
                    LazyVStack(spacing: 9) {
                        ForEach(sortedScriptureEntries, id: \.entry.id) { item in
                            ScriptureMemoryEntryRow(
                                entry: item.entry,
                                stats: item.stats,
                                onReview: { model.reviewScriptureMemoryEntry(item.entry.id) },
                                onRemove: { scriptureEntryPendingDeletion = item.entry }
                            )
                        }
                    }
                }
            }
        }
    }

    private var archiveSection: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("ARCHIVE")
                .font(.system(size: 11, weight: .bold))
                .tracking(1)
                .foregroundStyle(TaskifyTheme.tertiaryText)

            if store.state.archive.isEmpty {
                Text("Progress snapshots will appear here after you reset.")
                    .font(.subheadline)
                    .foregroundStyle(TaskifyTheme.secondaryText)
            } else {
                LazyVStack(spacing: 9) {
                    ForEach(store.state.archive) { entry in
                        BibleArchiveRow(
                            entry: entry,
                            isExpanded: expandedArchiveIDs.contains(entry.id),
                            onToggleExpanded: {
                                withAnimation(.snappy) {
                                    if expandedArchiveIDs.contains(entry.id) {
                                        expandedArchiveIDs.remove(entry.id)
                                    } else {
                                        expandedArchiveIDs.insert(entry.id)
                                    }
                                }
                            },
                            onRestore: { store.restoreArchiveEntry(entry.id) },
                            onDelete: { archivePendingDeletion = entry }
                        )
                    }
                }
            }
        }
    }
}

private struct BibleBookRow: View {
    let book: BibleBook
    @ObservedObject var store: BibleTrackerStore
    let isExpanded: Bool
    let onToggleExpanded: () -> Void
    let onLongPressChapter: (Int) -> Void

    private var chaptersRead: Set<Int> { store.chaptersRead(bookID: book.id) }
    private var readyForCompletion: Bool { chaptersRead.count == book.chapterCount }

    private let columns = [GridItem(.adaptive(minimum: 42), spacing: 6)]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: onToggleExpanded) {
                HStack(spacing: 10) {
                    Text(book.name)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text("\(chaptersRead.count)/\(book.chapterCount) read")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                }
                .padding(14)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(book.name)
            .accessibilityValue("\(chaptersRead.count) of \(book.chapterCount) chapters read")

            if isExpanded {
                VStack(alignment: .leading, spacing: 10) {
                    if readyForCompletion {
                        HStack {
                            Spacer()
                            Button {
                                withAnimation(.snappy) { _ = store.completeBook(bookID: book.id) }
                            } label: {
                                Label("Complete Book", systemImage: "checkmark.seal.fill")
                                    .font(.caption.weight(.semibold))
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(TaskifyTheme.accent)
                        }
                    }

                    LazyVGrid(columns: columns, spacing: 6) {
                        ForEach(1...book.chapterCount, id: \.self) { chapter in
                            ChapterButton(
                                chapter: chapter,
                                isRead: chaptersRead.contains(chapter),
                                hasPartialVerses: !store.verses(bookID: book.id, chapter: chapter).isEmpty
                                    && !chaptersRead.contains(chapter)
                            ) {
                                withAnimation(.snappy) { store.toggleChapter(bookID: book.id, chapter: chapter) }
                            } onLongPress: {
                                onLongPressChapter(chapter)
                            }
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 14)
            }
        }
        .taskifyGlass(cornerRadius: 18)
    }
}

private struct ChapterButton: View {
    let chapter: Int
    let isRead: Bool
    let hasPartialVerses: Bool
    let onTap: () -> Void
    let onLongPress: () -> Void

    // A plain SwiftUI `Button` combined with `.onLongPressGesture` is unreliable: the Button's
    // own gesture recognizer wins and a long press just fires the regular tap action. A raw
    // `DragGesture(minimumDistance: 0)` avoids that, but never releases the touch back to an
    // ancestor ScrollView's pan recognizer, which blocks scrolling when a drag starts on a cell
    // (this bites hardest on long chapter grids like Psalms). `.onLongPressGesture`'s
    // `maximumDistance` is specifically built to hand off to scrolling on movement, so pairing
    // it with a plain `.onTapGesture` is the combination that coexists with scrolling.
    @State private var isPressing = false

    var body: some View {
        Text("\(chapter)")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(isRead ? .white : TaskifyTheme.primaryText)
            .frame(width: 42, height: 36)
            .background(
                isRead ? TaskifyTheme.accent : TaskifyTheme.raisedFill,
                in: RoundedRectangle(cornerRadius: 10, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(hasPartialVerses ? TaskifyTheme.accent : .clear, lineWidth: 2)
            )
            .scaleEffect(isPressing ? 0.9 : 1)
            .animation(.easeOut(duration: 0.12), value: isPressing)
            .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .onTapGesture(perform: onTap)
            .onLongPressGesture(
                minimumDuration: 0.45,
                maximumDistance: 12,
                perform: onLongPress,
                onPressingChanged: { pressing in
                    isPressing = pressing
                }
            )
            .accessibilityElement(children: .ignore)
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel("Chapter \(chapter)")
            .accessibilityValue(isRead ? "Read" : (hasPartialVerses ? "Partially read" : "Unread"))
            .accessibilityHint("Touch and hold to select specific verses")
            .accessibilityAction { onTap() }
    }
}

private struct VerseEditorSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var store: BibleTrackerStore
    let bookID: String
    let chapter: Int

    @State private var selection: Set<Int>

    init(store: BibleTrackerStore, bookID: String, chapter: Int) {
        self.store = store
        self.bookID = bookID
        self.chapter = chapter
        _selection = State(initialValue: store.verses(bookID: bookID, chapter: chapter))
    }

    private var verseCount: Int {
        BibleCatalog.book(withID: bookID)?.verseCount(forChapter: chapter) ?? BibleCatalog.maxVersesInAnyChapter
    }

    private var bookName: String {
        BibleCatalog.book(withID: bookID)?.name ?? "Chapter"
    }

    private let columns = [GridItem(.adaptive(minimum: 44), spacing: 6)]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Select the verses you've read. This tracks progress within the chapter without marking it fully read.")
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)

                    HStack(spacing: 10) {
                        Button("Select All") { selection = Set(1...verseCount) }
                            .buttonStyle(.bordered)
                        Button("Clear") { selection = [] }
                            .buttonStyle(.bordered)
                        Spacer()
                    }
                    .font(.caption.weight(.semibold))

                    LazyVGrid(columns: columns, spacing: 6) {
                        ForEach(1...verseCount, id: \.self) { verse in
                            Button {
                                withAnimation(.snappy) {
                                    if selection.contains(verse) {
                                        selection.remove(verse)
                                    } else {
                                        selection.insert(verse)
                                    }
                                }
                            } label: {
                                Text("\(verse)")
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(selection.contains(verse) ? .white : TaskifyTheme.primaryText)
                                    .frame(width: 44, height: 36)
                                    .background(
                                        selection.contains(verse) ? TaskifyTheme.accent : TaskifyTheme.raisedFill,
                                        in: RoundedRectangle(cornerRadius: 9, style: .continuous)
                                    )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(18)
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("\(bookName) \(chapter)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        store.setVerses(bookID: bookID, chapter: chapter, verses: selection)
                        dismiss()
                    }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}

private struct BibleArchiveRow: View {
    let entry: BibleTrackerArchiveEntry
    let isExpanded: Bool
    let onToggleExpanded: () -> Void
    let onRestore: () -> Void
    let onDelete: () -> Void

    private var chapterCount: Int {
        entry.progress.values.reduce(0) { $0 + $1.count }
    }

    private var savedAtText: String {
        guard let date = BibleTrackerDateFormatting.iso8601.date(from: entry.savedAtISO) else {
            return entry.savedAtISO
        }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: onToggleExpanded) {
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Saved \(savedAtText)")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(TaskifyTheme.primaryText)
                        Text("\(chapterCount) of \(BibleCatalog.totalChapters) chapters, \(entry.completedBooks.count) books completed")
                            .font(.caption)
                            .foregroundStyle(TaskifyTheme.tertiaryText)
                    }
                    Spacer()
                    Image(systemName: "chevron.down")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                }
                .padding(14)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                HStack(spacing: 10) {
                    Button("Restore", action: onRestore)
                        .buttonStyle(.borderedProminent)
                        .tint(TaskifyTheme.accent)
                    Button("Delete", role: .destructive, action: onDelete)
                        .buttonStyle(.bordered)
                    Spacer()
                }
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 14)
                .padding(.bottom, 14)
            }
        }
        .taskifyGlass(cornerRadius: 18)
    }
}

private struct ScriptureMemoryEntryRow: View {
    let entry: ScriptureMemoryEntry
    let stats: ScriptureMemoryAlgorithm.Stats
    let onReview: () -> Void
    let onRemove: () -> Void

    private var reference: String { ScriptureMemoryAlgorithm.reference(for: entry) }

    private var addedDate: Date? {
        BibleTrackerDateFormatting.iso8601.date(from: entry.addedAtISO)
    }

    private var lastReviewDate: Date? {
        entry.lastReviewISO.flatMap { BibleTrackerDateFormatting.iso8601.date(from: $0) }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 11) {
            Button(action: onReview) {
                Image(systemName: stats.dueNow ? "circle" : "checkmark.circle.fill")
                    .font(.system(size: 22, weight: .medium))
                    .foregroundStyle(stats.dueNow ? TaskifyTheme.secondaryText : TaskifyTheme.accent)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(stats.dueNow ? "Mark \(reference) reviewed" : "\(reference) reviewed")

            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .top) {
                    Text(reference)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button(action: onRemove) {
                        Image(systemName: "trash")
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Remove \(reference)")
                }

                Text(stats.dueNow ? "Needs review" : "Reviewed")
                    .font(.system(size: 10, weight: .bold))
                    .tracking(0.6)
                    .foregroundStyle(stats.dueNow ? Color.orange : Color.green)

                VStack(alignment: .leading, spacing: 2) {
                    if let addedDate {
                        Text("Added \(addedDate.formatted(date: .abbreviated, time: .omitted))")
                    }
                    Text(lastReviewDate.map {
                        "Reviewed \($0.formatted(date: .abbreviated, time: .shortened))"
                    } ?? "Not reviewed yet")
                    Text(ScriptureMemoryAlgorithm.formatDueInLabel(stats.dueInDays))
                    Text("Stage \(entry.stage) \u{2022} \(entry.totalReviews) review\(entry.totalReviews == 1 ? "" : "s")")
                }
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.secondaryText)
            }
        }
        .padding(14)
        .taskifyGlass(cornerRadius: 18)
    }
}

private struct ScripturePickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onAdd: (String, Int, Int?, Int?) -> Void

    private enum Step: Equatable {
        case book
        case chapter(bookID: String)
        case verses(bookID: String, chapter: Int)
    }

    @State private var step: Step = .book
    @State private var startVerse: Int?
    @State private var endVerse: Int?

    private var navigationTitleText: String {
        switch step {
        case .book:
            return "Select Book"
        case .chapter(let bookID):
            return BibleCatalog.book(withID: bookID)?.name ?? "Select Chapter"
        case .verses(let bookID, let chapter):
            let name = BibleCatalog.book(withID: bookID)?.name ?? bookID
            return "\(name) \(chapter)"
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                switch step {
                case .book:
                    bookList
                case .chapter(let bookID):
                    chapterGrid(bookID: bookID)
                case .verses(let bookID, let chapter):
                    verseGrid(bookID: bookID, chapter: chapter)
                }
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle(navigationTitleText)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(step == .book ? "Cancel" : "Back", action: goBack)
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private func goBack() {
        switch step {
        case .book:
            dismiss()
        case .chapter:
            step = .book
        case .verses(let bookID, _):
            startVerse = nil
            endVerse = nil
            step = .chapter(bookID: bookID)
        }
    }

    private var bookList: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                bookGroup(title: "Old Testament", books: BibleCatalog.oldTestamentBooks)
                bookGroup(title: "New Testament", books: BibleCatalog.newTestamentBooks)
            }
            .padding(18)
        }
    }

    private func bookGroup(title: String, books: [BibleBook]) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(title.uppercased())
                .font(.system(size: 11, weight: .bold))
                .tracking(1)
                .foregroundStyle(TaskifyTheme.tertiaryText)
            VStack(spacing: 0) {
                ForEach(books) { book in
                    Button {
                        step = .chapter(bookID: book.id)
                    } label: {
                        HStack {
                            Text(book.name)
                                .foregroundStyle(TaskifyTheme.primaryText)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption)
                                .foregroundStyle(TaskifyTheme.tertiaryText)
                        }
                        .padding(.horizontal, 14)
                        .frame(height: 46)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if book.id != books.last?.id {
                        Divider().overlay(TaskifyTheme.border)
                    }
                }
            }
            .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18))
        }
    }

    private func chapterGrid(bookID: String) -> some View {
        let chapterCount = max(BibleCatalog.book(withID: bookID)?.chapterCount ?? 1, 1)
        let columns = [GridItem(.adaptive(minimum: 44), spacing: 6)]
        return ScrollView {
            LazyVGrid(columns: columns, spacing: 6) {
                ForEach(1...chapterCount, id: \.self) { chapter in
                    Button {
                        startVerse = nil
                        endVerse = nil
                        step = .verses(bookID: bookID, chapter: chapter)
                    } label: {
                        Text("\(chapter)")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(TaskifyTheme.primaryText)
                            .frame(width: 44, height: 38)
                            .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(18)
        }
    }

    private func verseGrid(bookID: String, chapter: Int) -> some View {
        let verseCount = max(BibleCatalog.book(withID: bookID)?.verseCount(forChapter: chapter) ?? 1, 1)
        let columns = [GridItem(.adaptive(minimum: 44), spacing: 6)]
        return VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Select the first and last verse for this passage, or add the entire chapter.")
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)

                    LazyVGrid(columns: columns, spacing: 6) {
                        ForEach(1...verseCount, id: \.self) { verse in
                            let active = startVerse != nil && endVerse != nil && verse >= startVerse! && verse <= endVerse!
                            Button {
                                selectVerse(verse)
                            } label: {
                                Text("\(verse)")
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(active ? .white : TaskifyTheme.primaryText)
                                    .frame(width: 44, height: 36)
                                    .background(
                                        active ? TaskifyTheme.accent : TaskifyTheme.raisedFill,
                                        in: RoundedRectangle(cornerRadius: 9, style: .continuous)
                                    )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(18)
            }

            VStack(spacing: 10) {
                HStack(spacing: 10) {
                    Button("Clear Selected") {
                        startVerse = nil
                        endVerse = nil
                    }
                    .buttonStyle(.bordered)
                    Button("Select Entire Chapter") {
                        startVerse = 1
                        endVerse = verseCount
                    }
                    .buttonStyle(.bordered)
                }
                .font(.caption.weight(.semibold))

                Button {
                    onAdd(bookID, chapter, startVerse, endVerse)
                    dismiss()
                } label: {
                    Text("Add \(selectionLabel(bookID: bookID, chapter: chapter))")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                }
                .buttonStyle(.borderedProminent)
                .tint(TaskifyTheme.accent)
                .disabled(startVerse == nil)
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 18)
        }
    }

    private func selectVerse(_ verse: Int) {
        guard let start = startVerse else {
            startVerse = verse
            endVerse = verse
            return
        }
        if let end = endVerse, start != end {
            startVerse = verse
            endVerse = verse
            return
        }
        if verse == start {
            startVerse = nil
            endVerse = nil
            return
        }
        startVerse = min(start, verse)
        endVerse = max(start, verse)
    }

    private func selectionLabel(bookID: String, chapter: Int) -> String {
        let name = BibleCatalog.book(withID: bookID)?.name ?? bookID
        guard let start = startVerse else { return "\(name) \(chapter)" }
        guard let end = endVerse, end != start else { return "\(name) \(chapter):\(start)" }
        return "\(name) \(chapter):\(start)-\(end)"
    }
}

// MARK: - Physical checklist printing and scanning

/// Native counterpart to the PWA's fiducial-marker print/scan flow. The latest print job is kept
/// locally so a scan can resolve marks to stable task/chapter IDs even after the live data changes.
struct PhysicalChecklistSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var job: PhysicalChecklistJob
    @State private var showingScanner = false
    @State private var sharePayload: PhysicalChecklistSharePayload?
    @State private var detectedIDs: [String] = []
    @State private var scanMessage: String?
    @State private var scanJob: PhysicalChecklistJob?

    let onApply: ([String]) -> Void

    init(job: PhysicalChecklistJob, onApply: @escaping ([String]) -> Void) {
        _job = State(initialValue: job)
        self.onApply = onApply
    }

    private var lastPrintedJob: PhysicalChecklistJob? {
        PhysicalChecklistJobStore.load(ownerID: job.ownerID)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Physical checklist", systemImage: "checklist")
                            .font(.headline)
                        Text("Print the checklist, fill its circles with a dark pen, then scan it here. Scans stay on this device.")
                            .font(.subheadline)
                            .foregroundStyle(TaskifyTheme.secondaryText)
                    }
                    .padding(16)
                    .taskifyGlass(cornerRadius: 20)

                    Picker("Paper", selection: $job.paper) {
                        ForEach(PhysicalChecklistPaper.allCases, id: \.self) { paper in
                            Text(paper.displayName).tag(paper)
                        }
                    }
                    .pickerStyle(.segmented)

                    VStack(spacing: 10) {
                        Button {
                            printChecklist()
                        } label: {
                            Label("Print checklist", systemImage: "printer.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(TaskifyTheme.accent)

                        Button {
                            shareChecklist()
                        } label: {
                            Label("Share PDF", systemImage: "square.and.arrow.up")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)

                        Button {
                            scanJob = lastPrintedJob ?? job
                            showingScanner = true
                        } label: {
                            Label("Scan completed checklist", systemImage: "doc.viewfinder")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .disabled(!VNDocumentCameraViewController.isSupported)
                    }

                    if let scanMessage {
                        Label(scanMessage, systemImage: detectedIDs.isEmpty ? "info.circle" : "checkmark.circle.fill")
                            .font(.subheadline)
                            .foregroundStyle(detectedIDs.isEmpty ? TaskifyTheme.secondaryText : TaskifyTheme.accent)
                    }

                    if !detectedIDs.isEmpty, let scanJob {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Detected marks")
                                .font(.headline)
                            ForEach(scanJob.items.filter { detectedIDs.contains($0.id) }) { item in
                                HStack(spacing: 10) {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(TaskifyTheme.accent)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(item.title)
                                            .font(.subheadline.weight(.semibold))
                                        if let section = item.section {
                                            Text(section)
                                                .font(.caption)
                                                .foregroundStyle(TaskifyTheme.secondaryText)
                                        }
                                    }
                                    Spacer()
                                }
                            }

                            Button {
                                onApply(detectedIDs)
                                dismiss()
                            } label: {
                                Text("Apply \(detectedIDs.count) completed mark\(detectedIDs.count == 1 ? "" : "s")")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(TaskifyTheme.accent)
                        }
                        .padding(16)
                        .taskifyGlass(cornerRadius: 20)
                    }
                }
                .padding(18)
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle(job.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .sheet(item: $sharePayload) { payload in
            PhysicalChecklistActivityView(items: [payload.url])
        }
        .fullScreenCover(isPresented: $showingScanner) {
            PhysicalChecklistDocumentScanner { images in
                showingScanner = false
                guard let scanJob else { return }
                let result = PhysicalChecklistScanAnalyzer.scan(images: images, job: scanJob)
                detectedIDs = result.detectedIDs
                if result.recognizedPages == 0 {
                    scanMessage = "No Taskify checklist page was recognized. Keep the whole page visible and try again in even light."
                } else if result.detectedIDs.isEmpty {
                    scanMessage = "The page was recognized, but no newly filled circles were found."
                } else {
                    scanMessage = "Found \(result.detectedIDs.count) completed mark\(result.detectedIDs.count == 1 ? "" : "s") on \(result.recognizedPages) page\(result.recognizedPages == 1 ? "" : "s")."
                }
            }
            .ignoresSafeArea()
        }
    }

    private func pdfURL() throws -> URL {
        let data = PhysicalChecklistPDFRenderer.render(job: job)
        let safeTitle = job.title.replacingOccurrences(of: "/", with: "-")
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(safeTitle)-checklist-\(job.id.prefix(8)).pdf")
        try data.write(to: url, options: .atomic)
        PhysicalChecklistJobStore.save(job)
        return url
    }

    private func printChecklist() {
        guard let url = try? pdfURL() else {
            scanMessage = "Taskify couldn't create the checklist PDF."
            return
        }
        let controller = UIPrintInteractionController.shared
        controller.printInfo = {
            let info = UIPrintInfo(dictionary: nil)
            info.jobName = job.title
            info.outputType = .general
            return info
        }()
        controller.printingItem = url
        controller.present(animated: true)
    }

    private func shareChecklist() {
        guard let url = try? pdfURL() else {
            scanMessage = "Taskify couldn't create the checklist PDF."
            return
        }
        sharePayload = PhysicalChecklistSharePayload(url: url)
    }
}

private struct PhysicalChecklistSharePayload: Identifiable {
    let id = UUID()
    let url: URL
}

private enum PhysicalChecklistJobStore {
    private static let key = "taskify.physical-checklist.latest-jobs.v1"

    static func save(_ job: PhysicalChecklistJob) {
        var jobs = loadAll()
        jobs[job.ownerID] = job
        if let data = try? JSONEncoder().encode(jobs) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }

    static func load(ownerID: String) -> PhysicalChecklistJob? {
        loadAll()[ownerID]
    }

    private static func loadAll() -> [String: PhysicalChecklistJob] {
        guard let data = UserDefaults.standard.data(forKey: key),
              let jobs = try? JSONDecoder().decode([String: PhysicalChecklistJob].self, from: data) else {
            return [:]
        }
        return jobs
    }
}

private enum PhysicalChecklistPDFRenderer {
    private static let pointsPerMM = 72.0 / 25.4

    static func render(job: PhysicalChecklistJob) -> Data {
        let layout = PhysicalChecklistLayout.build(job: job)
        let sizeMM = job.paper.sizeMM
        let bounds = CGRect(x: 0, y: 0, width: sizeMM.width * pointsPerMM, height: sizeMM.height * pointsPerMM)
        let format = UIGraphicsPDFRendererFormat()
        format.documentInfo = [
            kCGPDFContextTitle as String: job.title,
            kCGPDFContextCreator as String: "Taskify",
        ]

        return UIGraphicsPDFRenderer(bounds: bounds, format: format).pdfData { renderer in
            for page in layout.pages {
                renderer.beginPage()
                UIColor.white.setFill()
                UIRectFill(bounds)
                drawMarkers(layout: layout)
                drawHeader(job: job, layout: layout, page: page)
                drawRows(page.rows, layout: layout)
            }
        }
    }

    private static func rectMM(_ x: Double, _ y: Double, _ width: Double, _ height: Double) -> CGRect {
        CGRect(x: x * pointsPerMM, y: y * pointsPerMM, width: width * pointsPerMM, height: height * pointsPerMM)
    }

    private static func drawMarkers(layout: PhysicalChecklistLayout) {
        for (index, marker) in layout.markerRectsMM().enumerated() {
            let rect = rectMM(marker.x, marker.y, marker.width, marker.height)
            if index < 2 {
                UIColor.black.setStroke()
                let outer = UIBezierPath(rect: rect)
                outer.lineWidth = 1.2
                outer.stroke()
                UIColor.black.setFill()
                UIBezierPath(rect: rect.insetBy(dx: rect.width * 0.32, dy: rect.height * 0.32)).fill()
            } else {
                UIColor.black.setFill()
                UIBezierPath(rect: rect).fill()
            }
        }
    }

    private static func drawHeader(job: PhysicalChecklistJob, layout: PhysicalChecklistLayout, page: PhysicalChecklistPage) {
        let size = job.paper.sizeMM
        let titleRect = rectMM(PhysicalChecklistLayout.marginMM, layout.headerTopMM, size.width * 0.62, 7)
        (job.title as NSString).draw(
            in: titleRect,
            withAttributes: [
                .font: UIFont.systemFont(ofSize: job.format == .bibleChapters ? 13 : 15, weight: .bold),
                .foregroundColor: UIColor.black,
            ]
        )
        let subtitle = "Fill circles with a dark pen • Page \(page.index + 1) of \(layout.pages.count)"
        (subtitle as NSString).draw(
            in: rectMM(PhysicalChecklistLayout.marginMM, layout.headerTopMM + 7, size.width * 0.72, 5),
            withAttributes: [.font: UIFont.systemFont(ofSize: 7), .foregroundColor: UIColor.darkGray]
        )

        let bits = page.index + 1
        for (bit, center) in layout.pageIDBitCentersMM().enumerated() {
            let side = PhysicalChecklistLayout.pageIDSizeMM
            let rect = rectMM(center.x - side / 2, center.y - side / 2, side, side)
            let path = UIBezierPath(rect: rect)
            if bits & (1 << bit) != 0 {
                UIColor.black.setFill()
                path.fill()
            } else {
                UIColor.black.setStroke()
                path.lineWidth = 0.7
                path.stroke()
            }
        }
    }

    private static func drawRows(_ rows: [PhysicalChecklistRow], layout: PhysicalChecklistLayout) {
        for row in rows {
            switch row.kind {
            case let .section(section):
                (section.uppercased() as NSString).draw(
                    in: rectMM(row.xMM, row.yMM + 1.0, row.widthMM, 4.5),
                    withAttributes: [
                        .font: UIFont.systemFont(ofSize: 7.2, weight: .bold),
                        .foregroundColor: UIColor.darkGray,
                    ]
                )
            case let .item(item):
                guard let center = row.circleCenterMM else { continue }
                let side = layout.circleSizeMM
                let circle = UIBezierPath(ovalIn: rectMM(center.x - side / 2, center.y - side / 2, side, side))
                UIColor.black.setStroke()
                circle.lineWidth = 0.85
                circle.stroke()
                if item.filled {
                    UIColor.black.setFill()
                    circle.fill()
                }
                let textX = center.x + side / 2 + (jobTextGap(for: layout))
                let textY = row.yMM + (jobTextTop(for: layout))
                (item.title as NSString).draw(
                    in: rectMM(textX, textY, max(1, row.xMM + row.widthMM - textX), 4.6),
                    withAttributes: [
                        .font: UIFont.systemFont(ofSize: layout.circleSizeMM < 4 ? 6.4 : 8.2),
                        .foregroundColor: UIColor.black,
                    ]
                )
            }
        }
    }

    private static func jobTextGap(for layout: PhysicalChecklistLayout) -> Double {
        layout.circleSizeMM < 4 ? 1.2 : 2.4
    }

    private static func jobTextTop(for layout: PhysicalChecklistLayout) -> Double {
        layout.circleSizeMM < 4 ? 0.9 : 1.35
    }
}

private struct PhysicalChecklistActivityView: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

private struct PhysicalChecklistDocumentScanner: UIViewControllerRepresentable {
    let onFinish: ([UIImage]) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let controller = VNDocumentCameraViewController()
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ uiViewController: VNDocumentCameraViewController, context: Context) {}

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let parent: PhysicalChecklistDocumentScanner

        init(parent: PhysicalChecklistDocumentScanner) {
            self.parent = parent
        }

        func documentCameraViewController(
            _ controller: VNDocumentCameraViewController,
            didFinishWith scan: VNDocumentCameraScan
        ) {
            let images = (0..<scan.pageCount).map(scan.imageOfPage(at:))
            parent.onFinish(images)
        }

        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            parent.onFinish([])
        }

        func documentCameraViewController(
            _ controller: VNDocumentCameraViewController,
            didFailWithError error: Error
        ) {
            parent.onFinish([])
        }
    }
}

private enum PhysicalChecklistScanAnalyzer {
    struct Result {
        var detectedIDs: [String]
        var recognizedPages: Int
    }

    private struct GrayImage {
        let pixels: [UInt8]
        let width: Int
        let height: Int

        func mean(x: Double, y: Double, radius: Double) -> Double {
            let cx = min(max(Int(x * Double(width)), 0), width - 1)
            let cy = min(max(Int(y * Double(height)), 0), height - 1)
            let r = max(1, Int(radius * Double(min(width, height))))
            var sum = 0
            var count = 0
            for py in max(0, cy - r)...min(height - 1, cy + r) {
                for px in max(0, cx - r)...min(width - 1, cx + r) {
                    let dx = px - cx
                    let dy = py - cy
                    guard dx * dx + dy * dy <= r * r else { continue }
                    sum += Int(pixels[py * width + px])
                    count += 1
                }
            }
            return count == 0 ? 255 : Double(sum) / Double(count)
        }
    }

    static func scan(images: [UIImage], job: PhysicalChecklistJob) -> Result {
        let layout = PhysicalChecklistLayout.build(job: job)
        let paperSize = job.paper.sizeMM
        var detected = Set<String>()
        var recognized = Set<Int>()

        for (inputIndex, image) in images.enumerated() {
            autoreleasepool {
                guard let gray = makeGrayImage(image) else { return }
                let markerCenters = layout.markerRectsMM().map {
                    (($0.x + $0.width / 2) / paperSize.width, ($0.y + $0.height / 2) / paperSize.height)
                }
                let darkMarkerCount = markerCenters.filter {
                    gray.mean(x: $0.0, y: $0.1, radius: 0.004) < 185
                }.count
                guard darkMarkerCount >= 3 else { return }

                var encodedPage = 0
                for (bit, center) in layout.pageIDBitCentersMM().enumerated() {
                    let value = gray.mean(
                        x: center.x / paperSize.width,
                        y: center.y / paperSize.height,
                        radius: 0.0025
                    )
                    if value < 170 { encodedPage |= 1 << bit }
                }
                let decodedIndex = encodedPage - 1
                let pageIndex = layout.pages.indices.contains(decodedIndex)
                    ? decodedIndex
                    : min(inputIndex, layout.pages.count - 1)
                recognized.insert(pageIndex)

                for row in layout.pages[pageIndex].rows {
                    guard case let .item(item) = row.kind, let center = row.circleCenterMM else { continue }
                    let darkness = gray.mean(
                        x: center.x / paperSize.width,
                        y: center.y / paperSize.height,
                        radius: max(0.0015, layout.circleSizeMM / paperSize.width * 0.12)
                    )
                    if darkness < 168 {
                        detected.insert(item.id)
                    }
                }
            }
        }

        return Result(detectedIDs: detected.sorted(), recognizedPages: recognized.count)
    }

    private static func makeGrayImage(_ source: UIImage) -> GrayImage? {
        let targetWidth = 900
        let aspect = max(source.size.height / max(source.size.width, 1), 0.2)
        let targetHeight = max(1, Int(Double(targetWidth) * aspect))
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: targetWidth, height: targetHeight))
        let normalized = renderer.image { _ in
            source.draw(in: CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight))
        }
        guard let cgImage = normalized.cgImage else { return nil }
        var pixels = [UInt8](repeating: 255, count: targetWidth * targetHeight)
        let rendered = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress,
                width: targetWidth,
                height: targetHeight,
                bitsPerComponent: 8,
                bytesPerRow: targetWidth,
                space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGImageAlphaInfo.none.rawValue
            ) else { return false }
            context.interpolationQuality = .high
            // Bitmap contexts use a bottom-left origin while the checklist layout and UIKit use
            // top-left coordinates. Normalize once here so every marker/row sample maps directly.
            context.translateBy(x: 0, y: CGFloat(targetHeight))
            context.scaleBy(x: 1, y: -1)
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight))
            return true
        }
        return rendered ? GrayImage(pixels: pixels, width: targetWidth, height: targetHeight) : nil
    }
}
