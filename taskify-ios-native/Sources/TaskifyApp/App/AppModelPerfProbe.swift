#if DEBUG && os(iOS)
import Foundation
import TaskifyCore

/// Measures what a chat change and a task edit cost the board (C8-1), for
/// `BoardRenderUITests`. With `TASKIFY_UI_TEST_PERF_PROBE=1` and the performance fixture, it
/// waits for the board to settle, makes 20 chat-state writes, then edits one task, and reports
/// the card bodies each step evaluated in `perfProbeResult`.
extension AppModel {
    func runPerformanceProbeIfRequested() {
        runChatPerformanceProbeIfRequested()
        guard ProcessInfo.processInfo.environment["TASKIFY_UI_TEST_PERF_PROBE"] == "1" else { return }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(4))
            let monitor = TaskifyPerfMonitor.shared
            var before = monitor.totalCardBodies
            for step in 0..<20 {
                var updated = snapshot
                var archived = updated.directMessageArchivedAt ?? [:]
                archived["perf-probe-peer"] = 1_000 + step
                updated.directMessageArchivedAt = archived
                snapshot = updated
                try? await Task.sleep(for: .milliseconds(100))
            }
            let chat = monitor.totalCardBodies - before

            before = monitor.totalCardBodies
            if let index = snapshot.tasks.firstIndex(where: { $0.id == "performance-task-0" }) {
                var updated = snapshot
                updated.tasks[index].title += " (edited)"
                snapshot = updated
            }
            try? await Task.sleep(for: .milliseconds(600))
            let edit = monitor.totalCardBodies - before
            perfProbeResult = "chat=\(chat) edit=\(edit)"
        }
    }

    /// With `TASKIFY_UI_TEST_CHAT_PERF_PROBE=1` and the chat fixture: once the test has opened
    /// the conversation, 20 task writes, reporting the conversation timeline rebuilds they caused.
    private func runChatPerformanceProbeIfRequested() {
        guard ProcessInfo.processInfo.environment["TASKIFY_UI_TEST_CHAT_PERF_PROBE"] == "1" else { return }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(10))
            let monitor = TaskifyPerfMonitor.shared
            let before = monitor.totalChatTimelineBuilds
            let secondsBefore = monitor.totalChatTimelineBuildSeconds
            let boardID = snapshot.selectedBoardID
            for step in 0..<20 {
                var updated = snapshot
                updated.tasks.append(TaskItem(id: "chat-probe-\(step)", boardID: boardID, title: "Probe \(step)"))
                snapshot = updated
                try? await Task.sleep(for: .milliseconds(100))
            }
            let builds = monitor.totalChatTimelineBuilds - before
            let milliseconds = (monitor.totalChatTimelineBuildSeconds - secondsBefore) * 1000
            perfProbeResult = "tasks=\(builds) ms=\(Int(milliseconds.rounded()))"
        }
    }
}
#endif
