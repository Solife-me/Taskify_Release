import SwiftUI
import TaskifyCore

struct MacScriptureMemoryView: View {
    @Environment(AppModel.self) private var model
    @State private var addingVerse = false
    @State private var removing: ScriptureMemoryEntry?
    private var sortedEntries: [(entry: ScriptureMemoryEntry, stats: ScriptureMemoryAlgorithm.Stats)] {
        ScriptureMemoryAlgorithm.sortedEntries(model.scriptureMemoryState.entries, sort: model.scriptureMemorySort,
            baseDays: Double(model.scriptureMemoryFrequency.days), now: Date())
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Picker("Sort", selection: Binding(get: { model.scriptureMemorySort }, set: { model.setScriptureMemorySort($0) })) {
                    ForEach(ScriptureMemorySort.allCases, id: \.self) { Text($0.label).tag($0) }
                }.labelsHidden().frame(width: 200)
                Spacer()
                Button { addingVerse = true } label: { Label("Add Verse", systemImage: "plus") }
            }.padding(14)
            Divider()
            if sortedEntries.isEmpty {
                ContentUnavailableView("No Verses Yet", systemImage: "text.book.closed",
                    description: Text("Add a passage to start memorizing it.")).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(sortedEntries, id: \.entry.id) { pair in
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(ScriptureMemoryAlgorithm.reference(for: pair.entry)).font(.headline)
                            Text(ScriptureMemoryAlgorithm.formatDueInLabel(pair.stats.dueInDays)).font(.caption)
                                .foregroundStyle(pair.stats.dueNow ? Color.orange : Color.secondary)
                        }
                        Spacer()
                        Text("Stage \(pair.entry.stage)").font(.caption2).foregroundStyle(.tertiary)
                        Button(role: .destructive) { removing = pair.entry } label: { Image(systemName: "trash") }.buttonStyle(.borderless)
                    }.padding(.vertical, 4)
                }.listStyle(.inset)
            }
        }
        .sheet(isPresented: $addingVerse) { MacAddScriptureVerse() }
        .confirmationDialog("Remove this verse from Scripture Memory?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
            Button("Remove", role: .destructive) {
                guard let entry = removing else { return }
                model.removeScriptureMemoryEntry(entry.id)
                removing = nil
            }
            Button("Cancel", role: .cancel) { removing = nil }
        }
    }
}

private struct MacAddScriptureVerse: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var bookID = "gen"
    @State private var chapter = 1
    @State private var hasVerseRange = false
    @State private var startVerse = 1
    @State private var endVerse = 1
    private var book: BibleBook? { BibleCatalog.book(withID: bookID) }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Add Verse").font(.title2.bold())
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Add") {
                    model.addScriptureMemoryEntry(bookID: bookID, chapter: chapter,
                        startVerse: hasVerseRange ? startVerse : nil, endVerse: hasVerseRange ? endVerse : nil)
                    dismiss()
                }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
            }.padding(22)
            Form {
                Picker("Book", selection: $bookID) { ForEach(BibleCatalog.books) { Text($0.name).tag($0.id) } }
                Stepper("Chapter \(chapter)", value: $chapter, in: 1...(book?.chapterCount ?? 1))
                Toggle("Specific Verses", isOn: $hasVerseRange)
                if hasVerseRange {
                    Stepper("Start Verse \(startVerse)", value: $startVerse, in: 1...200)
                    Stepper("End Verse \(endVerse)", value: $endVerse, in: startVerse...200)
                }
            }.formStyle(.grouped)
        }.frame(width: 420, height: 380)
            .onChange(of: bookID) { _, _ in chapter = 1 }
            .onChange(of: startVerse) { _, value in if endVerse < value { endVerse = value } }
    }
}
