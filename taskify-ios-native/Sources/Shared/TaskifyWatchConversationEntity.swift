import AppIntents
import Foundation
import TaskifyWatchShared

/// A chat conversation, as App Intents sees one.
///
/// This file is compiled into **both** the Watch app and its widget extension, deliberately, for
/// the reason `TaskifyQuickAddIntent` records: App Intents types defined in a package extract
/// healthy-looking metadata and then fail to load at runtime. The app's shortcuts and the
/// extension's complication configuration each need the type in their own binary.
struct TaskifyWatchConversationEntity: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Conversation"
    static var defaultQuery = TaskifyWatchConversationQuery()

    let id: String
    let name: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }

    init(id: String, name: String) {
        self.id = id
        self.name = name
    }

    init(_ conversation: TaskifyWatchChatWidgetConversation) {
        self.init(id: conversation.id, name: conversation.displayName)
    }
}

struct TaskifyWatchConversationQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [TaskifyWatchConversationEntity] {
        let snapshot = TaskifyWatchChatWidgetCache.load()
        return identifiers
            .compactMap(snapshot.conversation(id:))
            .map(TaskifyWatchConversationEntity.init)
    }

    func entities(matching string: String) async throws -> [TaskifyWatchConversationEntity] {
        TaskifyWatchChatWidgetCache.load()
            .conversations(matching: string)
            .map(TaskifyWatchConversationEntity.init)
    }

    func suggestedEntities() async throws -> [TaskifyWatchConversationEntity] {
        TaskifyWatchChatWidgetCache.load().conversations.map(TaskifyWatchConversationEntity.init)
    }
}
