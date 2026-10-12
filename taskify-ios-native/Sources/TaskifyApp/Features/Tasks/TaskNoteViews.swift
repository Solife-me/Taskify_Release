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
    /// Off where the note is the label of a button, so a tap opens it rather than selecting.
    var selectable = true
    var onToggleChecklistItem: ((Int) -> Void)?

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
            TaskNoteInline.isSafeLink(url) ? .systemAction : .discarded
        })
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
                    .taskNoteTextSelection(selectable)
            }
            .padding(10)
            .background(Color.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
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
        Text(TaskNoteInline.attributed(markdown, codeSize: fontSize - 1.5))
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

enum TaskNoteInline {
    private static let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    /// Inline Markdown as styled text, with bare URLs linked and unsafe link schemes dropped.
    static func attributed(_ markdown: String, codeSize: CGFloat) -> AttributedString {
        var attributed = (try? AttributedString(
            markdown: markdown,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(markdown)

        for run in attributed.runs {
            if run.inlinePresentationIntent?.contains(.code) == true {
                attributed[run.range].font = .system(size: codeSize, design: .monospaced)
                attributed[run.range].backgroundColor = Color.primary.opacity(0.1)
            }
            if let link = run.link, !isSafeLink(link) {
                attributed[run.range].link = nil
            }
        }

        let plain = String(attributed.characters)
        if let detector, plain.contains(":") || plain.contains("www.") {
            let matches = detector.matches(in: plain, range: NSRange(plain.startIndex..., in: plain))
            for match in matches {
                guard let url = match.url, isSafeLink(url),
                      let range = Range(match.range, in: attributed),
                      attributed[range].runs.allSatisfy({ $0.link == nil }) else { continue }
                attributed[range].link = url
            }
        }
        return attributed
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

/// A Markdown editor for a task note: a formatting bar, Write and Preview modes, list
/// continuation on Return, and checklist-to-subtask conversion. `onSave` receives the note and
/// any subtasks converted from its checklist; Cancel discards both.
struct TaskNoteEditorView: View {
    private enum Mode: Hashable { case write, preview }

    @Environment(\.dismiss) private var dismiss
    let onSave: (String, [TaskSubtask]) -> Void
    @State private var text: String
    @State private var selection: NSRange
    @State private var mode = Mode.write
    @State private var convertedSubtasks: [TaskSubtask] = []
    @State private var controller = TaskNoteTextController()

    init(note: String, onSave: @escaping (String, [TaskSubtask]) -> Void) {
        self.onSave = onSave
        _text = State(initialValue: note)
        _selection = State(initialValue: NSRange(location: (note as NSString).length, length: 0))
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Mode", selection: $mode) {
                    Text("Write").tag(Mode.write)
                    Text("Preview").tag(Mode.preview)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .padding(.horizontal, 16)
                .padding(.vertical, 10)

                if mode == .write {
                    formatBar
                    Divider()
                    TaskNoteTextView(text: $text, selection: $selection, controller: controller)
                } else {
                    preview
                }

                if TaskNoteMarkdown.hasChecklistItems(text) || !convertedSubtasks.isEmpty {
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
                        onSave(text, convertedSubtasks)
                        dismiss()
                    }
                    .accessibilityIdentifier("task-note-editor-done")
                }
            }
        }
        .taskNoteSheetStyle()
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 480)
        #endif
    }

    private var formatBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(TaskNoteFormat.allCases, id: \.self) { format in
                    Button {
                        controller.apply(format)
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
        .padding(.bottom, 4)
    }

    @ViewBuilder
    private var preview: some View {
        ScrollView {
            if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text("Nothing to preview yet.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(20)
            } else {
                TaskNoteMarkdownView(note: text) { line in
                    if let updated = TaskNoteMarkdown.togglingChecklistItem(in: text, line: line) {
                        text = updated
                    }
                }
                .padding(20)
            }
        }
        .frame(maxHeight: .infinity)
    }

    private var conversionFooter: some View {
        VStack(spacing: 8) {
            if TaskNoteMarkdown.hasChecklistItems(text) {
                TaskNoteConvertChecklistButton(note: text) {
                    let result = TaskNoteMarkdown.extractingChecklist(from: text)
                    convertedSubtasks += result.subtasks
                    text = result.note
                    selection = NSRange(location: (result.note as NSString).length, length: 0)
                    controller.replaceText(result.note)
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

// MARK: - Text view

/// Lets the formatting bar edit the platform text view directly, so its selection is current and
/// each command lands on the undo stack.
@MainActor
final class TaskNoteTextController {
    #if os(iOS)
    weak var textView: UITextView?
    #else
    weak var textView: NSTextView?
    #endif
    var onEdit: ((String, NSRange) -> Void)?
    /// True while `apply` is inserting text, so the Return handler leaves that insertion alone.
    private(set) var isApplyingEdit = false

    func apply(_ format: TaskNoteFormat) {
        guard let textView else { return }
        let edit = TaskNoteMarkdown.applying(format, to: currentText, selection: textView.selectedRange)
        apply(edit)
    }

    func replaceText(_ text: String) {
        guard textView != nil else { return }
        apply(TaskNoteEdit(text: text, selection: NSRange(location: (text as NSString).length, length: 0)))
    }

    /// Applies an edit as one replacement of the changed span, which keeps undo granular.
    func apply(_ edit: TaskNoteEdit) {
        guard let textView, !isApplyingEdit else { return }
        isApplyingEdit = true
        defer { isApplyingEdit = false }
        let old = currentText as NSString
        let new = edit.text as NSString
        var prefix = 0
        let limit = min(old.length, new.length)
        while prefix < limit, old.character(at: prefix) == new.character(at: prefix) { prefix += 1 }
        if prefix > 0, prefix < old.length, UTF16.isTrailSurrogate(old.character(at: prefix)) { prefix -= 1 }
        var suffix = 0
        while suffix < old.length - prefix, suffix < new.length - prefix,
              old.character(at: old.length - 1 - suffix) == new.character(at: new.length - 1 - suffix) {
            suffix += 1
        }
        // Never split a surrogate pair between the kept text and the replacement.
        if suffix > 0, UTF16.isTrailSurrogate(old.character(at: old.length - suffix)) { suffix -= 1 }
        let range = NSRange(location: prefix, length: old.length - prefix - suffix)
        let replacement = new.substring(with: NSRange(location: prefix, length: new.length - prefix - suffix))

        #if os(iOS)
        // Through the keyboard's own input path, not `replace(_:withText:)`: an edit made while
        // keys are arriving (Return continuing a list) otherwise leaves the keyboard's view of
        // the text stale, which lost fast-typed text in testing.
        textView.selectedRange = range
        if !replacement.isEmpty {
            textView.insertText(replacement)
        } else if range.length > 0 {
            textView.deleteBackward()
        }
        textView.selectedRange = edit.selection
        textView.scrollRangeToVisible(edit.selection)
        #else
        if textView.shouldChangeText(in: range, replacementString: replacement) {
            textView.textStorage?.replaceCharacters(in: range, with: replacement)
            textView.didChangeText()
        }
        textView.setSelectedRange(edit.selection)
        textView.scrollRangeToVisible(edit.selection)
        #endif
        onEdit?(currentText, edit.selection)
    }

    nonisolated static func clamped(_ selection: NSRange, in text: String) -> NSRange {
        let length = (text as NSString).length
        let location = min(max(0, selection.location), length)
        return NSRange(location: location, length: min(max(0, selection.length), length - location))
    }

    private var currentText: String {
        #if os(iOS)
        textView?.text ?? ""
        #else
        textView?.string ?? ""
        #endif
    }
}

#if os(iOS)
struct TaskNoteTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var selection: NSRange
    let controller: TaskNoteTextController

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: 14, left: 12, bottom: 14, right: 12)
        // "--" turning into an em dash would break horizontal rules and list markers.
        view.smartDashesType = .no
        view.smartQuotesType = .no
        view.alwaysBounceVertical = true
        view.keyboardDismissMode = .interactive
        view.accessibilityIdentifier = "task-note-editor-text"
        view.text = text
        view.selectedRange = TaskNoteTextController.clamped(selection, in: text)
        view.delegate = context.coordinator
        controller.textView = view
        controller.onEdit = { [weak coordinator = context.coordinator] text, selection in
            coordinator?.publish(text: text, selection: selection)
        }
        DispatchQueue.main.async { view.becomeFirstResponder() }
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.parent = self
        if view.text != text {
            view.text = text
        }
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: TaskNoteTextView

        init(_ parent: TaskNoteTextView) {
            self.parent = parent
        }

        func publish(text: String, selection: NSRange) {
            if parent.text != text { parent.text = text }
            if parent.selection != selection { parent.selection = selection }
        }

        func textViewDidChange(_ textView: UITextView) {
            publish(text: textView.text, selection: textView.selectedRange)
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            if parent.selection != textView.selectedRange {
                let range = textView.selectedRange
                DispatchQueue.main.async { [weak self] in self?.parent.selection = range }
            }
        }

        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText: String) -> Bool {
            guard replacementText == "\n", !parent.controller.isApplyingEdit,
                  let edit = TaskNoteMarkdown.continuingList(in: textView.text, selection: range) else { return true }
            parent.controller.apply(edit)
            return false
        }
    }
}
#else
struct TaskNoteTextView: NSViewRepresentable {
    @Binding var text: String
    @Binding var selection: NSRange
    let controller: TaskNoteTextController

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSTextView.scrollableTextView()
        guard let textView = scrollView.documentView as? NSTextView else { return scrollView }
        textView.isRichText = false
        textView.allowsUndo = true
        textView.font = .systemFont(ofSize: NSFont.systemFontSize + 1)
        textView.textContainerInset = NSSize(width: 10, height: 12)
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.drawsBackground = false
        scrollView.drawsBackground = false
        textView.setAccessibilityIdentifier("task-note-editor-text")
        textView.string = text
        textView.setSelectedRange(TaskNoteTextController.clamped(selection, in: text))
        textView.delegate = context.coordinator
        controller.textView = textView
        controller.onEdit = { [weak coordinator = context.coordinator] text, selection in
            coordinator?.publish(text: text, selection: selection)
        }
        DispatchQueue.main.async { textView.window?.makeFirstResponder(textView) }
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let textView = scrollView.documentView as? NSTextView else { return }
        if textView.string != text {
            textView.string = text
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: TaskNoteTextView

        init(_ parent: TaskNoteTextView) {
            self.parent = parent
        }

        func publish(text: String, selection: NSRange) {
            if parent.text != text { parent.text = text }
            if parent.selection != selection { parent.selection = selection }
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            publish(text: textView.string, selection: textView.selectedRange())
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            let range = textView.selectedRange()
            if parent.selection != range {
                DispatchQueue.main.async { [weak self] in self?.parent.selection = range }
            }
        }

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            guard selector == #selector(NSResponder.insertNewline(_:)),
                  let edit = TaskNoteMarkdown.continuingList(in: textView.string, selection: textView.selectedRange())
            else { return false }
            parent.controller.apply(edit)
            return true
        }
    }
}
#endif
