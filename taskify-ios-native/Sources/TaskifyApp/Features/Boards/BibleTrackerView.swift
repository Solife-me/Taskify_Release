import SwiftUI
import TaskifyCore

private enum BibleTrackerDateFormatting {
    static let iso8601 = ISO8601DateFormatter()
}

/// Bible reading tracker board content, ported from the PWA's `BibleTracker.tsx`.
/// Chapter-level progress with optional per-chapter verse selection, book completion,
/// and reset-to-archive — everything except printing/scanning, which is a separate
/// physical-checklist round-trip system not ported to iOS.
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
        .background(TaskifyTheme.background.ignoresSafeArea())
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

            Button {
                showingResetConfirmation = true
            } label: {
                Label("Reset Progress", systemImage: "arrow.counterclockwise")
                    .font(.caption.weight(.semibold))
            }
            .buttonStyle(.bordered)
        }
        .padding(16)
        .taskifyGlass(cornerRadius: 22)
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
        let baseDays = Double(model.scriptureMemoryFrequency.days)
        let now = Date()
        let total = model.scriptureMemoryState.entries.count
        return model.scriptureMemoryState.entries
            .map { ($0, ScriptureMemoryAlgorithm.stats(for: $0, baseDays: baseDays, totalEntries: total, now: now)) }
            .sorted { lhs, rhs in
                if lhs.1.score == rhs.1.score { return lhs.1.dueInDays < rhs.1.dueInDays }
                return lhs.1.score > rhs.1.score
            }
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
