import SwiftUI
import TaskifyCore
#if os(iOS)
import UIKit
#else
import AppKit
#endif

// Shared by the iOS app and the Mac app (see taskify-macos/Scripts/generate-project.py), so
// anything platform-specific stays behind `#if os(iOS)`.

// MARK: - Rendering

/// A task note's Markdown, rendered. With `onToggleChecklistItem`, checklist boxes are buttons
/// that report the item's line in the note (see `TaskNoteMarkdown.togglingChecklistItem`).
struct TaskNoteMarkdownView: View {
    let note: String
    var fontSize: CGFloat = 16
    /// Renders only the first blocks and a trailing ellipsis, for compact previews.
    var blockLimit: Int?
    /// Off where the note is the label of a button, so a tap opens it rather than selecting or
    /// copying code.
    var selectable = true
    var onToggleChecklistItem: ((Int) -> Void)?
    @State private var copiedCode: String?
    @State private var dataAction: TaskNoteDataAction?
    @Environment(\.openURL) private var openURL

    var body: some View {
        let allBlocks = TaskNoteMarkdown.blocks(note)
        let blocks = blockLimit.map { Array(allBlocks.prefix($0)) } ?? allBlocks
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                blockView(block)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, index == 0 ? 0 : spacing(between: blocks[index - 1], and: block))
            }
            if blocks.count < allBlocks.count {
                Text("…")
                    .font(.system(size: fontSize, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .padding(.top, 4)
            }
        }
        .environment(\.openURL, OpenURLAction { url in
            if let code = TaskNoteInline.copiedCode(from: url) {
                copy(code)
                return .handled
            }
            if let action = TaskNoteInline.dataAction(from: url) {
                dataAction = action
                return .handled
            }
            return TaskNoteInline.isSafeLink(url) ? .systemAction : .discarded
        })
        .confirmationDialog(
            dataAction?.value ?? "",
            isPresented: Binding(get: { dataAction != nil }, set: { if !$0 { dataAction = nil } }),
            titleVisibility: .visible,
            presenting: dataAction
        ) { action in
            switch action {
            case .phone(let number):
                if let url = TaskNoteDataAction.url(scheme: "tel", number: number) {
                    Button("Call") { openURL(url) }
                }
                if let url = TaskNoteDataAction.url(scheme: "sms", number: number) {
                    Button("Send Message") { openURL(url) }
                }
                Button("Copy") { copy(number) }
            case .address(let address):
                if let url = TaskNoteDataAction.mapsURL(directionsTo: address) {
                    Button("Get Directions") { openURL(url) }
                }
                if let url = TaskNoteDataAction.mapsURL(showing: address) {
                    Button("Open in Maps") { openURL(url) }
                }
                Button("Copy Address") { copy(address) }
            }
        }
        .overlay(alignment: .top) {
            if copiedCode != nil {
                Label("Copied", systemImage: "checkmark")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Color.black.opacity(0.78), in: Capsule())
                    .transition(.scale.combined(with: .opacity))
                    .allowsHitTesting(false)
                    .accessibilityIdentifier("task-note-code-copied")
            }
        }
        .task(id: copiedCode) {
            guard copiedCode != nil else { return }
            try? await Task.sleep(for: .seconds(1.25))
            withAnimation(.easeOut(duration: 0.18)) { copiedCode = nil }
        }
    }

    /// Code is tapped to copy, as in chats; phone numbers and addresses offer it too.
    private func copy(_ code: String) {
        #if os(iOS)
        UIPasteboard.general.string = code
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        #else
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(code, forType: .string)
        #endif
        withAnimation(.spring(response: 0.25, dampingFraction: 0.8)) { copiedCode = code }
    }

    @ViewBuilder
    private func blockView(_ block: TaskNoteBlock) -> some View {
        switch block {
        case .paragraph(let content):
            inlineText(content, font: .system(size: fontSize))
        case let .heading(level, content):
            inlineText(content, font: headingFont(level))
        case let .bulletItem(depth, content):
            listRow(depth: depth) {
                Text("•").font(.system(size: fontSize, weight: .bold))
            } content: {
                inlineText(content, font: .system(size: fontSize))
            }
        case let .numberedItem(depth, number, content):
            listRow(depth: depth) {
                Text("\(number).").font(.system(size: fontSize - 1, weight: .semibold)).monospacedDigit()
            } content: {
                inlineText(content, font: .system(size: fontSize))
            }
        case let .checklistItem(depth, checked, content, line):
            listRow(depth: depth) {
                checkbox(checked: checked, line: line, content: content)
            } content: {
                inlineText(content, font: .system(size: fontSize))
                    .strikethrough(checked)
                    .foregroundStyle(checked ? .secondary : .primary)
            }
        case .quote(let content):
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                    .fill(.tint.opacity(0.7))
                    .frame(width: 3)
                inlineText(content, font: .system(size: fontSize).italic())
                    .foregroundStyle(.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .code(let content):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(content)
                    .font(.system(size: fontSize - 2, design: .monospaced))
                    .fixedSize(horizontal: true, vertical: false)
            }
            .padding(10)
            .background(Color.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            .onTapGesture {
                guard selectable else { return }
                copy(content)
            }
            .accessibilityAddTraits(selectable ? .isButton : [])
            .accessibilityHint(selectable ? "Copies the code" : "")
        case .thematicBreak:
            Rectangle()
                .fill(Color.primary.opacity(0.2))
                .frame(height: 1)
                .padding(.vertical, 4)
        case .spacer(let lines):
            // One empty row per skipped line, at the body text's line height.
            Color.clear
                .frame(height: CGFloat(lines) * fontSize * 1.3)
                .accessibilityHidden(true)
        }
    }

    @ViewBuilder
    private func checkbox(checked: Bool, line: Int, content: String) -> some View {
        let image = Image(systemName: checked ? "checkmark.square.fill" : "square")
            .font(.system(size: fontSize, weight: .semibold))
            .foregroundStyle(checked ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
        if let onToggleChecklistItem {
            Button {
                onToggleChecklistItem(line)
            } label: {
                image.contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(checked ? "Uncheck \(TaskNoteMarkdown.plainInline(content))" : "Check \(TaskNoteMarkdown.plainInline(content))")
        } else {
            image.accessibilityLabel(checked ? "Checked" : "Unchecked")
        }
    }

    private func listRow<Marker: View, Content: View>(
        depth: Int,
        @ViewBuilder marker: () -> Marker,
        @ViewBuilder content: () -> Content
    ) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            marker().frame(minWidth: fontSize, alignment: .trailing)
            content()
        }
        .padding(.leading, CGFloat(depth) * fontSize * 1.2)
    }

    private func inlineText(_ markdown: String, font: Font) -> some View {
        Text(TaskNoteInline.attributed(markdown, codeSize: fontSize - 1.5, interactive: selectable))
            .font(font)
            .fixedSize(horizontal: false, vertical: true)
            .taskNoteTextSelection(selectable)
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .system(size: fontSize + 8, weight: .bold)
        case 2: .system(size: fontSize + 5, weight: .bold)
        case 3: .system(size: fontSize + 2, weight: .bold)
        default: .system(size: fontSize, weight: .semibold)
        }
    }

    /// Gaps between blocks typed on consecutive lines stay tight; a skipped row is a `spacer`
    /// and supplies its own height.
    private func spacing(between previous: TaskNoteBlock, and block: TaskNoteBlock) -> CGFloat {
        if case .spacer = previous { return 0 }
        if case .spacer = block { return 0 }
        if isListItem(previous), isListItem(block) { return 5 }
        return 6
    }

    private func isListItem(_ block: TaskNoteBlock) -> Bool {
        switch block {
        case .bulletItem, .numberedItem, .checklistItem: true
        default: false
        }
    }
}

/// A phone number or street address tapped in a note, offered as actions like Notes and Messages
/// do: call, message or copy a number; get directions to, show or copy an address.
enum TaskNoteDataAction: Equatable {
    case phone(String)
    case address(String)

    var value: String {
        switch self {
        case .phone(let number): number
        case .address(let address): address
        }
    }

    static func url(scheme: String, number: String) -> URL? {
        let dialable = number.filter { $0.isNumber || $0 == "+" }
        guard dialable.contains(where: \.isNumber) else { return nil }
        return URL(string: "\(scheme):\(dialable)")
    }

    /// Apple Maps links open the Maps app on iOS and macOS.
    static func mapsURL(directionsTo address: String) -> URL? {
        mapsURL(query: [URLQueryItem(name: "daddr", value: address)])
    }

    static func mapsURL(showing address: String) -> URL? {
        mapsURL(query: [URLQueryItem(name: "q", value: address)])
    }

    private static func mapsURL(query: [URLQueryItem]) -> URL? {
        var components = URLComponents(string: "https://maps.apple.com/")
        components?.queryItems = query
        return components?.url
    }
}

enum TaskNoteInline {
    private static let linkDetector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
    private static let dataDetector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue
        | NSTextCheckingResult.CheckingType.phoneNumber.rawValue
        | NSTextCheckingResult.CheckingType.address.rawValue)
    private static let copyScheme = "taskify-note-copy"
    private static let actionScheme = "taskify-note-action"

    /// Inline Markdown as styled text, with bare URLs linked and unsafe link schemes dropped.
    /// When `interactive` (the viewer, not a card preview), inline code is a link that copies it
    /// (see `copiedCode(from:)`) and phone numbers and addresses are links to their actions
    /// (see `dataAction(from:)`).
    static func attributed(_ markdown: String, codeSize: CGFloat, interactive: Bool = false) -> AttributedString {
        var attributed = (try? AttributedString(
            markdown: markdown,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(markdown)

        for run in attributed.runs {
            if run.inlinePresentationIntent?.contains(.code) == true {
                attributed[run.range].font = .system(size: codeSize, design: .monospaced)
                attributed[run.range].backgroundColor = Color.primary.opacity(0.1)
                if interactive {
                    attributed[run.range].link = copyURL(for: String(attributed[run.range].characters))
                    attributed[run.range].foregroundColor = .primary
                }
                continue
            }
            if let link = run.link, !isSafeLink(link) {
                attributed[run.range].link = nil
            }
        }

        let plain = String(attributed.characters)
        let detector = interactive ? dataDetector : linkDetector
        guard let detector, interactive || plain.contains(":") || plain.contains("www.") else { return attributed }
        for match in detector.matches(in: plain, range: NSRange(plain.startIndex..., in: plain)) {
            let link: URL?
            switch match.resultType {
            case .phoneNumber:
                link = match.phoneNumber.flatMap { actionURL(host: "phone", value: $0) }
            case .address:
                link = (Range(match.range, in: plain)).flatMap { actionURL(host: "address", value: String(plain[$0])) }
            default:
                link = match.url.flatMap { isSafeLink($0) ? $0 : nil }
            }
            guard let link,
                  let range = Range(match.range, in: attributed),
                  attributed[range].runs.allSatisfy({ $0.link == nil }) else { continue }
            attributed[range].link = link
        }
        return attributed
    }

    private static func actionURL(host: String, value: String) -> URL? {
        var components = URLComponents()
        components.scheme = actionScheme
        components.host = host
        // A detected address can span lines; it is shown and searched on one.
        components.queryItems = [URLQueryItem(name: "value", value: value.split(whereSeparator: \.isNewline).joined(separator: " "))]
        return components.url
    }

    static func dataAction(from url: URL) -> TaskNoteDataAction? {
        guard url.scheme?.lowercased() == actionScheme,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let value = components.queryItems?.first(where: { $0.name == "value" })?.value,
              !value.isEmpty else { return nil }
        switch components.host {
        case "phone": return .phone(value)
        case "address": return .address(value)
        default: return nil
        }
    }

    static func copyURL(for code: String) -> URL? {
        guard !code.isEmpty else { return nil }
        var components = URLComponents()
        components.scheme = copyScheme
        components.host = "code"
        components.queryItems = [URLQueryItem(name: "value", value: code)]
        return components.url
    }

    static func copiedCode(from url: URL) -> String? {
        guard url.scheme?.lowercased() == copyScheme,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        return components.queryItems?.first { $0.name == "value" }?.value
    }

    static func isSafeLink(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "https" || scheme == "http" || scheme == "mailto"
    }
}

// MARK: - Viewer

/// The full note of a task, with tickable checklist items, an Edit button for the note editor
/// and a way to turn the checklist into real subtasks.
struct TaskNoteViewerView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let taskID: String
    @State private var editing = false

    private var task: TaskItem? { model.task(withID: taskID) }

    var body: some View {
        NavigationStack {
            Group {
                if let task {
                    content(task)
                } else {
                    ContentUnavailableView(
                        "Task unavailable",
                        systemImage: "exclamationmark.triangle",
                        description: Text("It may have been deleted on another device.")
                    )
                }
            }
            .navigationTitle(task?.title ?? "Notes")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                // Edit leading and Done trailing, as on the app's other sheets.
                ToolbarItem(placement: .navigation) {
                    Button("Edit") { editing = true }
                        .disabled(task == nil)
                        .accessibilityIdentifier("task-note-viewer-edit")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .taskNoteSheetStyle()
        .sheet(isPresented: $editing) {
            if let task {
                TaskNoteEditorView(note: task.note) { note, subtasks in
                    model.updateTaskNote(taskID: taskID, note: note, appendingSubtasks: subtasks)
                }
            }
        }
    }

    private func content(_ task: TaskItem) -> some View {
        ScrollView {
            if task.note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text("No notes yet. Tap Edit to add some.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(20)
            } else {
                TaskNoteMarkdownView(note: task.note) { line in
                    guard let updated = TaskNoteMarkdown.togglingChecklistItem(in: task.note, line: line) else { return }
                    #if os(iOS)
                    TaskCompletionHaptics.subtaskToggled()
                    #endif
                    model.updateTaskNote(taskID: taskID, note: updated)
                }
                .padding(20)
            }
        }
        .safeAreaInset(edge: .bottom) {
            if TaskNoteMarkdown.hasChecklistItems(task.note) {
                TaskNoteConvertChecklistButton(note: task.note) {
                    let result = TaskNoteMarkdown.extractingChecklist(from: task.note)
                    model.updateTaskNote(taskID: taskID, note: result.note, appendingSubtasks: result.subtasks)
                }
                .padding(16)
                .background(.bar)
            }
        }
    }
}

struct TaskNoteConvertChecklistButton: View {
    let note: String
    let action: () -> Void

    var body: some View {
        let count = TaskNoteMarkdown.blocks(note).filter {
            if case .checklistItem = $0 { return true }
            return false
        }.count
        Button(action: action) {
            Label(
                count == 1 ? "Convert Checklist Item to Subtask" : "Convert \(count) Checklist Items to Subtasks",
                systemImage: "checklist"
            )
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .accessibilityIdentifier("task-note-convert-checklist")
    }
}

// MARK: - Editor

/// The note editor: formatted text with a formatting bar, as in Apple Notes. Formatting is
/// attributes on the text (TaskNoteRichText), so typing and deleting can't break it; the note is
/// Markdown again only when saved. `onSave` receives the note and any subtasks converted from
/// its checklist; Cancel discards both.
struct TaskNoteEditorView: View {
    @Environment(\.dismiss) private var dismiss
    let onSave: (String, [TaskSubtask]) -> Void
    private let originalNote: String
    @State private var markdown: String
    @State private var convertedSubtasks: [TaskSubtask] = []
    @State private var controller = TaskNoteRichEditorController()
    @State private var linkPromptVisible = false
    @State private var linkURL = "https://"

    init(note: String, onSave: @escaping (String, [TaskSubtask]) -> Void) {
        self.onSave = onSave
        originalNote = note
        _markdown = State(initialValue: note)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                formatBar
                Divider()
                TaskNoteRichTextEditor(initialMarkdown: originalNote, controller: controller) { markdown = $0 }
                    .overlay(alignment: .topLeading) {
                        if markdown.isEmpty {
                            Text("Write your note")
                                .foregroundStyle(.tertiary)
                                .padding(.top, 14)
                                .padding(.leading, 17)
                                .allowsHitTesting(false)
                        }
                    }
                if TaskNoteMarkdown.hasChecklistItems(markdown) || !convertedSubtasks.isEmpty {
                    conversionFooter
                }
            }
            .navigationTitle("Notes")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        onSave(savedMarkdown, convertedSubtasks)
                        dismiss()
                    }
                    .accessibilityIdentifier("task-note-editor-done")
                }
            }
            .alert("Add Link", isPresented: $linkPromptVisible) {
                TextField("https://", text: $linkURL)
                    #if os(iOS)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    #endif
                    .autocorrectionDisabled()
                Button("Cancel", role: .cancel) {}
                Button("Add") { controller.applyLink(linkURL) }
            } message: {
                Text("Selected text becomes the link. With nothing selected, the address is added.")
            }
        }
        .taskNoteSheetStyle()
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 480)
        #endif
    }

    /// An untouched note keeps its exact text, so saving never rewrites Markdown it didn't
    /// change (another client's spacing or list markers, say).
    private var savedMarkdown: String {
        let canonicalOriginal = TaskNoteDocument.markdown(from: TaskNoteDocument.lines(fromMarkdown: originalNote))
        return markdown == canonicalOriginal ? originalNote : markdown
    }

    private var formatBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(TaskNoteFormat.allCases, id: \.self) { format in
                    Button {
                        if format == .link {
                            linkURL = "https://"
                            linkPromptVisible = true
                        } else {
                            controller.apply(format)
                        }
                    } label: {
                        Image(systemName: format.symbolName)
                            .font(.system(size: 16, weight: .medium))
                            .frame(width: 38, height: 34)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(format.accessibilityLabel)
                    .help(format.accessibilityLabel)
                }
            }
            .padding(.horizontal, 10)
        }
        .padding(.vertical, 4)
    }

    private var conversionFooter: some View {
        VStack(spacing: 8) {
            if TaskNoteMarkdown.hasChecklistItems(markdown) {
                TaskNoteConvertChecklistButton(note: markdown) {
                    let result = TaskNoteMarkdown.extractingChecklist(from: markdown)
                    convertedSubtasks += result.subtasks
                    controller.replaceAll(withMarkdown: result.note)
                }
            }
            if !convertedSubtasks.isEmpty {
                Text(convertedSubtasks.count == 1
                    ? "1 item will be added to subtasks when you tap Done."
                    : "\(convertedSubtasks.count) items will be added to subtasks when you tap Done.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }
}

private extension TaskNoteFormat {
    var symbolName: String {
        switch self {
        case .bold: "bold"
        case .italic: "italic"
        case .strikethrough: "strikethrough"
        case .code: "chevron.left.forwardslash.chevron.right"
        case .link: "link"
        case .heading: "textformat.size"
        case .bulletList: "list.bullet"
        case .numberedList: "list.number"
        case .checklist: "checklist"
        case .quote: "text.quote"
        }
    }

    var accessibilityLabel: String {
        switch self {
        case .bold: "Bold"
        case .italic: "Italic"
        case .strikethrough: "Strikethrough"
        case .code: "Code"
        case .link: "Link"
        case .heading: "Heading"
        case .bulletList: "Bulleted List"
        case .numberedList: "Numbered List"
        case .checklist: "Checklist"
        case .quote: "Quote"
        }
    }

    var mark: TaskNoteRun.Marks? {
        switch self {
        case .bold: .bold
        case .italic: .italic
        case .strikethrough: .strikethrough
        case .code: .code
        default: nil
        }
    }
}

private extension View {
    @ViewBuilder
    func taskNoteTextSelection(_ enabled: Bool) -> some View {
        if enabled {
            textSelection(.enabled)
        } else {
            textSelection(.disabled)
        }
    }

    @ViewBuilder
    func taskNoteSheetStyle() -> some View {
        #if os(iOS)
        self
            .preferredColorScheme(.dark)
            .tint(TaskifyTheme.accent)
        #else
        self
        #endif
    }
}

// MARK: - Rich text editing

#if os(iOS)
typealias TaskNotePlatformTextView = UITextView
#else
typealias TaskNotePlatformTextView = NSTextView
#endif

/// The editor's behaviour, shared by the iOS and Mac text views. Character changes go through
/// the text view's own input path (so undo stays coherent); formatting changes are attribute
/// edits on its storage, followed by `TaskNoteRichText.normalize`.
@MainActor
final class TaskNoteRichEditorController {
    weak var textView: TaskNotePlatformTextView?
    var onChange: ((String) -> Void)?
    /// Formatting toggled with nothing selected, applied to what's typed next.
    private var pendingMarks: TaskNoteRun.Marks?
    private(set) var isApplying = false
    let theme = TaskNoteRichTextTheme.current

    private var storage: NSTextStorage? { textView?.textStorage }

    /// Text being composed (an input method's marked text) must not be restyled underneath it.
    private var isComposing: Bool {
        #if os(iOS)
        textView?.markedTextRange != nil
        #else
        textView?.hasMarkedText() ?? false
        #endif
    }

    private var selection: NSRange {
        get {
            #if os(iOS)
            textView?.selectedRange ?? NSRange(location: 0, length: 0)
            #else
            textView?.selectedRange() ?? NSRange(location: 0, length: 0)
            #endif
        }
        set {
            #if os(iOS)
            textView?.selectedRange = newValue
            #else
            textView?.setSelectedRange(newValue)
            #endif
        }
    }

    private var layoutWidth: CGFloat {
        #if os(iOS)
        guard let textView else { return 320 }
        return textView.bounds.width - textView.textContainerInset.left - textView.textContainerInset.right
            - (textView.textContainer.lineFragmentPadding * 2)
        #else
        return (textView?.textContainer?.size.width ?? 480) - 10
        #endif
    }

    // MARK: Loading and publishing

    func load(markdown: String) {
        guard let storage else { return }
        let content = TaskNoteRichText.attributedString(fromMarkdown: markdown, theme: theme, width: layoutWidth)
        isApplying = true
        storage.setAttributedString(content)
        isApplying = false
        selection = NSRange(location: storage.length, length: 0)
        updateTypingAttributes()
    }

    /// Replaces everything (checklist conversion), as one undoable change.
    func replaceAll(withMarkdown markdown: String) {
        guard let storage else { return }
        let fragment = TaskNoteRichText.attributedString(fromMarkdown: markdown, theme: theme, width: layoutWidth)
        replaceCharacters(NSRange(location: 0, length: storage.length), with: fragment.string)
        copyModelAttributes(from: fragment, to: 0)
        textChanged()
        selection = NSRange(location: storage.length, length: 0)
    }

    func textChanged() {
        guard let storage, !isComposing else { return }
        let stray = TaskNoteRichText.normalize(storage, theme: theme, width: layoutWidth, removeStrayMarkers: false)
        if !stray.isEmpty {
            for range in stray.reversed() { replaceCharacters(range, with: "") }
            TaskNoteRichText.normalize(storage, theme: theme, width: layoutWidth, removeStrayMarkers: false)
        }
        onChange?(TaskNoteRichText.markdown(from: storage))
    }

    // MARK: Selection and typing

    func selectionChanged() {
        guard let storage, !isApplying else { return }
        let current = selection
        let string = storage.string as NSString
        if current.length == 0 {
            // The caret never sits before a line's marker; typing there would push it mid-line.
            let line = TaskNoteRichText.lineRange(in: string, containing: current.location)
            if current.location == line.location, TaskNoteRichText.hasMarker(storage, lineRange: line) {
                selection = NSRange(location: line.location + 1, length: 0)
            }
        }
        pendingMarks = nil
        updateTypingAttributes()
    }

    private func updateTypingAttributes() {
        guard let storage, let textView else { return }
        let caret = selection.location
        let string = storage.string as NSString
        let line = TaskNoteRichText.lineRange(in: string, containing: caret)
        var style = TaskNoteRichText.lineStyle(in: storage, lineRange: line)
        if line.length == 0, line.location == storage.length, line.location > 0 {
            // The empty last line has no characters to hold a style; the newline before it does.
            let previous = TaskNoteRichText.lineRange(in: string, containing: line.location - 1)
            let previousStyle = TaskNoteRichText.lineStyle(in: storage, lineRange: previous)
            if case .heading = previousStyle.kind { style = .paragraph } else if !previousStyle.hasMarker { style = previousStyle }
        }
        let contentStart = TaskNoteRichText.contentStart(storage, lineRange: line)
        var marks = TaskNoteRun.Marks()
        if caret > contentStart, caret - 1 < storage.length {
            marks = TaskNoteRun.Marks(rawValue: (storage.attribute(.taskNoteMarks, at: caret - 1, effectiveRange: nil) as? Int) ?? 0)
        }
        if let pendingMarks { marks = pendingMarks }
        var attributes: [NSAttributedString.Key: Any] = [
            .taskNoteLine: style.token,
            .taskNoteMarks: marks.rawValue,
            .font: TaskNoteRichText.font(for: style, marks: marks, theme: theme),
            .foregroundColor: style.kind == .quote ? theme.secondary : theme.text,
        ]
        if caret < storage.length || caret > 0 {
            let probe = min(max(0, caret - 1), storage.length - 1)
            if probe >= 0, let paragraph = storage.attribute(.paragraphStyle, at: probe, effectiveRange: nil) {
                attributes[.paragraphStyle] = paragraph
            }
        }
        if marks.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
        if marks.contains(.code) || style.kind == .code { attributes[.backgroundColor] = theme.codeBackground }
        textView.typingAttributes = attributes
    }

    // MARK: Character edits through the input system

    func replaceCharacters(_ range: NSRange, with string: String) {
        guard let textView else { return }
        isApplying = true
        defer { isApplying = false }
        #if os(iOS)
        if let start = textView.position(from: textView.beginningOfDocument, offset: range.location),
           let end = textView.position(from: start, offset: range.length),
           let textRange = textView.textRange(from: start, to: end) {
            textView.replace(textRange, withText: string)
        }
        #else
        if textView.shouldChangeText(in: range, replacementString: string) {
            textView.textStorage?.replaceCharacters(in: range, with: string)
            textView.didChangeText()
        }
        #endif
    }

    private func copyModelAttributes(from fragment: NSAttributedString, to location: Int) {
        guard let storage else { return }
        fragment.enumerateAttributes(in: NSRange(location: 0, length: fragment.length)) { attributes, range, _ in
            let target = NSRange(location: location + range.location, length: range.length)
            guard NSMaxRange(target) <= storage.length else { return }
            for key: NSAttributedString.Key in [.taskNoteLine, .taskNoteMarker, .taskNoteMarks, .taskNoteLink] {
                if let value = attributes[key] {
                    storage.addAttribute(key, value: value, range: target)
                } else {
                    storage.removeAttribute(key, range: target)
                }
            }
        }
    }

    /// Restores model attributes over a range on undo, for formatting changes that touch no
    /// characters.
    private func registerAttributeUndo(_ range: NSRange) {
        guard let storage, let undoManager = textView?.undoManager, NSMaxRange(range) <= storage.length else { return }
        let before = storage.attributedSubstring(from: range)
        let location = range.location
        undoManager.registerUndo(withTarget: self) { controller in
            MainActor.assumeIsolated {
                guard let storage = controller.storage else { return }
                let current = NSRange(location: location, length: before.length)
                guard NSMaxRange(current) <= storage.length else { return }
                controller.registerAttributeUndo(current)
                controller.copyModelAttributes(from: before, to: location)
                controller.textChanged()
            }
        }
    }

    // MARK: Return and backspace

    /// Return in a list continues it, or ends it on an empty item; in a heading it starts plain
    /// text. False leaves an ordinary newline to the text view.
    func handleReturn() -> Bool {
        guard let storage else { return false }
        var range = selection
        if range.length > 0 {
            replaceCharacters(range, with: "")
            range.length = 0
        }
        let string = storage.string as NSString
        let line = TaskNoteRichText.lineRange(in: string, containing: range.location)
        let style = TaskNoteRichText.lineStyle(in: storage, lineRange: line)
        let contentStart = TaskNoteRichText.contentStart(storage, lineRange: line)
        let isEmpty = NSMaxRange(line) == contentStart
        switch style.kind {
        case .bullet, .numbered, .checklist, .quote, .code:
            if isEmpty {
                setStyle(.paragraph, forLineAt: line.location)
                return true
            }
            if style.kind == .code {
                return false
            }
            var next = style
            if case .checklist = style.kind { next.kind = .checklist(checked: false) }
            let caret = range.location
            let lineEnd = NSMaxRange(line)
            replaceCharacters(NSRange(location: caret, length: 0), with: "\n" + TaskNoteRichText.markerCharacter)
            storage.addAttribute(.taskNoteLine, value: style.token, range: NSRange(location: caret, length: 1))
            storage.addAttributes([.taskNoteLine: next.token, .taskNoteMarker: true, .taskNoteMarks: 0], range: NSRange(location: caret + 1, length: 1))
            storage.removeAttribute(.taskNoteLink, range: NSRange(location: caret + 1, length: 1))
            let movedLength = lineEnd - caret
            if movedLength > 0 {
                storage.addAttribute(.taskNoteLine, value: next.token, range: NSRange(location: caret + 2, length: movedLength))
            }
            textChanged()
            selection = NSRange(location: caret + 2, length: 0)
            updateTypingAttributes()
            return true
        case .heading:
            let caret = range.location
            let lineEnd = NSMaxRange(line)
            replaceCharacters(NSRange(location: caret, length: 0), with: "\n")
            let moved = NSRange(location: caret + 1, length: lineEnd - caret)
            if moved.length > 0 {
                storage.addAttribute(.taskNoteLine, value: TaskNoteLineStyle.paragraph.token, range: moved)
            }
            textChanged()
            selection = NSRange(location: caret + 1, length: 0)
            updateTypingAttributes()
            return true
        case .rule:
            replaceCharacters(NSRange(location: NSMaxRange(line), length: 0), with: "\n")
            textChanged()
            selection = NSRange(location: NSMaxRange(line) + 1, length: 0)
            updateTypingAttributes()
            return true
        case .paragraph:
            return false
        }
    }

    /// Backspace at the start of a list item, heading or code line removes that formatting
    /// first, as in Apple Notes. False leaves the deletion to the text view.
    func handleBackspace() -> Bool {
        guard let storage else { return false }
        let range = selection
        guard range.length == 0, range.location > 0 else { return false }
        let string = storage.string as NSString
        let line = TaskNoteRichText.lineRange(in: string, containing: range.location)
        let style = TaskNoteRichText.lineStyle(in: storage, lineRange: line)
        let contentStart = TaskNoteRichText.contentStart(storage, lineRange: line)
        guard range.location == contentStart, style.kind != .paragraph else { return false }
        setStyle(.paragraph, forLineAt: line.location)
        return true
    }

    // MARK: Formatting

    func apply(_ format: TaskNoteFormat) {
        if let mark = format.mark {
            toggle(mark)
            return
        }
        guard let storage else { return }
        let string = storage.string as NSString
        let lines = TaskNoteRichText.lineRanges(in: string).filter { line in
            let range = selection
            let lineEnd = NSMaxRange(line)
            if range.length == 0 { return range.location >= line.location && range.location <= lineEnd }
            return line.location < NSMaxRange(range) && lineEnd >= range.location
                && !(lineEnd == range.location && line.length > 0)
        }
        guard !lines.isEmpty else { return }
        let styles = lines.map { TaskNoteRichText.lineStyle(in: storage, lineRange: $0) }
        let target: TaskNoteLineStyle
        switch format {
        case .heading:
            let next: TaskNoteLineStyle
            if case .heading(let level) = styles[0].kind {
                next = level >= 3 ? .paragraph : TaskNoteLineStyle(kind: .heading(level + 1), depth: 0)
            } else {
                next = TaskNoteLineStyle(kind: .heading(1), depth: 0)
            }
            target = next
        case .bulletList: target = TaskNoteLineStyle(kind: .bullet, depth: 0)
        case .numberedList: target = TaskNoteLineStyle(kind: .numbered(1), depth: 0)
        case .checklist: target = TaskNoteLineStyle(kind: .checklist(checked: false), depth: 0)
        case .quote: target = TaskNoteLineStyle(kind: .quote, depth: 0)
        default: return
        }
        let removing = format != .heading && styles.allSatisfy { $0.sameFamily(as: target) }
        textView?.undoManager?.beginUndoGrouping()
        for (index, line) in lines.enumerated().reversed() {
            var style = removing ? TaskNoteLineStyle.paragraph : target
            switch style.kind {
            case .bullet, .numbered, .checklist: style.depth = styles[index].depth
            default: break
            }
            setStyle(style, forLineAt: line.location, publish: false)
        }
        textView?.undoManager?.endUndoGrouping()
        textChanged()
        if let storage = self.storage, NSMaxRange(selection) > storage.length {
            selection = NSRange(location: storage.length, length: 0)
        }
    }

    private func toggle(_ mark: TaskNoteRun.Marks) {
        guard let storage else { return }
        let range = selection
        if range.length == 0 {
            let caret = range.location
            var current = TaskNoteRun.Marks()
            if caret > 0, caret - 1 < storage.length {
                current = TaskNoteRun.Marks(rawValue: (storage.attribute(.taskNoteMarks, at: caret - 1, effectiveRange: nil) as? Int) ?? 0)
            }
            var marks = pendingMarks ?? current
            if marks.contains(mark) { marks.remove(mark) } else { marks.insert(mark) }
            pendingMarks = marks
            updateTypingAttributes()
            pendingMarks = marks
            return
        }
        var allMarked = true
        storage.enumerateAttributes(in: range) { attributes, _, stop in
            guard attributes[.taskNoteMarker] == nil else { return }
            let marks = TaskNoteRun.Marks(rawValue: (attributes[.taskNoteMarks] as? Int) ?? 0)
            if !marks.contains(mark) { allMarked = false; stop.pointee = true }
        }
        registerAttributeUndo(range)
        storage.enumerateAttributes(in: range) { attributes, subrange, _ in
            guard attributes[.taskNoteMarker] == nil else { return }
            var marks = TaskNoteRun.Marks(rawValue: (attributes[.taskNoteMarks] as? Int) ?? 0)
            if allMarked { marks.remove(mark) } else { marks.insert(mark) }
            storage.addAttribute(.taskNoteMarks, value: marks.rawValue, range: subrange)
        }
        textChanged()
        selection = range
    }

    func applyLink(_ rawURL: String) {
        guard let storage else { return }
        let url = rawURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !url.isEmpty, url != "https://" else { return }
        var range = selection
        if range.length == 0 {
            replaceCharacters(range, with: url)
            range = NSRange(location: range.location, length: (url as NSString).length)
        } else {
            registerAttributeUndo(range)
        }
        storage.enumerateAttributes(in: range) { attributes, subrange, _ in
            guard attributes[.taskNoteMarker] == nil else { return }
            storage.addAttribute(.taskNoteLink, value: url, range: subrange)
        }
        textChanged()
        selection = NSRange(location: NSMaxRange(range), length: 0)
    }

    /// Sets one line's style: inserts or removes its marker through the text view and restyles.
    private func setStyle(_ style: TaskNoteLineStyle, forLineAt location: Int, publish: Bool = true) {
        guard let storage else { return }
        let string = storage.string as NSString
        var line = TaskNoteRichText.lineRange(in: string, containing: location)
        let hadMarker = TaskNoteRichText.hasMarker(storage, lineRange: line)
        let caret = selection
        var caretShift = 0
        if hadMarker, !style.hasMarker {
            replaceCharacters(NSRange(location: line.location, length: 1), with: "")
            line.length -= 1
            caretShift = -1
        } else if !hadMarker, style.hasMarker {
            replaceCharacters(NSRange(location: line.location, length: 0), with: TaskNoteRichText.markerCharacter)
            storage.addAttributes([.taskNoteMarker: true, .taskNoteMarks: 0], range: NSRange(location: line.location, length: 1))
            storage.removeAttribute(.taskNoteLink, range: NSRange(location: line.location, length: 1))
            line.length += 1
            caretShift = 1
        }
        let full = NSRange(location: line.location, length: min(line.length + 1, storage.length - line.location))
        if full.length > 0 {
            registerAttributeUndo(full)
            storage.addAttribute(.taskNoteLine, value: style.token, range: full)
        } else {
            // An empty last line keeps its style in the typing attributes.
            textView?.typingAttributes[.taskNoteLine] = style.token
        }
        if publish { textChanged() }
        if caret.location >= line.location {
            selection = NSRange(location: max(line.location + (style.hasMarker ? 1 : 0), caret.location + caretShift), length: caret.length)
        } else {
            selection = caret
        }
        updateTypingAttributes()
    }

    /// Ticks or unticks the checklist item whose marker is at `location`.
    func toggleChecklist(markerAt location: Int) {
        guard let storage else { return }
        let line = TaskNoteRichText.lineRange(in: storage.string as NSString, containing: location)
        let style = TaskNoteRichText.lineStyle(in: storage, lineRange: line)
        guard case .checklist(let checked) = style.kind else { return }
        let full = NSRange(location: line.location, length: min(line.length + 1, storage.length - line.location))
        registerAttributeUndo(full)
        storage.addAttribute(.taskNoteLine, value: TaskNoteLineStyle(kind: .checklist(checked: !checked), depth: style.depth).token, range: full)
        textChanged()
    }

    /// The checklist marker under a point, if the point is on one.
    func checklistMarker(near index: Int) -> Int? {
        guard let storage else { return nil }
        for candidate in [index, index - 1] where candidate >= 0 && candidate < storage.length {
            guard storage.attribute(.taskNoteMarker, at: candidate, effectiveRange: nil) != nil else { continue }
            let line = TaskNoteRichText.lineRange(in: storage.string as NSString, containing: candidate)
            if case .checklist = TaskNoteRichText.lineStyle(in: storage, lineRange: line).kind { return candidate }
        }
        return nil
    }

    // MARK: Clipboard

    func copySelection() -> String? {
        guard let storage, selection.length > 0 else { return nil }
        return TaskNoteRichText.markdown(of: storage, range: selection)
    }

    func paste(_ string: String) {
        guard storage != nil else { return }
        let fragment = TaskNoteRichText.pastedFragment(string, theme: theme, width: layoutWidth)
        let range = selection
        replaceCharacters(range, with: fragment.string)
        copyModelAttributes(from: fragment, to: range.location)
        textChanged()
        selection = NSRange(location: range.location + fragment.length, length: 0)
        updateTypingAttributes()
    }
}

#if os(iOS)
/// UITextView that copies Markdown, pastes Markdown as formatting, and ticks checkboxes on tap.
final class TaskNoteRichUITextView: UITextView {
    weak var controller: TaskNoteRichEditorController?

    override func copy(_ sender: Any?) {
        guard let markdown = controller?.copySelection() else { return super.copy(sender) }
        UIPasteboard.general.string = markdown
    }

    override func cut(_ sender: Any?) {
        guard let markdown = controller?.copySelection() else { return super.cut(sender) }
        UIPasteboard.general.string = markdown
        controller?.replaceCharacters(selectedRange, with: "")
        controller?.textChanged()
    }

    override func paste(_ sender: Any?) {
        guard let string = UIPasteboard.general.string else { return super.paste(sender) }
        controller?.paste(string)
    }

    @objc func handleTap(_ gesture: UITapGestureRecognizer) {
        guard gesture.state == .ended, let controller else { return }
        let point = gesture.location(in: self)
        guard let position = closestPosition(to: point) else { return }
        let index = offset(from: beginningOfDocument, to: position)
        guard let marker = controller.checklistMarker(near: index),
              let start = self.position(from: beginningOfDocument, offset: marker),
              let end = self.position(from: start, offset: 1),
              let range = textRange(from: start, to: end) else { return }
        guard firstRect(for: range).insetBy(dx: -12, dy: -8).contains(point) else { return }
        controller.toggleChecklist(markerAt: marker)
    }
}

struct TaskNoteRichTextEditor: UIViewRepresentable {
    let initialMarkdown: String
    let controller: TaskNoteRichEditorController
    let onChange: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(controller: controller) }

    func makeUIView(context: Context) -> TaskNoteRichUITextView {
        let view = TaskNoteRichUITextView()
        view.controller = controller
        view.backgroundColor = .clear
        view.allowsEditingTextAttributes = false
        view.textContainerInset = UIEdgeInsets(top: 14, left: 12, bottom: 14, right: 12)
        view.smartDashesType = .no
        view.smartQuotesType = .no
        view.alwaysBounceVertical = true
        view.keyboardDismissMode = .interactive
        view.accessibilityIdentifier = "task-note-editor-text"
        view.delegate = context.coordinator
        let tap = UITapGestureRecognizer(target: view, action: #selector(TaskNoteRichUITextView.handleTap(_:)))
        tap.cancelsTouchesInView = false
        tap.delegate = context.coordinator
        view.addGestureRecognizer(tap)
        controller.textView = view
        controller.onChange = onChange
        DispatchQueue.main.async {
            controller.load(markdown: initialMarkdown)
            view.becomeFirstResponder()
        }
        return view
    }

    func updateUIView(_ view: TaskNoteRichUITextView, context: Context) {
        controller.onChange = onChange
    }

    final class Coordinator: NSObject, UITextViewDelegate, UIGestureRecognizerDelegate {
        let controller: TaskNoteRichEditorController

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            true
        }

        init(controller: TaskNoteRichEditorController) {
            self.controller = controller
        }

        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            guard !controller.isApplying else { return true }
            if text == "\n" { return !controller.handleReturn() }
            if text.isEmpty, range.length == 1, textView.selectedRange.length == 0 {
                return !controller.handleBackspace()
            }
            return true
        }

        func textViewDidChange(_ textView: UITextView) {
            guard !controller.isApplying else { return }
            controller.textChanged()
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            controller.selectionChanged()
        }
    }
}
#else
/// NSTextView that copies Markdown, pastes Markdown as formatting, and ticks checkboxes on click.
final class TaskNoteRichNSTextView: NSTextView {
    weak var controller: TaskNoteRichEditorController?

    override func copy(_ sender: Any?) {
        guard let markdown = controller?.copySelection() else { return super.copy(sender) }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(markdown, forType: .string)
    }

    override func cut(_ sender: Any?) {
        guard let markdown = controller?.copySelection() else { return super.cut(sender) }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(markdown, forType: .string)
        controller?.replaceCharacters(selectedRange(), with: "")
        controller?.textChanged()
    }

    override func paste(_ sender: Any?) {
        guard let string = NSPasteboard.general.string(forType: .string) else { return super.paste(sender) }
        controller?.paste(string)
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let index = characterIndexForInsertion(at: point)
        if let controller, let marker = controller.checklistMarker(near: index) {
            let screenRect = firstRect(forCharacterRange: NSRange(location: marker, length: 1), actualRange: nil)
            if let window {
                let windowRect = window.convertFromScreen(screenRect)
                let rect = convert(windowRect, from: nil).insetBy(dx: -10, dy: -6)
                if rect.contains(point) {
                    controller.toggleChecklist(markerAt: marker)
                    return
                }
            }
        }
        super.mouseDown(with: event)
    }
}

struct TaskNoteRichTextEditor: NSViewRepresentable {
    let initialMarkdown: String
    let controller: TaskNoteRichEditorController
    let onChange: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(controller: controller) }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.drawsBackground = false
        let contentSize = scrollView.contentSize
        let textView = TaskNoteRichNSTextView(frame: NSRect(origin: .zero, size: contentSize))
        textView.minSize = NSSize(width: 0, height: contentSize.height)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isHorizontallyResizable = false
        textView.textContainer?.containerSize = NSSize(width: contentSize.width, height: CGFloat.greatestFiniteMagnitude)
        textView.controller = controller
        textView.isRichText = true
        textView.importsGraphics = false
        textView.allowsUndo = true
        textView.drawsBackground = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.textContainerInset = NSSize(width: 10, height: 12)
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.setAccessibilityIdentifier("task-note-editor-text")
        textView.delegate = context.coordinator
        scrollView.documentView = textView
        controller.textView = textView
        controller.onChange = onChange
        DispatchQueue.main.async {
            controller.load(markdown: initialMarkdown)
            textView.window?.makeFirstResponder(textView)
        }
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        controller.onChange = onChange
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        let controller: TaskNoteRichEditorController

        init(controller: TaskNoteRichEditorController) {
            self.controller = controller
        }

        func textDidChange(_ notification: Notification) {
            guard !controller.isApplying else { return }
            controller.textChanged()
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            controller.selectionChanged()
        }

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            guard !controller.isApplying else { return false }
            if selector == #selector(NSResponder.insertNewline(_:)) { return controller.handleReturn() }
            if selector == #selector(NSResponder.deleteBackward(_:)) { return controller.handleBackspace() }
            return false
        }
    }
}
#endif
