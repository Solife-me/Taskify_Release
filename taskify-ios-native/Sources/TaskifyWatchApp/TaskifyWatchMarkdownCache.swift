import Foundation
import TaskifyWatchShared

/// Only syntax is cached. Views still apply current colors, fonts, and link behavior.
final class TaskifyWatchMarkdownCache: @unchecked Sendable {
    static let shared = TaskifyWatchMarkdownCache()
    private final class DocumentBox: NSObject {
        let value: NostrChatMarkdownDocument
        init(_ value: NostrChatMarkdownDocument) { self.value = value }
    }
    private final class InlineBox: NSObject {
        let value: AttributedString
        init(_ value: AttributedString) { self.value = value }
    }
    private let lock = NSLock()
    private let documents = NSCache<NSString, DocumentBox>()
    private let inlines = NSCache<NSString, InlineBox>()
    private let parseDocument: (String) -> NostrChatMarkdownDocument
    private let parseInline: (String) -> AttributedString

    init(parseDocument: @escaping (String) -> NostrChatMarkdownDocument = NostrChatMarkdown.document,
         parseInline: @escaping (String) -> AttributedString = NostrChatMarkdown.inlineAttributedString) {
        self.parseDocument = parseDocument
        self.parseInline = parseInline
        documents.countLimit = 128
        documents.totalCostLimit = 1_024 * 1_024
        inlines.countLimit = 512
        inlines.totalCostLimit = 1_024 * 1_024
    }

    func document(_ text: String) -> NostrChatMarkdownDocument {
        lock.lock()
        defer { lock.unlock() }
        if let cached = documents.object(forKey: text as NSString) { return cached.value }
        let value = parseDocument(text)
        if text.utf8.count <= 128 * 1_024 {
            documents.setObject(DocumentBox(value), forKey: text as NSString, cost: text.utf8.count * 4)
        }
        return value
    }

    func inline(_ text: String) -> AttributedString {
        lock.lock()
        defer { lock.unlock() }
        if let cached = inlines.object(forKey: text as NSString) { return cached.value }
        let value = parseInline(text)
        if text.utf8.count <= 128 * 1_024 {
            inlines.setObject(InlineBox(value), forKey: text as NSString, cost: text.utf8.count * 4)
        }
        return value
    }

    func clear() {
        lock.lock()
        defer { lock.unlock() }
        documents.removeAllObjects()
        inlines.removeAllObjects()
    }
}
