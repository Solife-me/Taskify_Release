import AppIntents
import Foundation

#if os(iOS) || os(watchOS) || TASKIFY_MAC_SHORTCUTS
/// A free-form task name represented as an App Entity. App Shortcut invocation phrases cannot
/// interpolate a plain String parameter, but they can interpolate an App Entity. The query turns
/// whatever Siri heard into a single task-name entity, allowing natural one-sentence requests
/// such as “Add buy milk in Taskify” without an extra question.
///
/// Compiled directly into the iPhone, Mac and Watch app targets, never a package: App Intents
/// types outside the app module fail to load at runtime (see `TaskifyAddTaskIntent`). The Remind
/// Me intents use it the same way for “Remind me to take out the trash tomorrow at 1pm”.
struct TaskifyShortcutTaskNameEntity: AppEntity {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Task Name")
    static var defaultQuery = TaskNameQuery()

    let id: String
    let name: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }

    init(name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        self.id = trimmed
        self.name = trimmed
    }

    struct TaskNameQuery: EntityStringQuery {
        init() {}

        func entities(for identifiers: [String]) async throws -> [TaskifyShortcutTaskNameEntity] {
            identifiers.compactMap { identifier in
                let entity = TaskifyShortcutTaskNameEntity(name: identifier)
                return entity.name.isEmpty ? nil : entity
            }
        }

        func entities(matching string: String) async throws -> [TaskifyShortcutTaskNameEntity] {
            let entity = TaskifyShortcutTaskNameEntity(name: string)
            return entity.name.isEmpty ? [] : [entity]
        }

        func suggestedEntities() async throws -> [TaskifyShortcutTaskNameEntity] {
            []
        }
    }
}
#endif
