/// Modifier keys that change standard multi-task selection behavior.
public struct MacTaskSelectionModifiers: OptionSet, Sendable {
    public let rawValue: Int

    public init(rawValue: Int) {
        self.rawValue = rawValue
    }

    public static let command = Self(rawValue: 1 << 0)
    public static let shift = Self(rawValue: 1 << 1)
}

/// Selection state for task cards, following the Command-click and Shift-click behavior of a
/// native macOS list. The displayed order is required so a Shift-click can select the exact range
/// the user sees, including across board columns.
public struct MacTaskSelection: Equatable, Sendable {
    public private(set) var taskIDs: Set<String>
    public private(set) var anchorTaskID: String?

    public init(taskIDs: Set<String> = [], anchorTaskID: String? = nil) {
        self.taskIDs = taskIDs
        self.anchorTaskID = anchorTaskID.flatMap { taskIDs.contains($0) ? $0 : nil }
    }

    public var singleTaskID: String? {
        taskIDs.count == 1 ? taskIDs.first : nil
    }

    public func contains(_ taskID: String) -> Bool {
        taskIDs.contains(taskID)
    }

    public mutating func select(
        _ taskID: String,
        in orderedTaskIDs: [String],
        modifiers: MacTaskSelectionModifiers = []
    ) {
        let orderedIDs = Self.unique(orderedTaskIDs)
        guard let targetIndex = orderedIDs.firstIndex(of: taskID) else {
            selectOnly(taskID)
            return
        }

        if modifiers.contains(.shift),
           let anchorTaskID,
           let anchorIndex = orderedIDs.firstIndex(of: anchorTaskID) {
            let bounds = min(anchorIndex, targetIndex)...max(anchorIndex, targetIndex)
            let range = Set(orderedIDs[bounds])
            if modifiers.contains(.command) {
                taskIDs.formUnion(range)
            } else {
                taskIDs = range
            }
            return
        }

        if modifiers.contains(.command) {
            if taskIDs.contains(taskID) {
                taskIDs.remove(taskID)
                if taskIDs.isEmpty { anchorTaskID = nil }
            } else {
                taskIDs.insert(taskID)
                anchorTaskID = taskID
            }
            return
        }

        selectOnly(taskID)
    }

    public mutating func selectOnly(_ taskID: String) {
        taskIDs = [taskID]
        anchorTaskID = taskID
    }

    public mutating func retain(_ orderedTaskIDs: [String]) {
        let availableIDs = Set(orderedTaskIDs)
        taskIDs.formIntersection(availableIDs)
        guard let anchorTaskID else { return }
        if taskIDs.isEmpty || !availableIDs.contains(anchorTaskID) {
            self.anchorTaskID = orderedTaskIDs.first(where: taskIDs.contains)
        }
    }

    public mutating func clear() {
        taskIDs.removeAll()
        anchorTaskID = nil
    }

    private static func unique(_ taskIDs: [String]) -> [String] {
        var seen = Set<String>()
        return taskIDs.filter { seen.insert($0).inserted }
    }
}
