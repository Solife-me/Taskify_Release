import SwiftUI
import TaskifyCore

extension Optional where Wrapped == String {
    var trimmedOrNil: String? {
        guard let value = self?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }
}

private func senderLabel(_ sender: SharedInboxSender) -> String {
    sender.name.trimmedOrNil ?? sender.npub.map { String($0.prefix(16)) } ?? String(sender.publicKey.prefix(12))
}

func formattedISO(_ value: String?) -> String? {
    guard let value, let date = ISO8601DateFormatter().date(from: value) else { return nil }
    return date.formatted(date: .abbreviated, time: .shortened)
}

struct MacInboxView: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        List {
            Section("Shared Tasks") {
                ForEach(model.sharedInboxItems.filter { $0.status == .pending }) { item in
                    VStack(alignment: .leading, spacing: 10) {
                        Text(item.task.title).font(.headline)
                        Text("From \(senderLabel(item.sender))").font(.caption).foregroundStyle(.secondary)
                        HStack {
                            Button("Accept") { _ = model.respondToSharedInboxItem(item.id, status: .accepted) }
                            Button("Tentative") { _ = model.respondToSharedInboxItem(item.id, status: .tentative) }
                            Button("Decline") { _ = model.respondToSharedInboxItem(item.id, status: .declined) }
                        }
                    }.padding(10)
                }
            }
            Section("Shared Boards") {
                ForEach(model.sharedBoardInboxItems.filter { $0.status == .pending }) { item in
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(item.board.boardName ?? "Shared board").font(.headline)
                            Text("From \(senderLabel(item.sender))").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Join") { _ = model.acceptSharedBoardInboxItem(item.id) }
                        Button("Dismiss") { model.dismissSharedBoardInboxItem(item.id) }
                    }
                }
            }
            Section("Calendar Invitations") {
                ForEach(model.sharedCalendarInviteItems.filter { $0.status == .pending }) { item in
                    VStack(alignment: .leading, spacing: 10) {
                        Text(item.event.title ?? "Calendar invitation").font(.headline)
                        Text("From \(senderLabel(item.sender))").font(.caption).foregroundStyle(.secondary)
                        if let start = formattedISO(item.event.start) { Text(start).font(.caption).foregroundStyle(.secondary) }
                        HStack {
                            ForEach([SharedInboxItemStatus.accepted, .tentative, .declined], id: \.rawValue) { status in
                                Button(status.rawValue.capitalized) {
                                    Task { do { try await model.respondToSharedCalendarInvite(item.id, status: status) } catch { model.errorMessage = error.localizedDescription } }
                                }
                            }
                        }
                    }.padding(10)
                }
            }
            Section("Shared Contacts") {
                ForEach(model.sharedContactInboxItems.filter { $0.status == .pending }) { item in
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(item.contact.displayName.trimmedOrNil ?? item.contact.name.trimmedOrNil ?? item.contact.npub).font(.headline)
                            Text("From \(senderLabel(item.sender))").font(.caption).foregroundStyle(.secondary)
                            if let about = item.contact.about.trimmedOrNil { Text(about).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                        }
                        Spacer()
                        Button("Save Contact") { Task { do { try await model.acceptSharedContactInboxItem(item.id) } catch { model.errorMessage = error.localizedDescription } } }
                        Button("Dismiss") { model.dismissSharedContactInboxItem(item.id) }
                    }
                }
            }
        }.listStyle(.inset)
            .overlay { if model.pendingSharedInboxCount == 0 { ContentUnavailableView("Inbox Clear", systemImage: "tray", description: Text("Tasks, contacts and boards shared with you will appear here.")) } }
    }
}

struct MacBibleView: View {
    @EnvironmentObject private var store: BibleTrackerStore
    @Environment(AppModel.self) private var model
    @State private var selectedBook = "gen"
    @State private var mode = "reading"
    @State private var printingChecklist = false
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Picker("Mode", selection: $mode) {
                    Text("Reading").tag("reading")
                    Text("Memory").tag("memory")
                }.pickerStyle(.segmented).labelsHidden().frame(width: 220)
                if mode == "reading" {
                    Spacer()
                    Button { printingChecklist = true } label: { Label("Print & Scan…", systemImage: "printer") }
                }
            }.padding(12)
            Divider()
            if mode == "memory" {
                if model.scriptureMemoryEnabled {
                    MacScriptureMemoryView()
                } else {
                    ContentUnavailableView("Scripture Memory Is Off", systemImage: "text.book.closed",
                        description: Text("Turn it on in Settings \u{2192} General to start memorizing passages."))
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else {
                reading
            }
        }
        .sheet(isPresented: $printingChecklist) {
            MacPrintChecklistSheet(title: "Bible Reading Tracker", allItems: MacChecklistItems.forBibleTracker(store),
                format: .bibleChapters, showsIncludeCompletedToggle: false)
        }
    }
    private var reading: some View {
        HSplitView {
            List(BibleCatalog.books, selection: $selectedBook) { book in
                HStack { Text(book.name); Spacer(); Text("\(store.chaptersRead(bookID: book.id).count)/\(book.chapterCount)").font(.caption).foregroundStyle(.secondary) }.tag(book.id)
            }.frame(minWidth: 180, idealWidth: 230, maxWidth: 290)
            if let book = BibleCatalog.books.first(where: { $0.id == selectedBook }) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        Text(book.name).font(.largeTitle.bold())
                        Text("\(store.totalChaptersRead) chapters read across your Bible").foregroundStyle(.secondary)
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 54))], spacing: 12) {
                            ForEach(1...book.chapterCount, id: \.self) { chapter in
                                Button { store.toggleChapter(bookID: book.id, chapter: chapter) } label: {
                                    Text("\(chapter)").frame(maxWidth: .infinity).frame(height: 44)
                                        .background(store.chaptersRead(bookID: book.id).contains(chapter) ? Color.accentColor.opacity(0.25) : Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
                                }.buttonStyle(.plain).accessibilityLabel("Chapter \(chapter), \(store.chaptersRead(bookID: book.id).contains(chapter) ? "read" : "unread")")
                            }
                        }
                    }.padding(30)
                }.frame(minWidth: 350)
            }
        }
    }
}
