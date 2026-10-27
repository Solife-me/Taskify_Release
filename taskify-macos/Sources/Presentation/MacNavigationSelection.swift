enum MacNavigationSelection {
    static func retainedTaskID(
        selectedTaskID: String?,
        selectedTaskBoardID: String?,
        destination: String
    ) -> String? {
        guard selectedTaskBoardID == destination else { return nil }
        return selectedTaskID
    }
}
