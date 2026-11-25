import CoreImage
import SwiftUI
import TaskifyCore
import UIKit
import Vision
import VisionKit

private enum BibleTrackerDateFormatting {
    static let iso8601 = ISO8601DateFormatter()
}

/// Bible reading tracker board content, ported from the PWA's `BibleTracker.tsx`.
/// Chapter-level progress with optional per-chapter verse selection, book completion,
/// and reset-to-archive, including the PWA-compatible physical print/scan round trip.
struct BibleTrackerView: View {
    @Environment(AppModel.self) private var model
    /// The app's shared store (`AppModel.bibleTrackerStore`), so progress synced from another
    /// device shows up here.
    @ObservedObject var store: BibleTrackerStore
    let showCompletedBooks: Bool

    @State private var selectedTestament: BibleTestament = .old
    @State private var expandedBookIDs: Set<String> = []
    @State private var verseEditorTarget: VerseEditorTarget?
    @State private var showingResetConfirmation = false
    @State private var expandedArchiveIDs: Set<String> = []
    @State private var archivePendingDeletion: BibleTrackerArchiveEntry?
    @State private var showingScripturePicker = false
    @State private var scriptureEntryBeingEdited: ScriptureMemoryEntry?
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
        .sheet(item: $scriptureEntryBeingEdited) { entry in
            ScriptureVerseTextEditor(entry: entry) { text in
                model.updateScriptureMemoryVerseText(entryID: entry.id, text: text)
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
                        .scaledFont(size: 18, weight: .bold)
                        .foregroundStyle(TaskifyTheme.primaryText)
                    Text(subtitleText)
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
                Spacer()
                Text(percentComplete.formatted(.percent.precision(.fractionLength(0...1))))
                    .scaledFont(size: 15, weight: .bold)
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
                .scaledFont(size: 11, weight: .bold)
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
                                    .scaledFont(size: 16, weight: .semibold)
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
                    .scaledFont(size: 11, weight: .bold)
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
                                onEdit: { scriptureEntryBeingEdited = item.entry },
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
                .scaledFont(size: 11, weight: .bold)
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
    private var readyForCompletion: Bool { chaptersRead.isSuperset(of: 1...book.chapterCount) }

    private let columns = [GridItem(.adaptive(minimum: 42), spacing: 6)]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: onToggleExpanded) {
                HStack(spacing: 10) {
                    Text(book.name)
                        .scaledFont(size: 16, weight: .semibold)
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text("\(chaptersRead.count)/\(book.chapterCount) read")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                    Image(systemName: "chevron.down")
                        .scaledFont(size: 12, weight: .bold)
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
                    HStack {
                        Spacer()
                        if readyForCompletion {
                            Button {
                                withAnimation(.snappy) { _ = store.completeBook(bookID: book.id) }
                            } label: {
                                Label("Complete Book", systemImage: "checkmark.seal.fill")
                            }
                            .buttonStyle(.borderedProminent)
                        } else {
                            Button {
                                withAnimation(.snappy) { store.markAllChaptersRead(bookID: book.id) }
                            } label: {
                                Label("Mark all as read", systemImage: "checkmark")
                            }
                            .buttonStyle(.bordered)
                            .accessibilityHint("Marks every chapter of \(book.name) as read")
                        }
                    }
                    .font(.caption.weight(.semibold))
                    .tint(TaskifyTheme.accent)

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
            .scaledFont(size: 13, weight: .semibold)
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
                                    .scaledFont(size: 12, weight: .semibold)
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
                        .scaledFont(size: 12, weight: .bold)
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
    let onEdit: () -> Void
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
                    .scaledFont(size: 22, weight: .medium)
                    .foregroundStyle(stats.dueNow ? TaskifyTheme.secondaryText : TaskifyTheme.accent)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(stats.dueNow ? "Mark \(reference) reviewed" : "\(reference) reviewed")

            Button(action: onEdit) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(reference)
                        .scaledFont(size: 16, weight: .semibold)
                        .foregroundStyle(TaskifyTheme.primaryText)

                    Text(stats.dueNow ? "Needs review" : "Reviewed")
                        .scaledFont(size: 10, weight: .bold)
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
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("scripture-memory-entry-\(reference)")
            .accessibilityHint("Edit verse text")

            Button(action: onRemove) {
                Image(systemName: "trash")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(reference)")
        }
        .padding(14)
        .taskifyGlass(cornerRadius: 18)
    }
}

private struct ScriptureVerseTextEditor: View {
    @Environment(\.dismiss) private var dismiss
    let entry: ScriptureMemoryEntry
    let onSave: (String) -> Void
    @State private var text: String

    init(entry: ScriptureMemoryEntry, onSave: @escaping (String) -> Void) {
        self.entry = entry
        self.onSave = onSave
        _text = State(initialValue: entry.reviewText ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $text)
                        .frame(minHeight: 160)
                        .accessibilityLabel("Verse text")
                        .accessibilityIdentifier("scripture-verse-editor")
                } header: {
                    Text("Verse text")
                } footer: {
                    Text("Paste or type the passage to read it when you open a review task.")
                }
            }
            .navigationTitle(ScriptureMemoryAlgorithm.reference(for: entry))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        if text != (entry.reviewText ?? "") { onSave(text) }
                        dismiss()
                    }
                }
            }
        }
        .tint(TaskifyTheme.accent)
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
                .scaledFont(size: 11, weight: .bold)
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
                            .scaledFont(size: 13, weight: .semibold)
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
                                    .scaledFont(size: 12, weight: .semibold)
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
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var job: PhysicalChecklistJob
    private enum CaptureMode: String, Identifiable {
        case document, photo

        var id: String { rawValue }
    }

    @State private var captureMode: CaptureMode?
    @State private var analyzingScan = false
    @State private var sharePayload: PhysicalChecklistSharePayload?
    @State private var scanReview = PhysicalChecklistScanReview()
    @State private var scanMessage: String?
    @State private var scanJob: PhysicalChecklistJob?
    @State private var preparingPhotos = false

    private let scanCandidates: [PhysicalChecklistJob]
    private let scanCatalog: PhysicalChecklistJob?
    let onApply: ([String]) -> Void

    init(
        job: PhysicalChecklistJob,
        startWithScanner: Bool = false,
        scanCatalog: PhysicalChecklistJob? = nil,
        onApply: @escaping ([String]) -> Void
    ) {
        _job = State(initialValue: job)
        let storedJob = PhysicalChecklistJobStore.load(ownerID: job.ownerID)
        let candidates = Self.scanCandidates(for: job, storedJob: storedJob)
        let initialMode: CaptureMode? = VNDocumentCameraViewController.isSupported
            ? .document : (UIImagePickerController.isSourceTypeAvailable(.camera) ? .photo : nil)
        _captureMode = State(initialValue: startWithScanner ? initialMode : nil)
        _preparingPhotos = State(
            initialValue: job.items.contains { !$0.photoSources.isEmpty && $0.photos.isEmpty }
        )
        scanCandidates = startWithScanner ? candidates : []
        self.scanCatalog = scanCatalog
        self.onApply = onApply
    }

    private static func scanCandidates(
        for job: PhysicalChecklistJob,
        storedJob: PhysicalChecklistJob?
    ) -> [PhysicalChecklistJob] {
        let ownerID = job.ownerID.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let boardTitle = job.title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let related = PhysicalChecklistJobStore.loadAll().values.filter { candidate in
            let candidateOwner = candidate.ownerID
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
            let candidateTitle = candidate.title
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
            return candidateOwner == ownerID
                || candidateTitle == boardTitle
                || candidateTitle.hasPrefix("\(boardTitle) –")
        }
        .sorted { lhs, rhs in
            let lhsExact = lhs.ownerID.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == ownerID
            let rhsExact = rhs.ownerID.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == ownerID
            if lhsExact != rhsExact { return lhsExact }
            return lhs.createdAt > rhs.createdAt
        }
        var result = related
        if let storedJob, !result.contains(where: { $0.id == storedJob.id }) {
            result.insert(storedJob, at: 0)
        }
        return result
    }

    private var reviewedItems: [PhysicalChecklistItem] {
        guard let scanJob else { return [] }
        return scanReview.reviewedItems(from: scanJob.items)
    }

    private var selectedApplyableIDs: [String] {
        guard let scanJob else { return [] }
        return scanReview.applyableIDs(from: scanJob.items)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Physical checklist", systemImage: "checklist")
                            .font(.headline)
                        if job.format == .taskList {
                            BoardChecklistScanHelp()
                        } else {
                            Text("Print the checklist, then mark its circles with a fill, check, or X.")
                                .font(.subheadline)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                        }
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
                        .disabled(preparingPhotos)

                        Button {
                            shareChecklist()
                        } label: {
                            Label("Share PDF", systemImage: "square.and.arrow.up")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .disabled(preparingPhotos)

                        if preparingPhotos {
                            Label("Preparing photo thumbnails…", systemImage: "photo")
                                .font(.caption)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                        }
                    }

                    if scanCatalog != nil {
                        HStack {
                            if VNDocumentCameraViewController.isSupported {
                                Button("Scan checklist", systemImage: "document.viewfinder") {
                                    captureMode = .document
                                }
                            }
                            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                                Button("Take photo", systemImage: "camera") {
                                    captureMode = .photo
                                }
                            }
                        }
                        .buttonStyle(.bordered)
                        .disabled(analyzingScan)
                    }

                    if analyzingScan {
                        ProgressView("Reading checklist…")
                    }

                    if let scanMessage {
                        Label(scanMessage, systemImage: scanReview.itemIDs.isEmpty ? "info.circle" : "checkmark.circle.fill")
                            .font(.subheadline)
                            .foregroundStyle(scanReview.itemIDs.isEmpty ? TaskifyTheme.secondaryText : TaskifyTheme.accent)
                    }

                    if !reviewedItems.isEmpty, let scanJob {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Verify detected tasks")
                                        .font(.headline)
                                    Text("Select the completed marks to apply. Already-completed tasks are kept for context.")
                                        .font(.caption)
                                        .foregroundStyle(TaskifyTheme.secondaryText)
                                }
                                Spacer()
                            }

                            HStack {
                                Button("Select all") {
                                    scanReview.selectAll(items: scanJob.items)
                                }
                                .font(.caption.weight(.semibold))
                                .disabled(scanReview.itemIDs.isEmpty)

                                Button("Clear") {
                                    scanReview.clearSelection()
                                }
                                .font(.caption.weight(.semibold))
                                .disabled(scanReview.selectedIDs.isEmpty)
                            }

                            ForEach(reviewedItems) { item in
                                Button {
                                    scanReview.toggle(itemID: item.id, items: scanJob.items)
                                } label: {
                                    HStack(spacing: 10) {
                                        Image(systemName: reviewSelectionIcon(for: item))
                                            .foregroundStyle(item.filled ? TaskifyTheme.secondaryText : TaskifyTheme.accent)
                                        VStack(alignment: .leading, spacing: 1) {
                                            Text(item.title)
                                                .font(.subheadline.weight(.semibold))
                                            if let section = item.section {
                                                Text(section)
                                                    .font(.caption)
                                                    .foregroundStyle(TaskifyTheme.secondaryText)
                                            }
                                            if item.filled {
                                                Text("Already completed")
                                                    .font(.caption2)
                                                    .foregroundStyle(TaskifyTheme.secondaryText)
                                            }
                                        }
                                        Spacer()
                                    }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .disabled(item.filled)
                            }

                            Button {
                                onApply(selectedApplyableIDs)
                                dismiss()
                            } label: {
                                Text("Apply \(selectedApplyableIDs.count) completed mark\(selectedApplyableIDs.count == 1 ? "" : "s")")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(TaskifyTheme.accent)
                            .disabled(selectedApplyableIDs.isEmpty)
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
        .task(id: job.id) {
            await preparePhotosIfNeeded()
        }
        .sheet(item: $sharePayload) { payload in
            PhysicalChecklistActivityView(items: [payload.url])
        }
        .fullScreenCover(item: $captureMode) { mode in
            Group {
                switch mode {
                case .document:
                    PhysicalChecklistDocumentScanner(onFinish: readScan)
                case .photo:
                    TaskAttachmentCameraPicker(
                        onCapture: { readScan([$0]) },
                        onCancel: { captureMode = nil }
                    )
                }
            }
            .ignoresSafeArea()
        }
    }

    private func readScan(_ images: [UIImage]) {
        captureMode = nil
        guard let catalog = scanCatalog else { return }
        let pages = images.compactMap(PhysicalChecklistCapturedPage.init)
        guard !pages.isEmpty else { return }
        let candidates = scanCandidates

        analyzingScan = true
        scanReview = PhysicalChecklistScanReview()
        scanMessage = nil
        Task {
            let result = await Task.detached(priority: .userInitiated) {
                scanPhysicalChecklistPages(pages, catalog: catalog, manifests: candidates)
            }.value
            analyzingScan = false
            guard result.recognizedPages > 0 else {
                scanMessage = "No checklist for this board could be read. Keep the whole page visible, including its title and all four corners, and try again in even light."
                return
            }

            scanJob = catalog
            scanReview.merge(detectedIDs: result.detectedIDs, items: catalog.items)
            if result.detectedIDs.isEmpty {
                scanMessage = "No marked circles could be matched to tasks on this board."
            } else {
                scanMessage = "Found \(result.detectedIDs.count) completed mark\(result.detectedIDs.count == 1 ? "" : "s") on \(result.recognizedPages) page\(result.recognizedPages == 1 ? "" : "s")."
            }
        }
    }

    /// Decrypts and shrinks each photo attachment into printable thumbnails, then updates the
    /// job so its tall rows match the photos that are actually drawn.
    private func preparePhotosIfNeeded() async {
        guard preparingPhotos else { return }
        defer { preparingPhotos = false }
        job = await PhysicalChecklistOutput.preparePhotos(for: job)
    }

    private func reviewSelectionIcon(for item: PhysicalChecklistItem) -> String {
        if item.filled {
            return "checkmark.circle.fill"
        }
        return scanReview.selectedIDs.contains(item.id) ? "checkmark.square.fill" : "square"
    }

    private func printChecklist() {
        do {
            let url = try PhysicalChecklistOutput.savePDF(for: job, model: model)
            if !PhysicalChecklistOutput.printPDF(at: url, title: job.title) {
                scanMessage = "Taskify couldn’t open print options. Try sharing the PDF."
            }
        } catch {
            scanMessage = "Taskify couldn’t create the checklist PDF."
        }
    }

    private func shareChecklist() {
        do {
            let url = try PhysicalChecklistOutput.savePDF(for: job, model: model)
            sharePayload = PhysicalChecklistSharePayload(url: url)
        } catch {
            scanMessage = "Taskify couldn’t create the checklist PDF."
        }
    }
}

struct PhysicalChecklistSharePayload: Identifiable {
    let id = UUID()
    let url: URL
}

@MainActor
enum PhysicalChecklistOutput {
    static func preparePhotos(for job: PhysicalChecklistJob) async -> PhysicalChecklistJob {
        guard job.items.contains(where: { !$0.photoSources.isEmpty && $0.photos.isEmpty }) else { return job }
        var updated = job
        for index in updated.items.indices {
            guard !Task.isCancelled else { return job }
            let sources = Array(updated.items[index].photoSources.prefix(PhysicalChecklistLayout.photoMax))
            guard !sources.isEmpty, let boardID = updated.items[index].photoBoardID else { continue }
            var photos: [Data] = []
            for source in sources {
                guard !Task.isCancelled else { return job }
                do {
                    let data = try await TaskAttachmentDataLoader.load(
                        source: source,
                        encrypted: !source.hasPrefix("data:"),
                        boardID: boardID
                    )
                    if let image = await TaskAttachmentThumbnailLoader.shared.image(
                        data: data,
                        cacheKey: "print::\(boardID)::\(source)",
                        maximumPixelSize: 240
                    ), let jpeg = image.jpegData(compressionQuality: 0.72) {
                        photos.append(jpeg)
                    }
                } catch {
                    continue
                }
            }
            updated.items[index].photos = photos
            updated.items[index].photoCount = photos.count
        }
        return updated
    }

    static func savePDF(for job: PhysicalChecklistJob, model: AppModel) throws -> URL {
        var job = job
        measureNotes(in: &job)
        let data = PhysicalChecklistPDFRenderer.render(job: job)
        let safeTitle = job.title.replacingOccurrences(of: "/", with: "-")
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(safeTitle)-checklist-\(job.id.prefix(8)).pdf")
        try data.write(to: url, options: .atomic)
        model.recordPhysicalChecklistJob(job)
        return url
    }

    static func printPDF(at url: URL, title: String) -> Bool {
        let info = UIPrintInfo(dictionary: nil)
        info.jobName = title
        info.outputType = .general
        let controller = UIPrintInteractionController.shared
        controller.printInfo = info
        controller.printingItem = url
        return controller.present(animated: true)
    }

    /// Save the note heights for the chosen paper so print and scan use the same layout.
    private static func measureNotes(in job: inout PhysicalChecklistJob) {
        let paperWidth = job.paper.sizeMM.width
        let left = PhysicalChecklistLayout.marginMM
            + (job.paper == .a6 ? BoardPrintContract.a6BindingMarginMM : 0)
        let columnWidth = paperWidth - left - PhysicalChecklistLayout.marginMM
        // Measure a little narrower so the browser's Helvetica wrapping also fits the row.
        let noteWidthMM = max(1, columnWidth - PhysicalChecklistLayout.circleSizeMM - 2.4) * 0.98
        let width = max(1, noteWidthMM * 72.0 / 25.4)
        let font = UIFont(name: "Helvetica", size: 5.8) ?? UIFont.systemFont(ofSize: 5.8)
        let lineHeight = max(1, font.ascender - font.descender + font.leading)
        for index in job.items.indices {
            guard let note = job.items[index].note, !note.isEmpty else { continue }
            let bounds = (note as NSString).boundingRect(
                with: CGSize(width: width, height: .greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading],
                attributes: [.font: font],
                context: nil
            )
            job.items[index].noteLineCount = max(1, Int((bounds.height / lineHeight).rounded(.up)))
        }
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
        let subtitle = "Page \(page.index + 1) of \(layout.pages.count) • Layout \(layout.layoutVersion) • Print \(job.id.prefix(8).uppercased())"
        (subtitle as NSString).draw(
            in: rectMM(PhysicalChecklistLayout.marginMM, layout.headerTopMM + 7, size.width * 0.72, 5),
            withAttributes: [.font: UIFont.systemFont(ofSize: 7), .foregroundColor: UIColor.darkGray]
        )

        for (bit, center) in layout.pageIDBitCentersMM().enumerated() {
            let side = PhysicalChecklistLayout.pageIDSizeMM
            let rect = rectMM(center.x - side / 2, center.y - side / 2, side, side)
            let path = UIBezierPath(rect: rect)
            if BoardPrintContract.pagePattern(pageIndex: page.index)[bit] != 0 {
                UIColor.black.setFill()
                path.fill()
            } else {
                UIColor.black.setStroke()
                path.lineWidth = 0.7
                path.stroke()
            }
        }

        let jobCode = BoardPrintContract.jobCodePattern(jobID: job.id)
        for (bit, center) in layout.jobCodeBitCentersMM(jobID: job.id).enumerated() {
            let side = BoardPrintContract.jobCodeMarkerSizeMM
            let rect = rectMM(center.x - side / 2, center.y - side / 2, side, side)
            let path = UIBezierPath(rect: rect)
            if jobCode[bit] != 0 {
                UIColor.black.setFill()
                path.fill()
            } else {
                UIColor.black.setStroke()
                path.lineWidth = 0.6
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
                let textWidth = max(1, row.xMM + row.widthMM - textX)
                let titleHeight = 4.6
                let titleFont = UIFont.systemFont(ofSize: layout.circleSizeMM < 4 ? 6.4 : 8.2)
                let dueFont = UIFont.systemFont(ofSize: 6.6, weight: .semibold)
                let dueWidthMM = (item.dueText.map {
                    ($0 as NSString).size(withAttributes: [.font: dueFont]).width / pointsPerMM
                } ?? 0)
                let titleWidth = dueWidthMM > 0 ? max(1, textWidth - dueWidthMM - 2) : textWidth
                (item.title as NSString).draw(
                    in: rectMM(textX, row.yMM + (row.titleBandMM - titleHeight) / 2, titleWidth, titleHeight),
                    withAttributes: [
                        .font: titleFont,
                        .foregroundColor: UIColor.black,
                    ]
                )
                if dueWidthMM > 0, let dueText = item.dueText {
                    let paragraph = NSMutableParagraphStyle()
                    paragraph.alignment = .right
                    (dueText as NSString).draw(
                        in: rectMM(
                            row.xMM + row.widthMM - dueWidthMM - 1,
                            row.yMM + (row.titleBandMM - titleHeight) / 2,
                            dueWidthMM + 1,
                            titleHeight
                        ),
                        withAttributes: [
                            .font: dueFont,
                            .foregroundColor: UIColor(white: 0.2, alpha: 0.85),
                            .paragraphStyle: paragraph,
                        ]
                    )
                }
                if layout.detailed {
                    drawDetailedContent(item: item, row: row, textX: textX, textWidth: textWidth)
                }
            }
        }
    }

    private static func drawDetailedContent(
        item: PhysicalChecklistItem,
        row: PhysicalChecklistRow,
        textX: Double,
        textWidth: Double
    ) {
        let font = UIFont(name: "Helvetica", size: 5.8) ?? UIFont.systemFont(ofSize: 5.8)
        let mutedColor = UIColor(white: 0.25, alpha: 0.72)
        var cursorY = row.yMM + row.titleBandMM

        if let note = item.note, !note.isEmpty {
            let lines = max(1, item.noteLineCount)
            let height = Double(lines) * PhysicalChecklistLayout.noteLineMM
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineBreakMode = .byWordWrapping
            (note as NSString).draw(
                in: rectMM(textX, cursorY, textWidth, height),
                withAttributes: [
                    .font: font,
                    .foregroundColor: mutedColor,
                    .paragraphStyle: paragraph,
                ]
            )
            cursorY += height
        } else if let detail = item.detail, !detail.isEmpty {
            (detail as NSString).draw(
                in: rectMM(textX, cursorY + 0.7, textWidth, 3.0),
                withAttributes: [.font: font, .foregroundColor: mutedColor]
            )
            cursorY += PhysicalChecklistLayout.detailLineMM
        }

        let subtasks = item.subtasks.filter {
            !$0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        let shownSubtasks = subtasks.prefix(PhysicalChecklistLayout.subtaskMax)
        for subtask in shownSubtasks {
            let boxSide = 1.8
            let boxRect = rectMM(
                textX,
                cursorY + (PhysicalChecklistLayout.subtaskLineMM - boxSide) / 2,
                boxSide,
                boxSide
            )
            let box = UIBezierPath(rect: boxRect)
            if subtask.completed {
                UIColor.black.setFill()
                box.fill()
            } else {
                UIColor.black.setStroke()
                box.lineWidth = 0.6
                box.stroke()
            }
            (subtask.title as NSString).draw(
                in: rectMM(textX + 2.8, cursorY + 0.7, max(1, textWidth - 2.8), 3.0),
                withAttributes: [.font: font, .foregroundColor: UIColor.black]
            )
            cursorY += PhysicalChecklistLayout.subtaskLineMM
        }
        if subtasks.count > shownSubtasks.count {
            ("+\(subtasks.count - shownSubtasks.count) more" as NSString).draw(
                in: rectMM(textX + 2.8, cursorY + 0.7, max(1, textWidth - 2.8), 3.0),
                withAttributes: [.font: font, .foregroundColor: mutedColor]
            )
            cursorY += PhysicalChecklistLayout.subtaskLineMM
        }

        let photos = item.photos.prefix(PhysicalChecklistLayout.photoMax)
        guard !photos.isEmpty else { return }
        let photoSize = PhysicalChecklistLayout.photoSizeMM
        let photoGap = 1.5
        for (index, data) in photos.enumerated() {
            guard let image = UIImage(data: data) else { continue }
            let rect = rectMM(
                textX + Double(index) * (photoSize + photoGap),
                cursorY + 1,
                photoSize,
                photoSize
            )
            drawPhoto(image, in: rect)
        }
    }

    private static func drawPhoto(_ image: UIImage, in rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        context.saveGState()
        UIBezierPath(rect: rect).addClip()
        UIColor.white.setFill()
        UIRectFill(rect)
        let scale = max(rect.width / max(image.size.width, 1), rect.height / max(image.size.height, 1))
        let drawSize = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        image.draw(in: CGRect(
            x: rect.midX - drawSize.width / 2,
            y: rect.midY - drawSize.height / 2,
            width: drawSize.width,
            height: drawSize.height
        ))
        context.restoreGState()
        UIColor(white: 0.25, alpha: 0.25).setStroke()
        UIBezierPath(rect: rect).stroke()
    }

    private static func jobTextGap(for layout: PhysicalChecklistLayout) -> Double {
        layout.circleSizeMM < 4 ? 1.2 : 2.4
    }
}

struct PhysicalChecklistActivityView: UIViewControllerRepresentable {
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

struct PhysicalChecklistCapturedPage: Sendable {
    let image: CGImage
    let orientation: CGImagePropertyOrientation

    init?(_ source: UIImage) {
        guard let image = source.cgImage else { return nil }
        self.image = image
        switch source.imageOrientation {
        case .up: orientation = .up
        case .down: orientation = .down
        case .left: orientation = .left
        case .right: orientation = .right
        case .upMirrored: orientation = .upMirrored
        case .downMirrored: orientation = .downMirrored
        case .leftMirrored: orientation = .leftMirrored
        case .rightMirrored: orientation = .rightMirrored
        @unknown default: orientation = .up
        }
    }

    func grayImage(using context: CIContext) -> PhysicalChecklistGrayImage? {
        let cgImage: CGImage
        if orientation == .up {
            cgImage = image
        } else {
            let oriented = CIImage(cgImage: image).oriented(orientation)
            guard let rotated = context.createCGImage(oriented, from: oriented.extent) else { return nil }
            cgImage = rotated
        }
        // Use the original pixels for OCR; bound the grayscale work for high-resolution photos.
        let maximumEdge = 3200.0
        let scale = min(1, maximumEdge / Double(max(cgImage.width, cgImage.height)))
        return PhysicalChecklistGrayImage.from(cgImage: cgImage, targetWidth: max(1, Int(Double(cgImage.width) * scale)))
    }

    func readText() -> [PhysicalChecklistOCRLine] {
        Self.readObservations(in: image, orientation: orientation, correctLanguage: false)
            .compactMap(Self.textLine)
    }

    func readHandwriting(using context: CIContext) -> [PhysicalChecklistOCRLine] {
        let observations = Self.readObservations(in: image, orientation: orientation, correctLanguage: true)
        let oriented = CIImage(cgImage: image).oriented(orientation)
        let aspect = oriented.extent.height / oriented.extent.width
        let angles = observations.compactMap { line -> Double? in
            let width = line.topRight.x - line.topLeft.x
            guard width > 0.06 else { return nil }
            return atan2((line.topLeft.y - line.topRight.y) * aspect, width)
        }.sorted()
        let original = observations.compactMap(Self.textLine)
        guard angles.count >= 2 else { return original }
        let angle = angles[angles.count / 2]
        guard (0.05...0.44).contains(abs(angle)) else { return original }

        // For a tilted notebook, overlapping lines can become one OCR observation. A
        // rotation from the observed baselines lets Vision read the lines individually.
        let leveled = oriented.transformed(by: CGAffineTransform(rotationAngle: angle))
        guard let leveledImage = context.createCGImage(leveled, from: leveled.extent) else { return original }
        let corrected = Self.readObservations(in: leveledImage, orientation: .up, correctLanguage: true)
            .compactMap(Self.textLine)
        return corrected.count >= original.count ? corrected : original
    }

    private static func readObservations(
        in image: CGImage,
        orientation: CGImagePropertyOrientation,
        correctLanguage: Bool
    ) -> [VNRecognizedTextObservation] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = correctLanguage
        request.minimumTextHeight = 0.004
        let handler = VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:])
        try? handler.perform([request])
        return request.results ?? []
    }

    private static func textLine(_ observation: VNRecognizedTextObservation) -> PhysicalChecklistOCRLine? {
        guard let candidate = observation.topCandidates(1).first,
              candidate.confidence >= 0.25 else { return nil }
        let box = observation.boundingBox
        return PhysicalChecklistOCRLine(
            text: candidate.string,
            x: box.minX,
            y: 1 - box.maxY,
            width: box.width,
            height: box.height,
            confidence: Double(candidate.confidence)
        )
    }
}

private func scanPhysicalChecklistPages(
    _ pages: [PhysicalChecklistCapturedPage],
    catalog: PhysicalChecklistJob,
    manifests: [PhysicalChecklistJob]
) -> PhysicalChecklistScanResult {
    let context = CIContext()
    let liveIDs = Set(catalog.items.map(\.id))
    var detected = Set<String>()
    var recognizedPages = 0

    for page in pages {
        guard let image = page.grayImage(using: context) else { continue }
        let lines = page.readText()
        // A readable printed ID allows older task titles from a saved manifest to match,
        // even if a task was renamed after printing. The circle still comes from the image.
        let headerTokens = Set(lines.filter { $0.y < 0.20 }.flatMap { line in
            line.text.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init)
        })
        let matchingManifests = manifests.filter {
            $0.id.count >= 8 && headerTokens.contains(String($0.id.prefix(8)).lowercased())
        }
        var pageCatalog = catalog
        if matchingManifests.count == 1, let manifest = matchingManifests.first {
            pageCatalog.title = manifest.title
            pageCatalog.items = manifest.items
        }
        let result = PhysicalChecklistScanEngine.scanBoardPage(image: image, lines: lines, catalog: pageCatalog)
        recognizedPages += result.recognizedPages
        detected.formUnion(result.detectedIDs.filter { liveIDs.contains($0) })
    }
    return PhysicalChecklistScanResult(
        detectedIDs: detected.sorted(),
        recognizedPages: recognizedPages,
        mismatchedJobs: 0,
        unreadablePageIDs: 0
    )
}
