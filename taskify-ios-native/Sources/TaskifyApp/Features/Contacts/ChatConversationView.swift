import CryptoKit
import ImageIO
import PhotosUI
import QuickLook
import SwiftUI
import TaskifyCore
import TaskifyWatchShared
import UIKit
import UniformTypeIdentifiers
import VisionKit

enum ChatTimelineItem: Identifiable, Equatable {
    case message(NostrDirectMessage)
    case sharedTask(SharedInboxItem)
    case sharedContact(SharedContactInboxItem)
    case calendarInvite(SharedCalendarInviteInboxItem)
    case sharedBoard(SharedBoardInboxItem)

    var id: String {
        switch self {
        case let .message(message): "message-\(message.id)"
        case let .sharedTask(item): "shared-task-\(item.id)"
        case let .sharedContact(item): "shared-contact-\(item.id)"
        case let .calendarInvite(item): "calendar-invite-\(item.id)"
        case let .sharedBoard(item): "shared-board-\(item.id)"
        }
    }

    var timestamp: Int {
        switch self {
        case let .message(message): message.createdAt
        case let .sharedTask(item): Int(item.receivedAt.timeIntervalSince1970)
        case let .sharedContact(item): Int(item.receivedAt.timeIntervalSince1970)
        case let .calendarInvite(item): Int(item.receivedAt.timeIntervalSince1970)
        case let .sharedBoard(item): Int(item.receivedAt.timeIntervalSince1970)
        }
    }

    func matchesSearch(_ query: String, senderName: (String) -> String) -> Bool {
        switch self {
        case let .message(message):
            message.matchesSearch(query, senderName: senderName(message.senderPublicKey))
        case let .sharedTask(item):
            item.task.title.localizedCaseInsensitiveContains(query) ||
                item.task.note?.localizedCaseInsensitiveContains(query) == true ||
                item.sender.displayName.localizedCaseInsensitiveContains(query)
        case let .sharedContact(item):
            item.contact.primaryName.localizedCaseInsensitiveContains(query) ||
                item.contact.npub.localizedCaseInsensitiveContains(query) ||
                item.contact.nip05?.localizedCaseInsensitiveContains(query) == true
        case let .calendarInvite(item):
            item.event.displayTitle.localizedCaseInsensitiveContains(query) ||
                item.event.start?.localizedCaseInsensitiveContains(query) == true ||
                item.sender.displayName.localizedCaseInsensitiveContains(query)
        case let .sharedBoard(item):
            (item.board.boardName ?? "Shared board").localizedCaseInsensitiveContains(query) ||
                item.sender.displayName.localizedCaseInsensitiveContains(query)
        }
    }
}
struct ChatConversationPresentation {
    let timeline: [ChatTimelineItem]
    let lastSentItemID: String?
    let messageLookup: [String: NostrDirectMessage]
    let reactionLookup: [String: [NostrDirectMessageReaction]]
    let senderContacts: [String: NostrContact]
    let senderNames: [String: String]
    let structuredSenderName: String?
    /// Runs of a sender's consecutive photos, keyed by the newest photo's message ID, which
    /// draws the whole run as one stack.
    let photoStacks: [String: [NostrDirectMessage]]
    /// The earlier photos of each run; their rows stay in the timeline (so scrolling and search
    /// targets keep working) but draw nothing.
    let stackedMessageIDs: Set<String>

}

/// A conversation owns only its current snapshot projection and a bounded amount of parsed
/// syntax. Composer edits and upload progress must not sort the history or reparse visible
/// messages. Nothing is persisted; the owner clears this cache when leaving or backgrounding.
@MainActor
final class ChatConversationRenderCache: Equatable {
    private struct Key: Equatable {
        let revision: Int
        let identity: String
        let peer: String
    }

    private final class DocumentBox: NSObject {
        let value: NostrChatMarkdownDocument
        init(_ value: NostrChatMarkdownDocument) { self.value = value }
    }

    private final class InlineBox: NSObject {
        let value: AttributedString
        init(_ value: AttributedString) { self.value = value }
    }

    private var key: Key?
    private var currentPresentation: ChatConversationPresentation?
    private var searchQuery: String?
    private var currentSearchResults: [ChatTimelineItem] = []
    private let documents = NSCache<NSString, DocumentBox>()
    private let inlines = NSCache<NSString, InlineBox>()

    init() {
        documents.countLimit = 128
        documents.totalCostLimit = 1_024 * 1_024
        inlines.countLimit = 512
        inlines.totalCostLimit = 1_024 * 1_024
    }

    nonisolated static func == (lhs: ChatConversationRenderCache, rhs: ChatConversationRenderCache) -> Bool {
        lhs === rhs
    }

    func presentation(
        revision: Int,
        identity: String,
        peer: String,
        build: () -> ChatConversationPresentation
    ) -> ChatConversationPresentation {
        let nextKey = Key(revision: revision, identity: identity, peer: peer)
        if key == nextKey, let currentPresentation { return currentPresentation }
        if let key, key.identity != identity || key.peer != peer { clear() }
        let value = build()
        key = nextKey
        currentPresentation = value
        searchQuery = nil
        currentSearchResults = []
        return value
    }

    func searchResults(query: String, build: () -> [ChatTimelineItem]) -> [ChatTimelineItem] {
        if searchQuery == query { return currentSearchResults }
        let value = query.isEmpty ? [] : build()
        searchQuery = query
        currentSearchResults = value
        return value
    }

    func document(_ text: String) -> NostrChatMarkdownDocument {
        if let cached = documents.object(forKey: text as NSString) { return cached.value }
        let value = NostrChatMarkdown.document(text)
        let cost = text.utf8.count
        if cost <= 128 * 1_024 {
            documents.setObject(DocumentBox(value), forKey: text as NSString, cost: cost * 4)
        }
        return value
    }

    func inline(_ text: String) -> AttributedString {
        if let cached = inlines.object(forKey: text as NSString) { return cached.value }
        let value = NostrChatMarkdown.inlineAttributedString(text)
        let cost = text.utf8.count
        if cost <= 128 * 1_024 {
            inlines.setObject(InlineBox(value), forKey: text as NSString, cost: cost * 4)
        }
        return value
    }

    func clear() {
        key = nil
        currentPresentation = nil
        searchQuery = nil
        currentSearchResults = []
        documents.removeAllObjects()
        inlines.removeAllObjects()
    }
}

/// Owns the staged plaintext until the user removes it or the send is queued.
final class ChatAttachmentDraft: Identifiable {
    let id = UUID()
    let fileURL: URL
    let name: String
    let mimeType: String
    let size: Int
    var uploadedAttachment: NostrDirectMessageAttachment?

    init(fileURL: URL, name: String, mimeType: String, size: Int) {
        self.fileURL = fileURL; self.name = name; self.mimeType = mimeType; self.size = size
    }

    deinit { try? FileManager.default.removeItem(at: fileURL) }
}

final class ChatPasteTextView: UITextView {
    var pasteAttachment: (([NSItemProvider]) -> Bool)?
    private var shouldFocusWhenAttached = false

    @discardableResult
    func requestFocus() -> Bool {
        shouldFocusWhenAttached = true
        guard window != nil, isEditable, isUserInteractionEnabled else { return false }
        return isFirstResponder || becomeFirstResponder()
    }

    func dismissFocus() {
        shouldFocusWhenAttached = false
        if isFirstResponder { resignFirstResponder() }
    }

    func markFocusEnded() {
        shouldFocusWhenAttached = false
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil, shouldFocusWhenAttached else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, self.window != nil, self.shouldFocusWhenAttached else { return }
            self.requestFocus()
        }
    }

    /// Command-Return with a hardware keyboard. The text view consumes Return key presses
    /// before SwiftUI shortcuts or menu commands see them, so the command lives here.
    var commandReturn: (() -> Void)?

    override var keyCommands: [UIKeyCommand]? {
        guard commandReturn != nil else { return super.keyCommands }
        let send = UIKeyCommand(
            title: "Send Message",
            action: #selector(performCommandReturn),
            input: "\r",
            modifierFlags: .command
        )
        send.wantsPriorityOverSystemBehavior = true
        return (super.keyCommands ?? []) + [send]
    }

    @objc private func performCommandReturn() {
        commandReturn?()
    }

    override func paste(itemProviders: [NSItemProvider]) {
        if pasteAttachment?(itemProviders) == true { return }
        super.paste(itemProviders: itemProviders)
    }

    override func paste(_ sender: Any?) {
        if pasteAttachment?(UIPasteboard.general.itemProviders) == true { return }
        super.paste(sender)
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(performCommandReturn) { return commandReturn != nil }
        // An image/file-only clipboard is attachable but not pasteable text, and UIKit
        // would otherwise hide the Paste item entirely. Keep it offered so the paste
        // override can stage the clipboard contents as an attachment. The has* family is
        // metadata-only, so building the menu never reads pasteboard contents (which
        // would trigger the system paste-permission prompt).
        if action == #selector(paste(_:)),
           UIPasteboard.general.hasImages || UIPasteboard.general.hasURLs {
            return true
        }
        return super.canPerformAction(action, withSender: sender)
    }
}

struct ChatComposerTextView: UIViewRepresentable {
    @Binding var text: String
    let isFocused: FocusState<Bool>.Binding
    let isEnabled: Bool
    let dismissKeyboard: Bool
    let accessibilityLabel: String
    let pasteAttachment: ([NSItemProvider]) -> Bool
    var onCommandReturn: (() -> Void)? = nil
    /// The tallest the editor may grow, from the room the conversation has left; beyond it the
    /// draft scrolls inside the editor. Without it a long draft plus staged attachments pushed
    /// the composer under the keyboard, hiding the caret.
    var maximumHeight: CGFloat? = nil
    /// Whether the editor holds the keyboard. `isFocused` only requests focus: with no
    /// `.focused` view bound to it, SwiftUI does not keep it true while editing.
    var onEditingChanged: ((Bool) -> Void)? = nil

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIView(context: Context) -> ChatPasteTextView {
        let view = ChatPasteTextView()
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.textColor = UIColor(TaskifyTheme.primaryText)
        view.tintColor = UIColor(TaskifyTheme.accent)
        view.textContainerInset = UIEdgeInsets(top: 10, left: 0, bottom: 10, right: 0)
        view.textContainer.lineFragmentPadding = 0
        // Scrolling stays enabled for the composer's whole life: toggling it as the text
        // grows resets contentOffset and corrupts contentSize/caret geometry, which left
        // the caret stranded below the fold. While the text fits the (externally sized)
        // frame nothing scrolls; once SwiftUI caps the height the same view pans and
        // tracks the caret natively.
        view.isScrollEnabled = true
        view.alwaysBounceVertical = false
        // Chat messages are multiline drafts. Return should insert a newline; the adjacent
        // send button is the explicit submit action.
        view.returnKeyType = .default
        // Draft scrolling belongs to the editor, including downward drags near
        // the keyboard. Only a drag that starts in the conversation dismisses it.
        view.keyboardDismissMode = .none
        view.pasteConfiguration = UIPasteConfiguration(
            acceptableTypeIdentifiers: [UTType.item.identifier]
        )
        view.accessibilityLabel = accessibilityLabel
        view.pasteAttachment = pasteAttachment
        view.commandReturn = onCommandReturn
        // No extra tap recognizer: UITextView focuses itself, and any recognizer added here
        // competes with its caret placement, double-tap and selection gestures.
        return view
    }

    func updateUIView(_ view: ChatPasteTextView, context: Context) {
        context.coordinator.parent = self
        if view.text != text { view.text = text }
        if view.isEditable != isEnabled { view.isEditable = isEnabled }
        if context.coordinator.lastMaximumHeight != maximumHeight {
            context.coordinator.lastMaximumHeight = maximumHeight
            view.invalidateIntrinsicContentSize()
            context.coordinator.scrollCaretIntoView(view)
        }
        view.accessibilityLabel = accessibilityLabel
        view.pasteAttachment = pasteAttachment
        view.commandReturn = onCommandReturn

        if dismissKeyboard {
            view.dismissFocus()
        } else if isFocused.wrappedValue {
            view.requestFocus()
        }
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: ChatPasteTextView,
        context: Context
    ) -> CGSize? {
        guard let width = proposal.width, width.isFinite else { return nil }
        let fitting = uiView.sizeThatFits(
            CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        )
        let lineHeight = uiView.font?.lineHeight ?? 20
        let insetHeight = uiView.textContainerInset.top + uiView.textContainerInset.bottom
        let minimumCap = lineHeight * 2 + insetHeight
        let maximumHeight = min(lineHeight * 15 + insetHeight, max(minimumCap, self.maximumHeight ?? .infinity))
        let height = min(max(fitting.height, 42), maximumHeight)
        return CGSize(width: width, height: height)
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ChatComposerTextView
        var lastMaximumHeight: CGFloat?

        init(parent: ChatComposerTextView) { self.parent = parent }


        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            textView.invalidateIntrinsicContentSize()
            scrollCaretIntoView(textView)
        }

        /// Once the draft exceeds the composer's height cap, keep the caret on screen as
        /// new lines are typed (mirrors the Messages composer). scrollRangeToVisible is a
        /// no-op while the caret is already visible, so a user scrolling back through the
        /// draft is only re-anchored on the next keystroke.
        func scrollCaretIntoView(_ textView: UITextView) {
            guard textView.isFirstResponder,
                  !textView.isTracking,
                  !textView.isDecelerating else { return }
            DispatchQueue.main.async { [weak textView] in
                guard let textView, textView.window != nil else { return }
                // The text may have changed again since this was scheduled; settle layout
                // so contentSize and the caret geometry are current before scrolling.
                textView.layoutIfNeeded()
                let range = textView.selectedRange
                guard range.location != NSNotFound else { return }
                // An empty range at end-of-document produces no rect under TextKit 2;
                // scroll to the last character instead so the caret comes into view.
                if range.length == 0, range.location > 0 {
                    textView.scrollRangeToVisible(
                        NSRange(location: range.location - 1, length: 1)
                    )
                } else {
                    textView.scrollRangeToVisible(range)
                }
                // Fallback: if the caret still isn't visible after that, scroll it in by
                // offset directly.
                if let end = textView.selectedTextRange?.end {
                    let caretRect = textView.caretRect(for: end)
                    if caretRect.height > 0, !textView.bounds.contains(caretRect) {
                        let target = max(
                            0,
                            caretRect.maxY - textView.bounds.height
                                + textView.textContainerInset.bottom
                        )
                        if target > textView.contentOffset.y {
                            textView.setContentOffset(
                                CGPoint(x: 0, y: target), animated: false
                            )
                        }
                    }
                }
            }
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            parent.onEditingChanged?(true)
            guard !parent.isFocused.wrappedValue else { return }
            DispatchQueue.main.async { self.parent.isFocused.wrappedValue = true }
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            parent.onEditingChanged?(false)
            (textView as? ChatPasteTextView)?.markFocusEnded()
            guard parent.isFocused.wrappedValue else { return }
            DispatchQueue.main.async { self.parent.isFocused.wrappedValue = false }
        }

    }
}

struct DirectMessageConversationView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var renderCache = ChatConversationRenderCache()
    @FocusState private var composerFocused: Bool
    @FocusState private var searchFocused: Bool
    @State private var draft = ""
    @State private var isSending = false
    @State private var isSendingAttachment = false
    @State private var attachmentDrafts: [ChatAttachmentDraft] = []
    @State private var attachmentPreparationTask: Task<Void, Never>?
    @State private var attachmentSendTask: Task<Void, Never>?
    @State private var attachmentProgress: AttachmentTransferProgress?
    @State private var attachmentSendError: String?
    @State private var attachmentUploadFileIndex = 0
    @State private var attachmentUploadFileTotal = 0
    @State private var audioRecorder = ChatAudioRecorder(
        directory: { try AttachmentFiles.directory() },
        prepare: { try AttachmentFiles.protect($0) },
        onWillRecord: { DirectMessageAudioPlayback.shared.pauseForRecording() }
    )
    /// A finished recording waiting in the composer to be played back, sent or discarded.
    @State private var recordedAudio: ChatAudioRecorder.Recording?
    @State private var recordedAudioPlayer = ChatAudioDraftPlayer(
        onWillPlay: { DirectMessageAudioPlayback.shared.pauseForRecording() }
    )
    @GestureState private var isPressingRecordButton = false
    @State private var recordPressBegan = false
    @State private var holdRecordingTask: Task<Void, Never>?
    @State private var isHoldRecording = false
    @State private var holdRecordingReleased = false
    @State private var showsRecordHint = false
    @State private var isComposerEditing = false
    @State private var recordHintTask: Task<Void, Never>?
    /// The timeline's visible height and the editor's height, which together size the editor.
    @State private var timelineVisibleHeight: CGFloat = 0
    /// Where the visible timeline ends (the composer's top), in the scroll view's own space.
    @State private var timelineVisibleBottom: CGFloat = 0
    @State private var composerTextHeight: CGFloat = 0
    @State private var replyingTo: NostrDirectMessage?
    @State private var showingPhotoPicker = false
    @State private var photoSelections: [PhotosPickerItem] = []
    @State private var showingCamera = false
    @State private var showingDocumentScanner = false
    @State private var showingFileImporter = false
    @State private var showingContactSharePicker = false
    @State private var showingGroupDetails = false
    @State private var showingContactDetails = false
    @State private var isSearchingConversation = false
    @State private var searchQuery = ""
    @State private var selectedSearchResultID: String?
    @State private var searchSelectionTask: Task<Void, Never>?
    @State private var timelineScrollTask: Task<Void, Never>?
    @State private var timelineHistoryLoadTask: Task<Void, Never>?
    @State private var isScrolledAwayFromBottom = false
    @State private var followsLatestMessage = true
    /// The timeline is being dragged or is still decelerating from a fling.
    @State private var isTimelineMoving = false
    @State private var sentMessageScrollRequest = 0
    @State private var loadedTimelineItemCount = 100
    @State private var isLoadingEarlierTimelineItems = false
    @State private var hasInteractedWithTimeline = false
    @State private var protectsInitialScrollTarget = false
    @State private var isAddingContact = false
    @State private var confirmingConversationDeletion = false
    private var botCommands: [BotCommand] {
        model.botCommands(publicKey: peerPublicKey) ?? []
    }
    @State private var botCommandMenuHeight: CGFloat = 0
    let peerPublicKey: String
    let initialTimelineItemID: String?
    var onClose: (() -> Void)? = nil
    var conversationListVisibility: Binding<NavigationSplitViewVisibility>? = nil
    @State private var isAttachmentDropTargeted = false

    private func closeConversation() {
        if let onClose { onClose() } else { dismiss() }
    }

    private var contact: NostrContact? { model.nostrContact(publicKey: peerPublicKey) }
    private var group: NostrGroupConversation? { model.groupConversation(id: peerPublicKey) }
    private var isSelfConversation: Bool { peerPublicKey == model.identityPublicKey }
    private var messages: [NostrDirectMessage] { model.directMessages(with: peerPublicKey) }
    private var sharedTasks: [SharedInboxItem] {
        model.sharedInboxItems
            .filter {
                $0.status != .deleted &&
                    $0.conversationPublicKey.caseInsensitiveCompare(peerPublicKey) == .orderedSame
            }
            .sorted {
                if $0.receivedAt != $1.receivedAt { return $0.receivedAt < $1.receivedAt }
                return $0.id < $1.id
            }
    }
    private var sharedContacts: [SharedContactInboxItem] {
        model.sharedContactInboxItems
            .filter {
                $0.status != .deleted &&
                    $0.conversationPublicKey.caseInsensitiveCompare(peerPublicKey) == .orderedSame
            }
            .sorted {
                if $0.receivedAt != $1.receivedAt { return $0.receivedAt < $1.receivedAt }
                return $0.id < $1.id
            }
    }
    private var calendarInvites: [SharedCalendarInviteInboxItem] {
        model.sharedCalendarInviteItems
            .filter {
                $0.status != .deleted &&
                    $0.conversationPublicKey.caseInsensitiveCompare(peerPublicKey) == .orderedSame
            }
            .sorted {
                if $0.receivedAt != $1.receivedAt { return $0.receivedAt < $1.receivedAt }
                return $0.id < $1.id
            }
    }
    private var sharedBoards: [SharedBoardInboxItem] {
        model.sharedBoardInboxItems
            .filter {
                $0.status != .deleted &&
                    $0.sender.publicKey.caseInsensitiveCompare(peerPublicKey) == .orderedSame
            }
            .sorted {
                if $0.receivedAt != $1.receivedAt { return $0.receivedAt < $1.receivedAt }
                return $0.id < $1.id
            }
    }
    private var presentation: ChatConversationPresentation {
        renderCache.presentation(
            revision: model.conversationRevision,
            identity: model.identityPublicKey,
            peer: peerPublicKey,
            build: makePresentation
        )
    }

    private var timeline: [ChatTimelineItem] { presentation.timeline }
    private var structuredSenderName: String? { presentation.structuredSenderName }

    private func visibleTimeline(from completeTimeline: [ChatTimelineItem]) -> [ChatTimelineItem] {
        guard !isSearchingConversation else { return completeTimeline }
        var requestedCount = loadedTimelineItemCount
        if let initialTimelineItemID,
           let targetIndex = completeTimeline.firstIndex(where: { $0.id == initialTimelineItemID }) {
            requestedCount = max(requestedCount, completeTimeline.count - targetIndex)
        }
        return Array(completeTimeline.suffix(min(requestedCount, completeTimeline.count)))
    }

    private func makePresentation() -> ChatConversationPresentation {
        let buildStart = CACurrentMediaTime()
        defer { TaskifyPerfMonitor.shared.recordChatTimelineBuild(seconds: CACurrentMediaTime() - buildStart) }
        let sharedTasks = sharedTasks
        let sharedContacts = sharedContacts
        let calendarInvites = calendarInvites
        let sharedBoards = sharedBoards
        let structuredRumorIDs = Set(sharedTasks.map(\.rumorEventID) + calendarInvites.map(\.rumorEventID))
        let items =
            messages.filter { !structuredRumorIDs.contains($0.rumorEventID) }.map(ChatTimelineItem.message)
                + sharedTasks.map(ChatTimelineItem.sharedTask)
                + sharedContacts.map(ChatTimelineItem.sharedContact)
                + calendarInvites.map(ChatTimelineItem.calendarInvite)
                + sharedBoards.map(ChatTimelineItem.sharedBoard)

        // `created_at` has one-second precision. Keep the order established by the message store
        // for ties; an event-ID tiebreaker is effectively random and can flip a just-sent message
        // behind the response that followed it.
        let timeline = items.enumerated()
            .sorted {
                if $0.element.timestamp != $1.element.timestamp {
                    return $0.element.timestamp < $1.element.timestamp
                }
                return $0.offset < $1.offset
            }
            .map(\.element)
        var values: [(Date, String)] = sharedTasks.map { ($0.receivedAt, $0.sender.displayName) }
        values += sharedContacts.compactMap {
            $0.isIncoming ? ($0.receivedAt, $0.sender.displayName) : nil
        }
        values += calendarInvites.map { ($0.receivedAt, $0.sender.displayName) }
        values += sharedBoards.map { ($0.receivedAt, $0.sender.displayName) }

        let lastSentItemID = timeline.last { item in
            switch item {
            case let .message(message):
                !message.isIncoming && message.deliveryState == .sent
            case let .sharedContact(contact):
                !contact.isIncoming
            default:
                false
            }
        }?.id
        let currentMessages = timeline.compactMap { item -> NostrDirectMessage? in
            guard case let .message(message) = item else { return nil }
            return message
        }
        var messageLookup: [String: NostrDirectMessage] = [:]
        messageLookup.reserveCapacity(currentMessages.count * 2)
        for message in currentMessages {
            messageLookup[message.rumorEventID] = message
            messageLookup[message.wrapEventID] = message
        }
        let senderContacts = Dictionary(
            model.nostrContacts.map { ($0.publicKey, $0) },
            uniquingKeysWith: { _, newest in newest }
        )
        let senderNames = Dictionary(
            uniqueKeysWithValues: Set(currentMessages.map(\.senderPublicKey)).map {
                ($0, senderName(for: $0))
            }
        )
        let photoStacks = DirectMessagePhotoStacks.group(timeline.map { item in
            if case let .message(message) = item { return message }
            return nil
        })
        return ChatConversationPresentation(
            timeline: timeline,
            lastSentItemID: lastSentItemID,
            messageLookup: messageLookup,
            reactionLookup: model.directMessageReactionLookup(peerPublicKey: peerPublicKey),
            senderContacts: senderContacts,
            senderNames: senderNames,
            structuredSenderName: values.max { $0.0 < $1.0 }?.1,
            photoStacks: photoStacks.stacks,
            stackedMessageIDs: photoStacks.stackedMessageIDs
        )
    }
    private var isStranger: Bool {
        group == nil && contact == nil && peerPublicKey != model.identityPublicKey
    }
    private var isBlocked: Bool { model.isDirectMessagePeerBlocked(peerPublicKey) }
    private var hasLeftGroup: Bool { group != nil && model.hasLeftDirectMessageGroup(peerPublicKey) }
    private var conversationTitle: String {
        group?.displayName ?? contact?.displayName ?? (isSelfConversation ? "You" : nil)
            ?? structuredSenderName ?? "Message"
    }
    private var canShowContactDetails: Bool {
        group == nil && NostrPublicKey.parse(peerPublicKey) != nil
    }
    private var contactDetailFallbackName: String? {
        guard contact == nil else { return nil }
        return isSelfConversation ? "You" : structuredSenderName
    }
    private var searchResults: [ChatTimelineItem] {
        let currentTimeline = timeline
        return renderCache.searchResults(query: searchQuery) {
            currentTimeline.filter {
                $0.matchesSearch(searchQuery, senderName: senderName(for:))
            }
        }
    }
    private var selectedSearchResultIndex: Int? {
        guard let selectedSearchResultID else { return nil }
        return searchResults.firstIndex { $0.id == selectedSearchResultID }
    }

    var body: some View {
        let presentation = presentation
        let completeTimeline = presentation.timeline
        let currentTimeline = visibleTimeline(from: completeTimeline)
        let hasEarlierTimelineItems = !isSearchingConversation
            && currentTimeline.count < completeTimeline.count
        let currentSearchMatches = Set(searchResults.map(\.id))

        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    if currentTimeline.isEmpty {
                        VStack(spacing: 12) {
                            ChatPeerAvatar(
                                contact: contact,
                                publicKey: peerPublicKey,
                                size: 72,
                                group: group,
                                recentMessages: messages
                            )
                            Text(
                                group?.displayName ?? contact?.displayName
                                    ?? (isSelfConversation ? "Message Yourself" : nil)
                                    ?? structuredSenderName ?? "New conversation"
                            )
                                .font(.headline)
                            Text(
                                isSelfConversation
                                    ? "Keep private notes synced through your encrypted Nostr inbox."
                                    : "Messages are end-to-end encrypted with your Nostr identity."
                            )
                                .font(.caption)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                                .multilineTextAlignment(.center)
                        }
                        .padding(.horizontal, 30)
                        .padding(.top, 70)
                    } else {
                        if hasEarlierTimelineItems {
                            earlierTimelineLoader(
                                completeTimeline: completeTimeline,
                                currentTimeline: currentTimeline,
                                proxy: proxy
                            )
                        }
                        ForEach(Array(currentTimeline.enumerated()), id: \.element.id) { index, item in
                            timelineRow(index: index, item: item, currentTimeline: currentTimeline,
                                presentation: presentation, currentSearchMatches: currentSearchMatches)
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .onGeometryChange(for: CGFloat.self) { geometry in
                    let space = NamedCoordinateSpace.named("conversationViewport")
                    guard let viewport = geometry.bounds(of: space) else { return 0 }
                    return geometry.size.height - viewport.maxY
                } action: { distanceFromBottom in
                    // Older systems do not expose the scroll view's own geometry.
                    if #available(iOS 18.0, *) { return }
                    let isAwayFromBottom = distanceFromBottom > 80
                    if isScrolledAwayFromBottom != isAwayFromBottom {
                        isScrolledAwayFromBottom = isAwayFromBottom
                    }
                }
            }
            .coordinateSpace(name: "conversationViewport")
            .onGeometryChange(for: CGFloat.self) { geometry in
                geometry.size.height - geometry.safeAreaInsets.bottom
            } action: { bottom in
                timelineVisibleBottom = bottom
            }
            .onGeometryChange(for: CGFloat.self) { geometry in
                geometry.size.height - geometry.safeAreaInsets.top - geometry.safeAreaInsets.bottom
            } action: { height in
                timelineVisibleHeight = height
            }
            // Scope interactive dismissal to the timeline, outside the composer.
            .scrollDismissesKeyboard(.interactively)
            // The scroll view runs on under the composer (a bottom safe-area inset), so its tap
            // gesture also saw taps in the message field. As an exclusive gesture it won over
            // the text view's own tap recognizers (no caret placement, no double-tap word
            // selection) and then dismissed the keyboard mid-edit. It is simultaneous, so it
            // never competes with them, and only taps on the visible timeline dismiss.
            .simultaneousGesture(
                SpatialTapGesture(coordinateSpace: .local).onEnded { tap in
                    guard timelineVisibleBottom == 0 || tap.location.y < timelineVisibleBottom else { return }
                    dismissComposerKeyboard()
                }
            )
            .conversationScrollBehavior(
                followsLatest: $followsLatestMessage,
                isMoving: $isTimelineMoving,
                isAwayFromBottom: $isScrolledAwayFromBottom,
                allowsFollowing: !isSearchingConversation && !protectsInitialScrollTarget,
                canLoadEarlier: hasEarlierTimelineItems,
                onInteraction: {
                    hasInteractedWithTimeline = true
                    timelineScrollTask?.cancel()
                },
                onReachedTop: {
                    loadEarlierTimelineItems(
                        completeTimeline: completeTimeline,
                        currentTimeline: currentTimeline,
                        proxy: proxy
                    )
                }
            )
            .overlay(alignment: .bottom) {
                if isScrolledAwayFromBottom, !currentTimeline.isEmpty {
                    // A UIKit button: while the timeline is still gliding, the scroll view takes
                    // the first touch to stop the momentum, so a SwiftUI overlay button never saw
                    // the tap. A real view above the scroll view receives it directly.
                    ChatScrollToLatestButton {
                        markReadAndScroll(proxy: proxy, animated: !reduceMotion)
                    }
                    .frame(width: 40, height: 40)
                    .shadow(color: .black.opacity(0.2), radius: 6, y: 2)
                    .padding(.bottom, 8)
                }
            }
            .safeAreaInset(edge: .top, spacing: 6) {
                VStack(spacing: 7) {
                    if isStranger {
                        strangerSafetyBar
                            .padding(.horizontal, 12)
                    }
                    if isSearchingConversation {
                        conversationSearchBar(proxy: proxy)
                            .padding(.horizontal, 12)
                    }
                }
            }
            .onAppear {
                if let initialTimelineItemID {
                    selectedSearchResultID = initialTimelineItemID
                    protectsInitialScrollTarget = true
                    Task { @MainActor in
                        try? await Task.sleep(for: .seconds(1))
                        protectsInitialScrollTarget = false
                    }
                }
                // The bottom scroll anchor alone can leave the offset past the last row once
                // lazy rows replace their estimated heights (long or media-heavy threads opened
                // blank), so settle on the newest row explicitly on every system.
                markReadAndScroll(
                    proxy: proxy,
                    targetID: initialTimelineItemID,
                    animated: false
                )
            }
            // Track the stable newest ID so earlier-page loads do not look like arrivals.
            .onChange(of: currentTimeline.last?.id) { _, _ in
                if protectsInitialScrollTarget, let initialTimelineItemID {
                    markReadAndScroll(
                        proxy: proxy,
                        targetID: initialTimelineItemID,
                        animated: false
                    )
                    return
                }
                if isSearchingConversation, !searchQuery.isEmpty {
                    // Still inside the thread, so arrivals during in-thread search count as
                    // read too; the search overlay must not steal the scroll, but marking
                    // must not be skipped.
                    model.markDirectMessageThreadRead(peerPublicKey: peerPublicKey)
                    selectNewestSearchResult(proxy: proxy)
                } else {
                    model.markDirectMessageThreadRead(peerPublicKey: peerPublicKey)
                    let shouldSettleAtLatest: Bool
                    if #available(iOS 18.0, *) {
                        shouldSettleAtLatest = followsLatestMessage
                    } else {
                        shouldSettleAtLatest = !isScrolledAwayFromBottom
                    }
                    if shouldSettleAtLatest {
                        // LazyVStack can revise row heights after the size anchor runs. Settle
                        // the newest stable ID without an overlapping scroll animation.
                        markReadAndScroll(proxy: proxy, animated: false)
                    }
                }
            }
            .onChange(of: searchQuery) { _, _ in
                scheduleNewestSearchResult(proxy: proxy)
            }
            .onChange(of: timelineVisibleHeight) { oldHeight, newHeight in
                // The keyboard, a growing draft or staged attachments changed the room above the
                // composer; keep the newest message in view if that is where the reader is.
                guard abs(newHeight - oldHeight) > 1, oldHeight > 0,
                      followsLatestMessage, !isTimelineMoving, !isSearchingConversation,
                      let latestID = currentTimeline.last?.id else { return }
                proxy.scrollTo(latestID, anchor: .bottom)
            }
            .onChange(of: sentMessageScrollRequest) { _, _ in
                // Sending from history is explicit navigation. Wait until the send succeeds
                // and the draft clears; arrivals need no competing imperative animation.
                if !followsLatestMessage || isScrolledAwayFromBottom {
                    markReadAndScroll(proxy: proxy, animated: false)
                }
            }
            .onChange(of: completeTimeline.count) { oldCount, newCount in
                // Grow the window by each arrival instead of sliding it: dropping the oldest
                // rows while the newest are added moved the content under a reader at the
                // bottom, and the lazy stack could settle past its last row, leaving the
                // thread blank until it was scrolled.
                guard newCount > oldCount else { return }
                loadedTimelineItemCount = min(
                    newCount,
                    loadedTimelineItemCount + (newCount - oldCount)
                )
            }
        }
        .background(TaskifyAppBackground())
        .onDrop(of: [.item], isTargeted: $isAttachmentDropTargeted) { providers in
            guard !hasLeftGroup, !isBlocked else { return false }
            return stageAttachmentProviders(providers, fromPasteboard: false)
        }
        .overlay {
            if isAttachmentDropTargeted, !hasLeftGroup, !isBlocked {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(TaskifyTheme.accent, lineWidth: 3)
                    .padding(6)
                    .allowsHitTesting(false)
            }
        }
        .task(id: "\(peerPublicKey):\(scenePhase == .active)") {
            // Keep cached commands visible while revalidating on chat open and foreground.
            // Read the observed model directly so concurrent refreshes also update the menu.
            guard scenePhase == .active, group == nil, !isSelfConversation else { return }
            await model.refreshBotCommands(publicKey: peerPublicKey, force: true)
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            conversationHeader
        }
        .safeAreaInset(edge: .bottom, spacing: 8) {
            Group {
                if hasLeftGroup {
                    restrictedConversationFooter(
                        title: "You left this group",
                        actionTitle: "Rejoin",
                        systemImage: "arrow.uturn.forward.circle"
                    ) {
                        model.setDirectMessageGroupLeft(peerPublicKey, left: false)
                        UINotificationFeedbackGenerator().notificationOccurred(.success)
                    }
                    .padding(.horizontal, 12)
                } else if isBlocked {
                    restrictedConversationFooter(
                        title: "This sender is blocked",
                        actionTitle: "Unblock",
                        systemImage: "hand.raised.slash"
                    ) {
                        model.setDirectMessagePeerBlocked(peerPublicKey, blocked: false)
                        UINotificationFeedbackGenerator().notificationOccurred(.success)
                    }
                    .padding(.horizontal, 12)
                } else {
                    composer
                }
            }
        }
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
        .toolbar(UIDevice.current.userInterfaceIdiom == .pad ? .visible : .hidden, for: .tabBar)
        .sheet(isPresented: $showingGroupDetails) {
            GroupConversationDetailsView(groupID: peerPublicKey)
                .environment(model)
        }
        .sheet(isPresented: $showingContactDetails) {
            NavigationStack {
                NostrContactDetailView(
                    contactPublicKey: peerPublicKey,
                    fallbackDisplayName: contactDetailFallbackName
                )
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { showingContactDetails = false }
                    }
                }
            }
            .environment(model)
            .preferredColorScheme(.dark)
            .tint(TaskifyTheme.accent)
        }
        .sheet(isPresented: $showingContactSharePicker) {
            ShareContactPickerSheet { contact in
                await shareContact(contact)
            }
            .environment(model)
        }
        .photosPicker(
            isPresented: $showingPhotoPicker,
            selection: $photoSelections,
            maxSelectionCount: NostrDirectMessageAttachment.maximumBatchCount,
            matching: .any(of: [.images, .videos]),
            preferredItemEncoding: .automatic
        )
        .onChange(of: photoSelections) { _, selections in
            guard !selections.isEmpty else { return }
            attachmentPreparationTask = Task { await stagePhotoSelections(selections) }
        }
        .fileImporter(
            isPresented: $showingFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            guard case .success(let URLs) = result, !URLs.isEmpty else {
                if case .failure(let error) = result { model.errorMessage = error.localizedDescription }
                return
            }
            attachmentPreparationTask = Task {
                for URL in URLs { await stageFile(URL) }
            }
        }
        .onDisappear {
            // Leaving the thread reads it through. The reactive onChange mark handles messages
            // seen arriving, but it can miss arrivals during in-thread search or a transient
            // SwiftUI update while the timeline is settling.
            // Anything that reached the snapshot while this view was open was displayed in it,
            // so the list must not badge the thread afterwards.
            model.markDirectMessageThreadRead(peerPublicKey: peerPublicKey)
            attachmentPreparationTask?.cancel()
            audioRecorder.cancel()
            discardRecordedAudio()
            timelineScrollTask?.cancel()
            timelineHistoryLoadTask?.cancel()
            renderCache.clear()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { renderCache.clear() }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)) { _ in
            renderCache.clear()
        }
        .onChange(of: model.identityPublicKey) { _, _ in
            renderCache.clear()
            attachmentPreparationTask?.cancel()
            audioRecorder.cancel()
            discardRecordedAudio()
            attachmentDrafts.removeAll()
            draft = ""
            replyingTo = nil
        }
        .task(id: peerPublicKey) {
            await model.prepareDirectMessageRecipient(peerPublicKey)
        }
        .confirmationDialog(
            "Delete this conversation?",
            isPresented: $confirmingConversationDeletion,
            titleVisibility: .visible
        ) {
            Button("Delete Conversation", role: .destructive) {
                model.deleteDirectMessageThread(peerPublicKey: peerPublicKey)
                closeConversation()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes the conversation from this device and suppresses immediate relay replays.")
        }
    }

    private var conversationHeader: some View {
        ZStack {
            Button {
                if group != nil {
                    showingGroupDetails = true
                } else if canShowContactDetails {
                    showingContactDetails = true
                }
            } label: {
                VStack(spacing: 2) {
                    ChatPeerAvatar(
                        contact: contact,
                        publicKey: peerPublicKey,
                        size: 42,
                        group: group,
                        recentMessages: messages
                    )
                    Text(conversationTitle)
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .lineLimit(1)
                    if let group {
                        Text("\(group.memberPublicKeys.count) members")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(TaskifyTheme.secondaryText)
                    }
                }
                .frame(maxWidth: 220)
            }
            .buttonStyle(.plain)
            .disabled(group == nil && !canShowContactDetails)
            .accessibilityLabel(group == nil ? "Open contact details" : "Open group details")

            HStack {
                if let conversationListVisibility {
                    // The list's own column carries the system toggle while it is showing; the
                    // thread only needs a way to bring it back once it has been hidden.
                    if conversationListVisibility.wrappedValue == .detailOnly {
                        HeaderIconButton(systemName: "sidebar.left", accessibilityLabel: "Show conversations") {
                            withAnimation { conversationListVisibility.wrappedValue = .all }
                        }
                    }
                } else {
                    HeaderIconButton(systemName: "chevron.left", accessibilityLabel: "Back to chats") {
                        closeConversation()
                    }
                }

                Spacer()

                Menu {
                    Button {
                        toggleConversationSearch()
                    } label: {
                        Label(
                            isSearchingConversation ? "Close Search" : "Search Conversation",
                            systemImage: "magnifyingglass"
                        )
                    }
                    if group != nil {
                        Button {
                            showingGroupDetails = true
                        } label: {
                            Label("Group Details", systemImage: "person.3")
                        }
                    } else if canShowContactDetails {
                        Button {
                            showingContactDetails = true
                        } label: {
                            Label("Contact Details", systemImage: "person.crop.circle")
                        }
                    }
                    Button {
                        model.archiveDirectMessageThread(peerPublicKey: peerPublicKey)
                        closeConversation()
                    } label: {
                        Label("Archive Conversation", systemImage: "archivebox")
                    }
                    Button(role: .destructive) {
                        confirmingConversationDeletion = true
                    } label: {
                        Label("Delete Conversation", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 16, weight: .bold))
                        .frame(width: 42, height: 42)
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .taskifyGlassControl(in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Conversation actions")
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 4)
        .padding(.bottom, 6)
        .background(.ultraThinMaterial)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.white.opacity(0.07))
                .frame(height: 0.5)
        }
    }

    private var strangerSafetyBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "person.crop.circle.badge.questionmark")
                .font(.headline)
                .foregroundStyle(.orange)

            VStack(alignment: .leading, spacing: 1) {
                Text("Unknown sender")
                    .font(.caption.bold())
                    .foregroundStyle(TaskifyTheme.primaryText)
                Text("Only reply if you recognize this account.")
                    .font(.caption2)
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }

            Spacer(minLength: 4)

            Button(isBlocked ? "Unblock" : "Block") {
                model.setDirectMessagePeerBlocked(peerPublicKey, blocked: !isBlocked)
                UINotificationFeedbackGenerator().notificationOccurred(isBlocked ? .success : .warning)
            }
            .font(.caption.bold())
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)

            Button {
                addStrangerToContacts()
            } label: {
                if isAddingContact {
                    ProgressView().controlSize(.small)
                } else {
                    Text("Add")
                }
            }
            .font(.caption.bold())
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .disabled(isAddingContact)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color.orange.opacity(0.24), lineWidth: 1)
        )
    }

    private func restrictedConversationFooter(
        title: String,
        actionTitle: String,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        HStack(spacing: 12) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TaskifyTheme.secondaryText)
            Spacer()
            Button(action: action) {
                Label(actionTitle, systemImage: systemImage)
                    .font(.subheadline.bold())
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
        }
        .padding(10)
        .taskifyGlassControl(in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }

    private func addStrangerToContacts() {
        guard !isAddingContact else { return }
        isAddingContact = true
        let relay = messages.flatMap { $0.relayURLs ?? [] }.first
        Task {
            do {
                _ = try await model.saveNostrContact(
                    publicKeyValue: peerPublicKey,
                    petname: nil,
                    relayURL: relay
                )
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } catch {
                model.errorMessage = error.localizedDescription
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
            isAddingContact = false
        }
    }

    /// One timeline item: its day divider and its bubble or card.
    @ViewBuilder
    private func timelineRow(
        index: Int,
        item: ChatTimelineItem,
        currentTimeline: [ChatTimelineItem],
        presentation: ChatConversationPresentation,
        currentSearchMatches: Set<String>
    ) -> some View {
        // One stable child per timeline item preserves lazy row creation.
        // A conditional divider beside the bubble makes the child count
        // depend on evaluating off-screen messages.
        VStack(spacing: 0) {
            if shouldShowDayDivider(at: index, in: currentTimeline) {
                ChatDayDivider(timestamp: item.timestamp)
            }

            switch item {
            case let .message(message) where presentation.stackedMessageIDs.contains(message.id):
                // Drawn by the photo stack its run's newest photo hosts.
                Color.clear.frame(height: 0)
            case let .message(message):
                let photoStack = presentation.photoStacks[message.id]
                // A stack's grouping follows the message before its first photo.
                let runStart = index - (photoStack?.count ?? 1) + 1
                let groupedWithPrevious = isMessageGrouped(at: runStart, with: runStart - 1, in: currentTimeline)
                let groupedWithNext = isMessageGrouped(at: index + 1, with: index, in: currentTimeline)
                let reactions = (photoStack ?? [message]).flatMap { member in
                    (presentation.reactionLookup[member.rumorEventID] ?? [])
                        + (member.wrapEventID == member.rumorEventID
                            ? []
                            : presentation.reactionLookup[member.wrapEventID] ?? [])
                }
                DirectMessageBubble(
                    renderCache: renderCache,
                    message: message,
                    repliedMessage: message.replyToEventID.flatMap {
                        presentation.messageLookup[$0]
                    },
                    reactions: reactions,
                    senderName: group != nil && message.isIncoming && !groupedWithPrevious
                        ? presentation.senderNames[message.senderPublicKey] : nil,
                    senderContact: group != nil && message.isIncoming
                        ? presentation.senderContacts[message.senderPublicKey] : nil,
                    showsSenderAvatar: group != nil && message.isIncoming,
                    isGroupedWithPrevious: groupedWithPrevious,
                    isGroupedWithNext: groupedWithNext,
                    showsSentStatus: item.id == presentation.lastSentItemID,
                    isSearchMatch: currentSearchMatches.contains(item.id),
                    isSelectedSearchResult: selectedSearchResultID == item.id,
                    photoStack: photoStack
                )
                .equatable()
                .contextMenu {
                    Label(
                        "Sent \(Date(timeIntervalSince1970: TimeInterval(message.createdAt)).formatted(date: .abbreviated, time: .shortened))",
                        systemImage: "clock"
                    )
                    Menu("React", systemImage: "face.smiling") {
                        ForEach(["❤️", "👍", "👎", "😂", "😮", "😢"], id: \.self) { emoji in
                            Button(emoji) { react(to: message, with: emoji) }
                        }
                    }
                    if reactions.contains(where: {
                        $0.senderPublicKey == model.identityPublicKey
                    }) {
                        Button("Remove Reaction", systemImage: "minus.circle") {
                            react(to: message, with: "-")
                        }
                    }
                    Button("Reply", systemImage: "arrowshape.turn.up.left") {
                        replyingTo = message
                        composerFocused = true
                    }
                    if message.attachment == nil {
                        Button("Copy", systemImage: "doc.on.doc") {
                            UIPasteboard.general.string = message.content
                        }
                    } else {
                        Section {
                            DirectMessageAttachmentMenuItems(
                                attachments: (photoStack ?? [message]).compactMap(\.attachment)
                            )
                        }
                    }
                }
            case let .sharedTask(sharedTask):
                SharedTaskChatCard(
                    item: sharedTask,
                    isSearchMatch: currentSearchMatches.contains(item.id),
                    isSelectedSearchResult: selectedSearchResultID == item.id
                )
            case let .sharedContact(sharedContact):
                SharedContactChatCard(
                    item: sharedContact,
                    showsSentStatus: item.id == presentation.lastSentItemID,
                    isSearchMatch: currentSearchMatches.contains(item.id),
                    isSelectedSearchResult: selectedSearchResultID == item.id
                )
            case let .calendarInvite(invite):
                SharedCalendarInviteChatCard(
                    item: invite,
                    isSearchMatch: currentSearchMatches.contains(item.id),
                    isSelectedSearchResult: selectedSearchResultID == item.id
                )
            case let .sharedBoard(sharedBoard):
                SharedBoardChatCard(
                    item: sharedBoard,
                    isSearchMatch: currentSearchMatches.contains(item.id),
                    isSelectedSearchResult: selectedSearchResultID == item.id
                )
            }
        }
        .id(item.id)
    }
    private func earlierTimelineLoader(
        completeTimeline: [ChatTimelineItem],
        currentTimeline: [ChatTimelineItem],
        proxy: ScrollViewProxy
    ) -> some View {
        ZStack {
            Color.clear
            if isLoadingEarlierTimelineItems {
                ProgressView()
                    .controlSize(.small)
                    .tint(TaskifyTheme.secondaryText)
                    .accessibilityLabel("Loading earlier messages")
            }
        }
        .frame(height: 24)
        .id("earlier-messages-\(currentTimeline.first?.id ?? "empty")")
        .onAppear {
            if #unavailable(iOS 18.0), hasInteractedWithTimeline {
                loadEarlierTimelineItems(
                    completeTimeline: completeTimeline,
                    currentTimeline: currentTimeline,
                    proxy: proxy
                )
            }
        }
    }

    private func loadEarlierTimelineItems(
        completeTimeline: [ChatTimelineItem],
        currentTimeline: [ChatTimelineItem],
        proxy: ScrollViewProxy
    ) {
        guard hasInteractedWithTimeline,
              !isSearchingConversation,
              !isLoadingEarlierTimelineItems,
              currentTimeline.count < completeTimeline.count,
              let previousOldestID = currentTimeline.first?.id else { return }

        isLoadingEarlierTimelineItems = true
        timelineHistoryLoadTask?.cancel()
        let nextCount = min(
            completeTimeline.count,
            max(loadedTimelineItemCount, currentTimeline.count) + 100
        )
        timelineHistoryLoadTask = Task { @MainActor in
            await Task.yield()
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                loadedTimelineItemCount = nextCount
            }
            await Task.yield()
            guard !Task.isCancelled else { return }
            proxy.scrollTo(previousOldestID, anchor: .top)
            isLoadingEarlierTimelineItems = false
            timelineHistoryLoadTask = nil
        }
    }

    private func conversationSearchBar(proxy: ScrollViewProxy) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(TaskifyTheme.secondaryText)

            TextField("Search conversation", text: $searchQuery)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($searchFocused)
                .submitLabel(.search)

            Text(searchResultPositionLabel)
                .font(.caption.monospacedDigit())
                .foregroundStyle(TaskifyTheme.secondaryText)
                .frame(minWidth: 34)

            Button {
                moveSearchResult(by: -1, proxy: proxy)
            } label: {
                Image(systemName: "chevron.up")
                    .frame(width: 28, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(searchResults.isEmpty)
            .accessibilityLabel("Previous search result")

            Button {
                moveSearchResult(by: 1, proxy: proxy)
            } label: {
                Image(systemName: "chevron.down")
                    .frame(width: 28, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(searchResults.isEmpty)
            .accessibilityLabel("Next search result")

            Button(action: closeConversationSearch) {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .bold))
                    .frame(width: 30, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close conversation search")
        }
        .font(.subheadline)
        .foregroundStyle(TaskifyTheme.primaryText)
        .padding(.horizontal, 13)
        .frame(height: 48)
        .taskifyGlassControl(in: Capsule())
    }

    private var searchResultPositionLabel: String {
        guard let index = selectedSearchResultIndex, !searchResults.isEmpty else { return "0/0" }
        return "\(index + 1)/\(searchResults.count)"
    }

    private func toggleConversationSearch() {
        if isSearchingConversation {
            closeConversationSearch()
        } else {
            composerFocused = false
            isSearchingConversation = true
            DispatchQueue.main.async { searchFocused = true }
        }
    }

    private func closeConversationSearch() {
        searchSelectionTask?.cancel()
        searchSelectionTask = nil
        if let selectedSearchResultID,
           let selectedIndex = timeline.firstIndex(where: { $0.id == selectedSearchResultID }) {
            loadedTimelineItemCount = max(
                loadedTimelineItemCount,
                timeline.count - selectedIndex
            )
        }
        isSearchingConversation = false
        followsLatestMessage = !isScrolledAwayFromBottom
        searchQuery = ""
        selectedSearchResultID = nil
        searchFocused = false
    }

    private func scheduleNewestSearchResult(proxy: ScrollViewProxy) {
        searchSelectionTask?.cancel()
        guard !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            selectedSearchResultID = nil
            return
        }
        searchSelectionTask = Task { @MainActor in
            do {
                try await Task.sleep(for: .milliseconds(120))
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            selectNewestSearchResult(proxy: proxy)
        }
    }

    private func selectNewestSearchResult(proxy: ScrollViewProxy) {
        guard !searchResults.isEmpty else {
            selectedSearchResultID = nil
            return
        }
        selectedSearchResultID = searchResults.last?.id
        scrollToSelectedSearchResult(proxy: proxy)
    }

    private func moveSearchResult(by offset: Int, proxy: ScrollViewProxy) {
        guard !searchResults.isEmpty else { return }
        let currentIndex = selectedSearchResultIndex ?? searchResults.count - 1
        let nextIndex = (currentIndex + offset + searchResults.count) % searchResults.count
        selectedSearchResultID = searchResults[nextIndex].id
        scrollToSelectedSearchResult(proxy: proxy)
        UISelectionFeedbackGenerator().selectionChanged()
    }

    private func scrollToSelectedSearchResult(proxy: ScrollViewProxy) {
        guard let selectedSearchResultID else { return }
        followsLatestMessage = false
        timelineScrollTask?.cancel()
        Task { @MainActor in
            await Task.yield()
            withAnimation(.easeInOut(duration: 0.22)) {
                proxy.scrollTo(selectedSearchResultID, anchor: .center)
            }
        }
    }

    private var canSend: Bool {
        (!attachmentDrafts.isEmpty || !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) &&
            !isSending && !isSendingAttachment
    }

    /// Commands matching the typed "/" prefix, shown in the Telegram-style
    /// menu. Hidden once the draft stops matching (e.g. after inserting
    /// "/name " the trailing space matches nothing).
    private var visibleBotCommands: [BotCommand]? {
        guard group == nil,
              !isSelfConversation,
              !isSearchingConversation,
              draft.hasPrefix("/"),
              !botCommands.isEmpty else { return nil }
        let query = String(draft.dropFirst()).lowercased()
        let matched = botCommands.filter { $0.name.hasPrefix(query) }
        return matched.isEmpty ? nil : matched
    }

    private func botCommandMenu(_ commands: [BotCommand]) -> some View {
        ScrollView {
            VStack(spacing: 0) {
                ForEach(commands) { command in
                    Button {
                        draft = "/\(command.name) "
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text("/\(command.name)")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(TaskifyTheme.accent)
                            Spacer(minLength: 0)
                            Text(command.description)
                                .font(.caption)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                                .lineLimit(1)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 9)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Insert command \(command.name)")
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) { geometry in
                min(geometry.size.height, 224)
            } action: { height in
                botCommandMenuHeight = height
            }
        }
        .frame(height: botCommandMenuHeight)
        .padding(.horizontal, 9)
    }

    /// Caption for the upload progress area: "file i of N" once a batch grows
    /// past a single file.
    private var attachmentUploadProgressText: String {
        let base = attachmentProgress?.message ?? "Preparing attachment…"
        guard attachmentUploadFileTotal > 1, attachmentProgress != .sendingMessage else { return base }
        return "Sending \(attachmentUploadFileIndex + 1) of \(attachmentUploadFileTotal) — \(base)"
    }

    /// Stages one more attachment, refusing past the batch cap. A refused
    /// draft is never retained, so its deinit cleans up the temp file.
    @MainActor
    private func appendDraft(_ draft: ChatAttachmentDraft) -> Bool {
        guard attachmentDrafts.count < NostrDirectMessageAttachment.maximumBatchCount else {
            model.errorMessage = "You can attach up to \(NostrDirectMessageAttachment.maximumBatchCount) files per message."
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            return false
        }
        attachmentDrafts.append(draft)
        return true
    }

    @MainActor
    private func removeDraft(_ id: UUID) {
        attachmentDrafts.removeAll { $0.id == id }
        if attachmentDrafts.isEmpty { attachmentSendError = nil }
    }

    private var composer: some View {
        TaskifyGlassControlGroup(spacing: 4) {
        VStack(spacing: 6) {
            if let botMenuCommands = visibleBotCommands {
                botCommandMenu(botMenuCommands)
                    .padding(.vertical, 4)
                    .taskifyGlassControl(in: RoundedRectangle(cornerRadius: 21, style: .continuous))
            }
            if let replyingTo {
                HStack(spacing: 10) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(TaskifyTheme.accent)
                        .frame(width: 3, height: 32)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Replying to \(replyTargetName(replyingTo))")
                            .font(.caption.bold())
                            .foregroundStyle(TaskifyTheme.accent)
                        Text(replyingTo.displayContent)
                            .font(.caption)
                            .foregroundStyle(TaskifyTheme.secondaryText)
                            .lineLimit(1)
                    }
                    Spacer()
                    Button {
                        self.replyingTo = nil
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(TaskifyTheme.secondaryText)
                    }
                    .buttonStyle(.plain)
                    .disabled(isSending)
                }
                .padding(.horizontal, 9)
                .padding(.vertical, 8)
                .taskifyGlassControl(in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }

            if isAudioComposerActive {
                audioComposer
            } else {
                // The record button's touch target sits over both the message row and, during a
                // hold, the recording controls that replace it, so the press keeps running until
                // the finger lifts.
                ZStack(alignment: .bottomTrailing) {
                    if isHoldRecording {
                        audioControls
                    } else {
                        messageComposerRow
                    }
                    if showsRecordButton || isHoldRecording {
                        recordAudioButton
                            .padding(3)
                    }
                }
            }
        }
        // Each control floats on its own glass surface; the spacing between them
        // stays transparent so the conversation remains visible underneath.
        .padding(.horizontal, 10)
        .padding(.top, 6)
        .padding(.bottom, 6)
        .fullScreenCover(isPresented: $showingCamera) {
            TaskAttachmentCameraPicker(
                onCapture: { image in
                    showingCamera = false
                    attachmentPreparationTask?.cancel()
                    attachmentPreparationTask = Task { await stageCapturedPhoto(image) }
                },
                onCancel: { showingCamera = false }
            )
            .ignoresSafeArea()
        }
        .fullScreenCover(isPresented: $showingDocumentScanner) {
            TaskAttachmentDocumentScanner(
                onScan: { pages in
                    showingDocumentScanner = false
                    attachmentPreparationTask?.cancel()
                    attachmentPreparationTask = Task { await stageScannedDocument(pages) }
                },
                onCancel: { showingDocumentScanner = false },
                onError: { error in
                    showingDocumentScanner = false
                    model.errorMessage = error.localizedDescription
                    UINotificationFeedbackGenerator().notificationOccurred(.error)
                }
            )
            .ignoresSafeArea()
        }
        }
    }

    private var messageComposerRow: some View {
            HStack(alignment: .bottom, spacing: 9) {
                Menu {
                    // Compile-time simulator exclusion, not a runtime availability check:
                    // device users always get the entries, and the Simulator (no camera)
                    // never does.
                    #if !targetEnvironment(simulator)
                    Button {
                        showingCamera = true
                    } label: {
                        Label("Camera", systemImage: "camera")
                    }
                    Button {
                        showingDocumentScanner = true
                    } label: {
                        Label("Scan Document", systemImage: "doc.text.viewfinder")
                    }
                    #endif
                    Button {
                        showingPhotoPicker = true
                    } label: {
                        Label("Photo or Video", systemImage: "photo.on.rectangle")
                    }
                    Button {
                        showingFileImporter = true
                    } label: {
                        Label("Document", systemImage: "doc")
                    }
                    if group == nil {
                        Button {
                            showingContactSharePicker = true
                        } label: {
                            Label("Share Contact", systemImage: "person.crop.circle.badge.plus")
                        }
                    }
                } label: {
                    Group {
                        if isSendingAttachment {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: "plus")
                                .font(.system(size: 17, weight: .semibold))
                        }
                    }
                    .frame(width: 42, height: 42)
                    .taskifyGlassControl(in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(isSending || isSendingAttachment)
                .accessibilityLabel(isSendingAttachment ? "Preparing attachment" : "Add attachment")

                VStack(alignment: .leading, spacing: 8) {
                    if !attachmentDrafts.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(attachmentDrafts) { attachmentDraft in
                                    TaskifyAttachmentDraftPreview(fileURL: attachmentDraft.fileURL,
                                        name: attachmentDraft.name, mimeType: attachmentDraft.mimeType,
                                        size: attachmentDraft.size, isBusy: isSending) {
                                            removeDraft(attachmentDraft.id)
                                        }
                                }
                            }
                            .padding(.horizontal, 9)
                            .padding(.top, 8)
                        }
                        if isSending {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(attachmentUploadProgressText)
                                    .font(.caption).foregroundStyle(.secondary)
                                if let fraction = attachmentProgress?.fractionCompleted {
                                    ProgressView(value: fraction)
                                }
                                if attachmentProgress != .sendingMessage {
                                    Button("Cancel upload") { attachmentSendTask?.cancel() }
                                        .font(.caption).buttonStyle(.plain)
                                }
                            }
                            .padding(.horizontal, 9)
                        }
                        if let attachmentSendError {
                            Text(attachmentSendError).font(.caption).foregroundStyle(.red)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.horizontal, 9)
                        }
                        Divider().padding(.horizontal, 9)
                    }
                    HStack(alignment: .bottom, spacing: 4) {
                        let composerPrompt = showsRecordHint
                            ? "Tap and hold to record and send audio"
                            : (attachmentDrafts.isEmpty ? "Message" : "Add comment or Send")
                        ZStack(alignment: .topLeading) {
                            if draft.isEmpty {
                                Text(composerPrompt)
                                    .font(.body)
                                    .foregroundStyle(TaskifyTheme.secondaryText)
                                    .padding(.top, 10)
                                    .allowsHitTesting(false)
                            }
                            ChatComposerTextView(
                                text: $draft,
                                isFocused: $composerFocused,
                                isEnabled: !isSending,
                                dismissKeyboard: isSearchingConversation,
                                accessibilityLabel: composerPrompt,
                                pasteAttachment: pasteAttachmentProviders,
                                // Command-Return sends from a hardware keyboard.
                                onCommandReturn: { if canSend { send() } },
                                maximumHeight: composerTextBudget,
                                onEditingChanged: { isComposerEditing = $0 }
                            )
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                                composerTextHeight = height
                            }
                        }
                        .padding(.leading, 15)
                        .frame(maxWidth: .infinity, alignment: .leading)

                        if canSend || isSending {
                            Button(action: send) {
                                Group {
                                    if isSending { ProgressView().tint(.white) }
                                    else {
                                        Image(systemName: "arrow.up")
                                            .font(.system(size: 17, weight: .bold))
                                    }
                                }
                                .foregroundStyle(.white)
                                .frame(width: 40, height: 40)
                                .taskifyGlassControl(in: Circle(), tint: TaskifyTheme.accent.opacity(0.72),
                                    fallbackFill: TaskifyTheme.accent)
                            }
                            .buttonStyle(.plain)
                            .opacity(canSend ? 1 : 0.45)
                            .disabled(!canSend)
                            .accessibilityLabel(attachmentDrafts.isEmpty ? "Send message" : "Send attachments")
                        } else {
                            // Drawn here; the touch target over it is `recordAudioButton`.
                            Image(systemName: "waveform")
                                .font(.system(size: 19, weight: .medium))
                                .foregroundStyle(TaskifyTheme.secondaryText)
                                .frame(width: 40, height: 40)
                                .accessibilityHidden(true)
                        }
                    }
                }
                .padding(3)
                .taskifyGlassControl(in: RoundedRectangle(cornerRadius: 21, style: .continuous), interactive: false)
            }
    }

    /// Tap-to-record and a stopped clip take over the whole composer; a hold-to-record shows
    /// its controls over the hidden message row instead (see `composer`).
    private var isAudioComposerActive: Bool {
        (audioRecorder.isRecording && !isHoldRecording) || recordedAudio != nil
    }

    /// The editor may grow until the timeline above it is down to a sliver. Timeline and editor
    /// heights trade off one for one, so their sum is stable and the budget never oscillates.
    private var composerTextBudget: CGFloat? {
        guard timelineVisibleHeight > 0, composerTextHeight > 0 else { return nil }
        return timelineVisibleHeight + composerTextHeight - 120
    }

    /// Messages' waveform button in the message field. With the keyboard open a tap starts
    /// recording; with it closed, press and hold records and lifting the finger sends, and a
    /// quick tap explains that.
    private var showsRecordButton: Bool {
        !(canSend || isSending)
    }

    private var recordAudioButton: some View {
        Color.clear
            .frame(width: 40, height: 40)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .updating($isPressingRecordButton) { _, pressing, _ in pressing = true }
            )
            .onChange(of: isPressingRecordButton) { _, pressing in
                pressing ? recordButtonPressBegan() : recordButtonPressEnded()
            }
            .disabled(isSendingAttachment || audioRecorder.isRequestingPermission)
            .accessibilityElement()
            .accessibilityLabel("Record audio message")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { beginTapRecording() }
    }

    /// Recording: the live waveform, time and stop. Stopped: cancel outside the capsule, then
    /// play, the clip's waveform, "+ time" to record more, and send — as in Messages.
    private var audioComposer: some View {
        HStack(alignment: .center, spacing: 9) {
            if recordedAudio != nil, !audioRecorder.isRecording {
                Button(action: cancelAudioRecording) {
                    Image(systemName: "xmark")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .frame(width: 44, height: 44)
                        .taskifyGlassControl(in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(isSending)
                .accessibilityLabel("Cancel audio message")
            }
            audioControls
        }
    }

    private var audioControls: some View {
        ChatAudioComposerControls(
            recorder: audioRecorder,
            recording: recordedAudio,
            player: recordedAudioPlayer,
            isBusy: isSending,
            accent: TaskifyTheme.accent,
            onStop: stopAudioRecording,
            onContinue: continueAudioRecording,
            onSend: sendRecordedAudio
        )
        .foregroundStyle(TaskifyTheme.primaryText)
        .frame(maxWidth: .infinity)
        .frame(minHeight: 48)
        .taskifyGlassControl(in: Capsule(), interactive: false)
    }

    private func recordButtonPressBegan() {
        guard !isSending, !isSendingAttachment, !isAudioComposerActive, !isHoldRecording else { return }
        recordPressBegan = true
        holdRecordingReleased = false
        // With the keyboard open the button is tapped; holding only applies to a closed composer.
        guard !isComposerEditing else { return }
        holdRecordingTask?.cancel()
        holdRecordingTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled, isPressingRecordButton else { return }
            beginHoldRecording()
        }
    }

    private func recordButtonPressEnded() {
        holdRecordingTask?.cancel()
        holdRecordingTask = nil
        guard recordPressBegan else { return }
        recordPressBegan = false
        if isHoldRecording {
            holdRecordingReleased = true
            finishHoldRecording()
        } else if isComposerEditing {
            beginTapRecording()
        } else {
            showRecordHint()
        }
    }

    private func showRecordHint() {
        recordHintTask?.cancel()
        withAnimation(.easeOut(duration: 0.15)) { showsRecordHint = true }
        recordHintTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(2.5))
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.2)) { showsRecordHint = false }
        }
    }

    private func beginTapRecording() {
        guard !isSending, !isSendingAttachment, !isAudioComposerActive, !isHoldRecording else { return }
        dismissComposerKeyboard()
        startRecording(continuing: nil)
    }

    private func beginHoldRecording() {
        isHoldRecording = true
        showsRecordHint = false
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        Task { @MainActor in
            do {
                try await audioRecorder.start()
                // The finger lifted while the microphone was opening (or a permission prompt
                // took the touch): finish now, which discards anything too short to be meant.
                if holdRecordingReleased { finishHoldRecording() }
            } catch {
                isHoldRecording = false
                if !(error is CancellationError) { reportAudioError(error) }
            }
        }
    }

    /// Lifting the finger sends, as Messages does; a press too short to hold speech is dropped.
    private func finishHoldRecording() {
        guard audioRecorder.isRecording else { return }
        guard audioRecorder.elapsed >= 0.6 else {
            audioRecorder.cancel()
            isHoldRecording = false
            showRecordHint()
            return
        }
        Task { @MainActor in
            defer { isHoldRecording = false }
            do {
                sendRecording(try await audioRecorder.finish())
            } catch {
                reportAudioError(error)
            }
        }
    }

    private func startRecording(continuing previous: ChatAudioRecorder.Recording?) {
        Task { @MainActor in
            do {
                try await audioRecorder.start(continuing: previous)
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            } catch is CancellationError {
                // The conversation disappeared while microphone permission was pending.
            } catch {
                reportAudioError(error)
            }
        }
    }

    /// Stops recording and keeps the clip in the composer so it can be heard before sending.
    private func stopAudioRecording() {
        Task { @MainActor in
            do {
                recordedAudio = try await audioRecorder.finish()
                attachmentSendError = nil
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            } catch {
                reportAudioError(error)
            }
        }
    }

    /// "+ 0:01": records more onto the stopped clip.
    private func continueAudioRecording() {
        guard let recordedAudio, !audioRecorder.isRecording else { return }
        recordedAudioPlayer.stop()
        startRecording(continuing: recordedAudio)
    }

    private func sendRecordedAudio() {
        guard !isSending, let recording = recordedAudio else { return }
        recordedAudioPlayer.stop()
        recordedAudio = nil
        sendRecording(recording)
    }

    private func sendRecording(_ recording: ChatAudioRecorder.Recording) {
        let draft = ChatAttachmentDraft(
            fileURL: recording.fileURL,
            name: recording.suggestedName,
            mimeType: "audio/mp4",
            size: recording.size
        )
        // The draft owns the file from here on; a failed send leaves it staged for retry.
        guard appendDraft(draft) else { return }
        send()
    }

    private func cancelAudioRecording() {
        audioRecorder.cancel()
        discardRecordedAudio()
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    private func discardRecordedAudio() {
        recordedAudioPlayer.stop()
        if let recordedAudio { try? FileManager.default.removeItem(at: recordedAudio.fileURL) }
        recordedAudio = nil
        isHoldRecording = false
    }

    private func reportAudioError(_ error: Error) {
        model.errorMessage = error.localizedDescription
        UINotificationFeedbackGenerator().notificationOccurred(.error)
    }

    /// Tapping the timeline while the keyboard is open closes it. The FocusState alone
    /// can't resign a UITextView, so drop first responder explicitly too.
    @MainActor
    private func dismissComposerKeyboard() {
        composerFocused = false
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil
        )
    }

    private func send() {
        let content = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend else { return }
        let capturedReply = replyingTo
        let capturedAttachments = attachmentDrafts
        let account = model.identityPublicKey
        attachmentSendError = nil
        attachmentProgress = capturedAttachments.first.map { .encrypting(completed: 0, total: $0.size) }
        attachmentUploadFileTotal = capturedAttachments.count
        attachmentUploadFileIndex = 0
        isSending = true
        attachmentSendTask = Task {
            // All-or-nothing: every file uploads before anything is sent, and a
            // failed upload leaves the drafts staged so a retry reuses the
            // per-draft cached uploads instead of re-uploading everything.
            var uploadingName: String?
            do {
                if !capturedAttachments.isEmpty {
                    var uploaded: [NostrDirectMessageAttachment] = []
                    uploaded.reserveCapacity(capturedAttachments.count)
                    for (index, draftAttachment) in capturedAttachments.enumerated() {
                        attachmentUploadFileIndex = index
                        attachmentProgress = .encrypting(completed: 0, total: draftAttachment.size)
                        uploadingName = draftAttachment.name
                        let attachment: NostrDirectMessageAttachment
                        if let uploadedCached = draftAttachment.uploadedAttachment {
                            attachment = uploadedCached
                        } else {
                            attachment = try await TaskAttachmentUploadService.shared.uploadChatAttachment(
                                fileURL: draftAttachment.fileURL, name: draftAttachment.name,
                                mimeType: draftAttachment.mimeType, progress: { progress in
                                    Task { @MainActor in
                                        guard isSending, attachmentProgress != .sendingMessage else { return }
                                        attachmentProgress = progress
                                    }
                                })
                            // If queueing fails, a retry can reuse the completed upload.
                            draftAttachment.uploadedAttachment = attachment
                        }
                        uploaded.append(attachment)
                    }
                    uploadingName = nil
                    try Task.checkCancellation()
                    guard account == model.identityPublicKey else { throw NostrDirectMessageError.identityUnavailable }
                    attachmentProgress = .sendingMessage
                    try await model.sendDirectMessageAttachments(to: peerPublicKey, attachments: uploaded,
                        replyToEventID: capturedReply?.rumorEventID, comment: content)
                } else {
                    try await model.sendDirectMessage(to: peerPublicKey, content: content,
                        replyToEventID: capturedReply?.rumorEventID)
                }
                attachmentDrafts.removeAll()
                draft = ""
                replyingTo = nil
                sentMessageScrollRequest += 1
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            } catch {
                if !(error is CancellationError), (error as? URLError)?.code != .cancelled {
                    if !capturedAttachments.isEmpty {
                        if let failedName = uploadingName {
                            attachmentSendError = "\(failedName): \(error.localizedDescription)"
                        } else {
                            attachmentSendError = error.localizedDescription
                        }
                    } else {
                        model.errorMessage = error.localizedDescription
                    }
                    UINotificationFeedbackGenerator().notificationOccurred(.error)
                }
            }
            isSending = false
            attachmentProgress = nil
            attachmentSendTask = nil
            composerFocused = true
        }
    }

    private func shareContact(_ contact: NostrContact) async -> Bool {
        do {
            try await model.sendSharedContact(
                contactPublicKey: contact.publicKey,
                to: peerPublicKey
            )
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            return true
        } catch {
            model.errorMessage = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            return false
        }
    }

    @MainActor
    private func stagePhotoSelections(_ selections: [PhotosPickerItem]) async {
        guard !isSending, !isSendingAttachment else { photoSelections = []; return }
        isSendingAttachment = true
        defer { photoSelections = []; isSendingAttachment = false }
        for selection in selections {
            var imported: URL?
            do {
                guard let file = try await selection.loadTransferable(type: TaskifyPhotoFile.self) else {
                    throw ChatAttachmentError.unreadableFile
                }
                imported = file.url
                try Task.checkCancellation()
                let size = try AttachmentFiles.size(file.url)
                guard size > 0 else { throw AttachmentFileError.empty }
                let type = selection.supportedContentTypes.first ?? .data
                let staged = ChatAttachmentDraft(fileURL: file.url,
                    name: "\(type.conforms(to: .movie) ? "Video" : "Photo").\(type.preferredFilenameExtension ?? "bin")",
                    mimeType: type.preferredMIMEType ?? "application/octet-stream", size: size)
                imported = nil
                guard appendDraft(staged) else { continue }
                attachmentSendError = nil
                composerFocused = true
            } catch {
                if let imported { try? FileManager.default.removeItem(at: imported) }
                guard !Task.isCancelled else { return }
                model.errorMessage = error.localizedDescription
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
        }
    }

    @MainActor
    private func stageFile(_ fileURL: URL) async {
        guard !isSending, !isSendingAttachment else { return }
        isSendingAttachment = true
        defer { isSendingAttachment = false }
        let accessing = fileURL.startAccessingSecurityScopedResource()
        defer { if accessing { fileURL.stopAccessingSecurityScopedResource() } }
        var imported: URL?
        do {
            let values = try fileURL.resourceValues(forKeys: [.contentTypeKey, .nameKey])
            let url = try await AttachmentFiles.work { try AttachmentFiles.importFile(fileURL) }
            imported = url
            try Task.checkCancellation()
            let size = try AttachmentFiles.size(url)
            guard size > 0 else { throw AttachmentFileError.empty }
            let staged = ChatAttachmentDraft(fileURL: url, name: values.name ?? fileURL.lastPathComponent,
                mimeType: values.contentType?.preferredMIMEType ?? "application/octet-stream", size: size)
            imported = nil
            guard appendDraft(staged) else { return }
            attachmentSendError = nil
            composerFocused = true
        } catch {
            if let imported { try? FileManager.default.removeItem(at: imported) }
            guard !Task.isCancelled else { return }
            model.errorMessage = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    @MainActor
    private func pasteAttachmentProviders(_ providers: [NSItemProvider]) -> Bool {
        stageAttachmentProviders(providers, fromPasteboard: true)
    }

    /// Stages pasted or dropped media as an attachment. A drop carries its own providers, so the
    /// general pasteboard's unrelated text must not turn a dropped photo away.
    private func stageAttachmentProviders(_ providers: [NSItemProvider], fromPasteboard: Bool) -> Bool {
        guard Self.clipboardAttachmentSource(in: providers, fromPasteboard: fromPasteboard) != nil
        else { return false }
        guard !isSending, !isSendingAttachment else { return true }
        attachmentPreparationTask?.cancel()
        attachmentPreparationTask = Task {
            await stageClipboardAttachment(providers, fromPasteboard: fromPasteboard)
        }
        return true
    }

    @MainActor
    private func stageCapturedPhoto(_ image: UIImage) async {
        guard !isSending, !isSendingAttachment else { return }
        isSendingAttachment = true
        defer { isSendingAttachment = false }
        var staged: URL?
        do {
            guard let jpegData = image.jpegData(compressionQuality: 0.88) else {
                throw AttachmentFileError.invalidFile
            }
            let url = try await AttachmentFiles.work { try AttachmentFiles.write(jpegData) }
            staged = url
            try Task.checkCancellation()
            let size = try AttachmentFiles.size(url)
            let timestamp = Int(Date().timeIntervalSince1970 * 1_000)
            let draftAttachment = ChatAttachmentDraft(
                fileURL: url,
                name: "photo-\(timestamp).jpg",
                mimeType: "image/jpeg",
                size: size
            )
            staged = nil
            guard appendDraft(draftAttachment) else { return }
            attachmentSendError = nil
            composerFocused = true
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        } catch {
            if let staged { try? FileManager.default.removeItem(at: staged) }
            guard !Task.isCancelled else { return }
            model.errorMessage = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    @MainActor
    private func stageScannedDocument(_ pages: [UIImage]) async {
        guard !isSending, !isSendingAttachment, !pages.isEmpty else { return }
        isSendingAttachment = true
        defer { isSendingAttachment = false }
        var staged: URL?
        do {
            let pdfData = try await AttachmentFiles.work {
                try TaskAttachmentPDFRenderer.pdfData(from: pages)
            }
            let url = try await AttachmentFiles.work { try AttachmentFiles.write(pdfData) }
            staged = url
            try Task.checkCancellation()
            let size = try AttachmentFiles.size(url)
            let timestamp = Int(Date().timeIntervalSince1970 * 1_000)
            let draftAttachment = ChatAttachmentDraft(
                fileURL: url,
                name: "scan-\(timestamp).pdf",
                mimeType: "application/pdf",
                size: size
            )
            staged = nil
            guard appendDraft(draftAttachment) else { return }
            attachmentSendError = nil
            composerFocused = true
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        } catch {
            if let staged { try? FileManager.default.removeItem(at: staged) }
            guard !Task.isCancelled else { return }
            model.errorMessage = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    @MainActor
    private func stageClipboardAttachment(_ providers: [NSItemProvider], fromPasteboard: Bool) async {
        guard !isSending, !isSendingAttachment,
              let source = Self.clipboardAttachmentSource(in: providers, fromPasteboard: fromPasteboard)
        else { return }
        isSendingAttachment = true
        defer { isSendingAttachment = false }
        var imported: URL?
        do {
            let staged: (url: URL, name: String, type: UTType?)
            if let type = source.contentType {
                let url = try await Self.importClipboardRepresentation(
                    from: source.provider,
                    contentType: type
                )
                let baseName = source.provider.suggestedName?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                let fallbackName: String
                if type.conforms(to: .image) { fallbackName = "Pasted Image" }
                else if type.conforms(to: .movie) { fallbackName = "Pasted Video" }
                else if type.conforms(to: .audio) { fallbackName = "Pasted Audio" }
                else { fallbackName = "Pasted File" }
                let suppliedName = baseName.flatMap { $0.isEmpty ? nil : $0 } ?? fallbackName
                let name = URL(fileURLWithPath: suppliedName).pathExtension.isEmpty
                    ? "\(suppliedName).\(type.preferredFilenameExtension ?? "bin")"
                    : suppliedName
                staged = (url, name, type)
            } else {
                let fileURL = try await Self.clipboardFileURL(from: source.provider)
                let values = try fileURL.resourceValues(forKeys: [.contentTypeKey, .nameKey])
                let url = try await AttachmentFiles.work { try AttachmentFiles.importFile(fileURL) }
                staged = (
                    url,
                    values.name ?? fileURL.lastPathComponent,
                    values.contentType ?? UTType(filenameExtension: fileURL.pathExtension)
                )
            }
            imported = staged.url
            try Task.checkCancellation()
            let size = try AttachmentFiles.size(staged.url)
            guard size > 0 else { throw AttachmentFileError.empty }
            let draftAttachment = ChatAttachmentDraft(
                fileURL: staged.url,
                name: staged.name,
                mimeType: staged.type?.preferredMIMEType ?? "application/octet-stream",
                size: size
            )
            imported = nil
            guard appendDraft(draftAttachment) else { return }
            attachmentSendError = nil
            composerFocused = true
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        } catch {
            if let imported { try? FileManager.default.removeItem(at: imported) }
            guard !Task.isCancelled else { return }
            model.errorMessage = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    private struct ClipboardAttachmentSource {
        let provider: NSItemProvider
        let contentType: UTType?
    }

    private static func clipboardAttachmentSource(
        in providers: [NSItemProvider],
        fromPasteboard: Bool
    ) -> ClipboardAttachmentSource? {
        // If the clipboard can paste as text at all, text wins: plain or styled text
        // copies must never stage as a file attachment, no matter what companion types
        // the source app registers. Media with no text representation (a copied
        // screenshot, video, or file) still stages as an attachment below.
        let hasTextRepresentation = (fromPasteboard && UIPasteboard.general.hasStrings) || providers.contains { provider in
            provider.registeredTypeIdentifiers.compactMap(UTType.init).contains {
                $0.conforms(to: .text)
            }
        }
        if hasTextRepresentation { return nil }
        for provider in providers {
            let types = provider.registeredTypeIdentifiers.compactMap(UTType.init)
            let contentType = types.first {
                $0.conforms(to: .image) || $0.conforms(to: .movie) || $0.conforms(to: .audio)
            } ?? types.first {
                $0.conforms(to: .data) &&
                    !$0.conforms(to: .text) &&
                    !$0.conforms(to: .url)
            }
            if let contentType { return ClipboardAttachmentSource(provider: provider, contentType: contentType) }
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                return ClipboardAttachmentSource(provider: provider, contentType: nil)
            }
        }
        return nil
    }

    private static func importClipboardRepresentation(
        from provider: NSItemProvider,
        contentType: UTType
    ) async throws -> URL {
        do {
            return try await withCheckedThrowingContinuation { continuation in
                provider.loadFileRepresentation(forTypeIdentifier: contentType.identifier) { url, error in
                    do {
                        if let error { throw error }
                        guard let url else { throw AttachmentFileError.invalidFile }
                        // The provider owns this URL only for the duration of its callback.
                        continuation.resume(returning: try AttachmentFiles.importFile(url))
                    } catch {
                        continuation.resume(throwing: error)
                    }
                }
            }
        } catch {
            return try await withCheckedThrowingContinuation { continuation in
                provider.loadDataRepresentation(forTypeIdentifier: contentType.identifier) { data, fallbackError in
                    do {
                        if let fallbackError { throw fallbackError }
                        guard let data else { throw AttachmentFileError.invalidFile }
                        continuation.resume(returning: try AttachmentFiles.write(data))
                    } catch {
                        continuation.resume(throwing: error)
                    }
                }
            }
        }
    }

    private static func clipboardFileURL(from provider: NSItemProvider) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(
                forTypeIdentifier: UTType.fileURL.identifier,
                options: nil
            ) { value, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let url = value as? URL {
                    continuation.resume(returning: url)
                } else if let data = value as? Data,
                          let url = URL(dataRepresentation: data, relativeTo: nil) {
                    continuation.resume(returning: url)
                } else {
                    continuation.resume(throwing: AttachmentFileError.invalidFile)
                }
            }
        }
    }

    private func shouldShowDayDivider(at index: Int, in currentTimeline: [ChatTimelineItem]) -> Bool {
        guard currentTimeline.indices.contains(index) else { return false }
        guard index > 0 else { return true }
        let current = Date(timeIntervalSince1970: TimeInterval(currentTimeline[index].timestamp))
        let previous = Date(timeIntervalSince1970: TimeInterval(currentTimeline[index - 1].timestamp))
        return !Calendar.current.isDate(current, inSameDayAs: previous)
    }

    private func isMessageGrouped(at currentIndex: Int, with previousIndex: Int, in currentTimeline: [ChatTimelineItem]) -> Bool {
        guard currentTimeline.indices.contains(currentIndex), currentTimeline.indices.contains(previousIndex),
              case let .message(current) = currentTimeline[currentIndex],
              case let .message(previous) = currentTimeline[previousIndex] else {
            return false
        }
        guard current.replyToEventID == nil,
              current.isIncoming == previous.isIncoming,
              current.senderPublicKey == previous.senderPublicKey,
              current.createdAt - previous.createdAt <= 5 * 60 else { return false }
        let currentDate = Date(timeIntervalSince1970: TimeInterval(current.createdAt))
        let previousDate = Date(timeIntervalSince1970: TimeInterval(previous.createdAt))
        return Calendar.current.isDate(currentDate, inSameDayAs: previousDate)
    }

    private func senderName(for publicKey: String) -> String {
        if publicKey == model.identityPublicKey { return "You" }
        if let contact = model.nostrContact(publicKey: publicKey) { return contact.displayName }
        guard let key = NostrPublicKey.parse(publicKey),
              let npub = NostrPublicKey.npub(from: key) else { return "Member" }
        return "\(npub.prefix(8))…"
    }

    private func replyTargetName(_ message: NostrDirectMessage) -> String {
        message.isIncoming ? senderName(for: message.senderPublicKey) : "yourself"
    }

    private func react(to message: NostrDirectMessage, with emoji: String) {
        let ownReaction = model.directMessageReactions(for: message).first {
            $0.senderPublicKey == model.identityPublicKey
        }
        let value = ownReaction?.emoji == emoji ? "-" : emoji
        Task {
            do {
                try await model.sendDirectMessageReaction(to: message, emoji: value)
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            } catch {
                model.errorMessage = error.localizedDescription
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
        }
    }

    private func markReadAndScroll(
        proxy: ScrollViewProxy,
        targetID: String? = nil,
        animated: Bool
    ) {
        model.markDirectMessageThreadRead(peerPublicKey: peerPublicKey)
        followsLatestMessage = targetID == nil
        timelineScrollTask?.cancel()
        guard let timelineItemID = targetID ?? timeline.last?.id else { return }
        timelineScrollTask = Task { @MainActor in
            await Task.yield()
            guard !Task.isCancelled else { return }
            let anchor: UnitPoint = targetID == nil ? .bottom : .center
            if animated, !isTimelineMoving {
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(timelineItemID, anchor: anchor)
                }
                try? await Task.sleep(for: .milliseconds(260))
            } else {
                // A timeline still carried by a fling overrides an animated scroll; a direct
                // one also stops the momentum, so the button works mid-scroll.
                proxy.scrollTo(timelineItemID, anchor: anchor)
                try? await Task.sleep(for: .milliseconds(50))
            }
            // Lazy rows revise their heights once realized; settle on the target again.
            guard !Task.isCancelled else { return }
            proxy.scrollTo(timelineItemID, anchor: anchor)
        }
    }
}

/// The round "scroll to latest message" button, built in UIKit so it sits above the timeline's
/// scroll view in hit testing (see its use in the conversation).
private struct ChatScrollToLatestButton: UIViewRepresentable {
    let action: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(action: action) }

    func makeUIView(context: Context) -> UIButton {
        var configuration: UIButton.Configuration
        if #available(iOS 26.0, *) {
            configuration = .glass()
        } else {
            configuration = .gray()
        }
        configuration.image = UIImage(
            systemName: "arrow.down",
            withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
        )
        configuration.baseForegroundColor = UIColor(TaskifyTheme.primaryText)
        configuration.cornerStyle = .capsule
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 10, leading: 10, bottom: 10, trailing: 10)
        let button = UIButton(configuration: configuration)
        button.addTarget(context.coordinator, action: #selector(Coordinator.tapped(_:)), for: .touchUpInside)
        button.accessibilityLabel = "Scroll to latest message"
        button.accessibilityIdentifier = "chatScrollToBottom"
        return button
    }

    func updateUIView(_ button: UIButton, context: Context) {
        context.coordinator.action = action
    }

    final class Coordinator: NSObject {
        var action: () -> Void
        init(action: @escaping () -> Void) { self.action = action }
        @objc func tapped(_ sender: UIButton) {
            // SwiftUI's scrollTo does not stop a fling, and the remaining momentum would carry
            // the timeline away again. Halting it is UIKit's own idiom: set the current offset
            // without animation.
            if let window = sender.window { Self.stopMomentum(in: window) }
            action()
        }

        private static func stopMomentum(in view: UIView) {
            if let scrollView = view as? UIScrollView, scrollView.isDecelerating {
                scrollView.setContentOffset(scrollView.contentOffset, animated: false)
            }
            view.subviews.forEach(stopMomentum)
        }
    }
}
