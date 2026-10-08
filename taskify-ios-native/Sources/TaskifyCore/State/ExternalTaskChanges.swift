import Foundation

/// Task changes written to the shared store by another process -- the Home Screen widget's
/// complete button and the Add Task shortcut -- while the app holds its own copy in memory.
public struct ExternalTaskMerge: Equatable, Sendable {
    /// The app's tasks with the outside changes applied.
    public var tasks: [TaskItem]
    /// Tasks the outside writer added or changed, which the app must publish to relays.
    public var changedTaskIDs: [String]
}

extension TaskifySnapshot {
    /// Three-way merge of tasks. `base` is what the store held when the app last read or wrote it,
    /// `ours` is the app's current state, and `theirs` is what is on disk now.
    ///
    /// A task the outside writer added, or changed while the app left it alone, is taken from
    /// `theirs`. When both sides changed the same task the app's version wins: it is the one the
    /// user is looking at, and the app publishes its own edits. Tasks missing from `theirs` are
    /// kept; the outside writers never delete.
    public static func mergingExternalTaskChanges(
        base: [TaskItem],
        ours: [TaskItem],
        theirs: [TaskItem]
    ) -> ExternalTaskMerge {
        let baseByID = Dictionary(base.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let oursIndexByID = Dictionary(
            ours.indices.map { (ours[$0].id, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        var merged = ours
        var changed: [String] = []
        for task in theirs {
            let before = baseByID[task.id]
            guard task != before else { continue }
            if let index = oursIndexByID[task.id] {
                // Ours unchanged since the base: the outside edit applies.
                guard merged[index] == before else { continue }
                merged[index] = task
            } else {
                // Unknown to the app (added outside), or the app has not seen it yet.
                guard before == nil else { continue }
                merged.append(task)
            }
            changed.append(task.id)
        }
        return ExternalTaskMerge(tasks: merged, changedTaskIDs: changed)
    }
}
