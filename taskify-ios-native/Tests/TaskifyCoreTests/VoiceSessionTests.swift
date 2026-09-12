import Foundation
import XCTest
import TaskifyWatchShared
@testable import TaskifyCore

final class VoiceSessionTests: XCTestCase {
    /// Deterministic ids so assertions can name candidates directly.
    private func sequentialIDs() -> () -> String {
        var counter = 0
        return {
            counter += 1
            return "c\(counter)"
        }
    }

    private func session(withTitles titles: [String]) -> VoiceSessionState {
        var state = VoiceSessionState()
        state.apply(titles.map { .init(type: .createTask, title: $0) }, idProvider: sequentialIDs())
        return state
    }

    // MARK: - Transcript

    func testCommitTranscriptJoinsWithSpacesAndClearsInterim() {
        var state = VoiceSessionState()
        state.interimTranscript = "buy mi"
        state.commitTranscript("buy milk")
        XCTAssertEqual(state.transcript, "buy milk")
        XCTAssertEqual(state.interimTranscript, "")

        state.commitTranscript("and eggs")
        XCTAssertEqual(state.transcript, "buy milk and eggs")
    }

    func testCombinedTranscriptIncludesInterimTail() {
        var state = VoiceSessionState()
        state.transcript = "call the dentist"
        state.interimTranscript = "on Friday"
        XCTAssertEqual(state.combinedTranscript(), "call the dentist on Friday")
    }

    func testCombinedTranscriptIsEmptyWhenNothingSpoken() {
        XCTAssertEqual(VoiceSessionState().combinedTranscript(), "")
    }

    func testSpeechAccumulatorPreservesWordsBeforeAPause() {
        var accumulator = SpeechTranscriptAccumulator()
        accumulator.update(
            segments: [
                .init(text: "Buy", timestamp: 0, duration: 0.3),
                .init(text: "milk", timestamp: 0.35, duration: 0.3),
            ],
            fallbackText: "Buy milk"
        )

        let transcript = accumulator.update(
            segments: [
                .init(text: "and", timestamp: 1.8, duration: 0.2),
                .init(text: "eggs", timestamp: 2.05, duration: 0.35),
            ],
            fallbackText: "and eggs"
        )

        XCTAssertEqual(transcript, "Buy milk and eggs")
    }

    func testSpeechAccumulatorRevisesWordsInTheSameTimeRange() {
        var accumulator = SpeechTranscriptAccumulator()
        accumulator.update(
            segments: [
                .init(text: "Call", timestamp: 0, duration: 0.25),
                .init(text: "Anne", timestamp: 0.3, duration: 0.35),
            ]
        )

        let transcript = accumulator.update(
            segments: [
                .init(text: "Call", timestamp: 0, duration: 0.25),
                .init(text: "Anna", timestamp: 0.3, duration: 0.35),
            ]
        )

        XCTAssertEqual(transcript, "Call Anna")
    }

    func testSpeechAccumulatorDoesNotLoseATrailingWordToAShorterRevision() {
        var accumulator = SpeechTranscriptAccumulator()
        accumulator.update(
            segments: [
                .init(text: "Call", timestamp: 0, duration: 0.25),
                .init(text: "Mom", timestamp: 0.3, duration: 0.25),
                .init(text: "tomorrow", timestamp: 0.65, duration: 0.45),
            ]
        )

        let transcript = accumulator.update(
            segments: [
                .init(text: "Call", timestamp: 0, duration: 0.25),
                .init(text: "Mom", timestamp: 0.3, duration: 0.25),
            ]
        )

        XCTAssertEqual(transcript, "Call Mom tomorrow")
    }

    func testSpeechAccumulatorFallbackAppendsNewPhraseWithoutDuplicatingOverlap() {
        var accumulator = SpeechTranscriptAccumulator()
        accumulator.update(segments: [], fallbackText: "Buy milk and")
        XCTAssertEqual(
            accumulator.update(segments: [], fallbackText: "and eggs"),
            "Buy milk and eggs"
        )
    }

    func testSpeechAccumulatorResetStartsANewSession() {
        var accumulator = SpeechTranscriptAccumulator()
        accumulator.update(
            segments: [.init(text: "First", timestamp: 0, duration: 0.2)]
        )
        accumulator.reset()

        XCTAssertEqual(
            accumulator.update(
                segments: [.init(text: "Second", timestamp: 0, duration: 0.2)]
            ),
            "Second"
        )
    }

    // MARK: - create_task

    func testCreateTaskAppendsConfirmedCandidate() {
        var state = VoiceSessionState()
        state.apply([
            .init(type: .createTask, title: "Buy milk", dueText: "tomorrow", subtasks: ["2%", "whole"]),
        ], idProvider: sequentialIDs())

        XCTAssertEqual(state.candidates.count, 1)
        let candidate = state.candidates[0]
        XCTAssertEqual(candidate.title, "Buy milk")
        XCTAssertEqual(candidate.dueText, "tomorrow")
        XCTAssertEqual(candidate.subtasks, ["2%", "whole"])
        XCTAssertEqual(candidate.status, .confirmed)
    }

    // MARK: - update_task

    func testCreateAndUpdateCarryNotesAndRecurrenceText() {
        var state = VoiceSessionState()
        state.apply([
            .init(
                type: .createTask,
                title: "Buy milk",
                notes: "2% and oat",
                recurrenceText: "every Monday"
            ),
        ], idProvider: sequentialIDs())
        state.apply([
            .init(type: .updateTask, changes: .init(notes: "whole milk only", recurrenceText: "weekdays")),
        ])

        XCTAssertEqual(state.candidates[0].notes, "whole milk only")
        XCTAssertEqual(state.candidates[0].recurrenceText, "weekdays")

        // Top-level fields win over `changes`, matching the PWA reducer.
        state.apply([.init(type: .updateTask, notes: "oat milk only")])
        XCTAssertEqual(state.candidates[0].notes, "oat milk only")
    }

    func testUpdateTaskWithoutTargetEditsTheMostRecentCandidate() {
        var state = session(withTitles: ["Call Ana", "Buy milk"])
        state.apply([.init(type: .updateTask, changes: .init(dueText: "Thursday"))])

        XCTAssertNil(state.candidates[0].dueText)
        XCTAssertEqual(state.candidates[1].dueText, "Thursday")
    }

    func testUpdateTaskTargetsByTaskIdReference() {
        var state = session(withTitles: ["Call Ana", "Buy milk"])
        state.apply([.init(type: .updateTask, targetRef: "task:c1", changes: .init(title: "Call Ana back"))])

        XCTAssertEqual(state.candidates[0].title, "Call Ana back")
        XCTAssertEqual(state.candidates[1].title, "Buy milk")
    }

    func testUpdateTaskTargetsByCaseInsensitiveTitleSubstring() {
        var state = session(withTitles: ["Call Ana", "Buy milk"])
        state.apply([.init(type: .updateTask, targetRef: "ANA", changes: .init(dueText: "tonight"))])

        XCTAssertEqual(state.candidates[0].dueText, "tonight")
        XCTAssertNil(state.candidates[1].dueText)
    }

    func testUpdateTaskTopLevelFieldsWinOverNestedChanges() {
        var state = session(withTitles: ["Buy milk"])
        state.apply([
            .init(type: .updateTask, title: "Buy oat milk", changes: .init(title: "ignored")),
        ])

        XCTAssertEqual(state.candidates[0].title, "Buy oat milk")
    }

    func testUpdateTaskAgainstAnUnknownReferenceIsIgnored() {
        var state = session(withTitles: ["Buy milk"])
        state.apply([.init(type: .updateTask, targetRef: "task:missing", changes: .init(title: "Nope"))])

        XCTAssertEqual(state.candidates[0].title, "Buy milk")
    }

    func testUpdateTaskOnEmptyCandidateListIsIgnored() {
        var state = VoiceSessionState()
        state.apply([.init(type: .updateTask, changes: .init(title: "Nope"))])
        XCTAssertTrue(state.candidates.isEmpty)
    }

    // MARK: - delete_task

    func testDeleteTaskDismissesTheTargetedCandidate() {
        var state = session(withTitles: ["Call Ana", "Buy milk"])
        state.apply([.init(type: .deleteTask, targetRef: "milk")])

        XCTAssertEqual(state.candidates[0].status, .confirmed)
        XCTAssertEqual(state.candidates[1].status, .dismissed)
        XCTAssertEqual(state.visibleCandidates.map(\.title), ["Call Ana"])
    }

    func testDeleteAllDismissesEveryCandidate() {
        var state = session(withTitles: ["Call Ana", "Buy milk"])
        state.apply([.init(type: .deleteTask, targetRef: "all")])

        XCTAssertTrue(state.candidates.allSatisfy { $0.status == .dismissed })
        XCTAssertTrue(state.visibleCandidates.isEmpty)
    }

    /// "scratch that" after already dropping one should hit the newest surviving task, not the
    /// dismissed one -- otherwise a correction silently does nothing.
    func testUntargetedOperationsSkipAlreadyDismissedCandidates() {
        var state = session(withTitles: ["Call Ana", "Buy milk"])
        state.apply([.init(type: .deleteTask, targetRef: "milk")])
        state.apply([.init(type: .updateTask, changes: .init(dueText: "Monday"))])

        XCTAssertEqual(state.candidates[0].dueText, "Monday")
        XCTAssertNil(state.candidates[1].dueText)
    }

    // MARK: - mark_uncertain

    func testMarkUncertainDropsTheCandidateBackToDraft() {
        var state = session(withTitles: ["Buy milk"])
        state.apply([.init(type: .markUncertain, targetRef: "milk")])

        XCTAssertEqual(state.candidates[0].status, .draft)
        XCTAssertTrue(state.confirmedCandidates.isEmpty)
        // Draft candidates still show up for review; only dismissal hides them.
        XCTAssertEqual(state.visibleCandidates.count, 1)
    }

    // MARK: - Batches

    func testOperationsApplyInOrderWithinASingleBatch() {
        var state = VoiceSessionState()
        state.apply([
            .init(type: .createTask, title: "Buy milk"),
            .init(type: .updateTask, changes: .init(dueText: "Friday")),
            .init(type: .createTask, title: "Call Ana"),
            .init(type: .deleteTask),
        ], idProvider: sequentialIDs())

        XCTAssertEqual(state.candidates.count, 2)
        XCTAssertEqual(state.candidates[0].dueText, "Friday")
        XCTAssertEqual(state.candidates[0].status, .confirmed)
        XCTAssertEqual(state.candidates[1].title, "Call Ana")
        XCTAssertEqual(state.candidates[1].status, .dismissed)
    }
}

final class VoiceDictationClientParsingTests: XCTestCase {
    func testParseOperationsDecodesEachOperationKind() {
        let json = """
        {"operations":[
          {"type":"create_task","title":"Buy milk","dueText":"tomorrow","subtasks":["2%"],"notes":"2% and oat","recurrenceText":"every Monday"},
          {"type":"update_task","targetRef":"milk","changes":{"dueText":"Friday","notes":"updated note","recurrenceText":"weekly"}},
          {"type":"delete_task","targetRef":"all"},
          {"type":"mark_uncertain","targetRef":"task:abc"}
        ]}
        """
        let operations = VoiceDictationClient.parseOperations(from: Data(json.utf8))

        XCTAssertEqual(operations.map(\.type), [.createTask, .updateTask, .deleteTask, .markUncertain])
        XCTAssertEqual(operations[0].subtasks, ["2%"])
        XCTAssertEqual(operations[0].notes, "2% and oat")
        XCTAssertEqual(operations[0].recurrenceText, "every Monday")
        XCTAssertEqual(operations[1].changes?.dueText, "Friday")
        XCTAssertEqual(operations[1].changes?.notes, "updated note")
        XCTAssertEqual(operations[1].changes?.recurrenceText, "weekly")
        XCTAssertEqual(operations[2].targetRef, "all")
    }

    func testParseOperationsToleratesMissingMalformedAndEmptyPayloads() {
        XCTAssertTrue(VoiceDictationClient.parseOperations(from: Data("{}".utf8)).isEmpty)
        XCTAssertTrue(VoiceDictationClient.parseOperations(from: Data("not json".utf8)).isEmpty)
        XCTAssertTrue(VoiceDictationClient.parseOperations(from: Data(#"{"operations":[]}"#.utf8)).isEmpty)
    }

    func testParseFinalTasksDecodesResolvedFields() {
        let json = """
        {"tasks":[{"title":"Buy milk","dueISO":"2026-08-01T09:00:00Z","priority":2,"subtasks":["2%"]}]}
        """
        let tasks = VoiceDictationClient.parseFinalTasks(from: Data(json.utf8))

        XCTAssertEqual(tasks.count, 1)
        XCTAssertEqual(tasks[0].title, "Buy milk")
        XCTAssertEqual(tasks[0].dueISO, "2026-08-01T09:00:00Z")
        XCTAssertEqual(tasks[0].priority, 2)
        XCTAssertEqual(tasks[0].subtasks, ["2%"])
    }

    /// A blank title would create an untitled, unrecoverable task, so those are dropped rather
    /// than surfaced.
    func testParseFinalTasksDecodesRecurrenceRemindersAndPlacement() {
        let json = """
        {"tasks":[{
          "title":"Trash night",
          "dueISO":"2026-08-03T21:00:00Z",
          "columnId":"col-2",
          "notes":"Bins go out before 9",
          "priority":3,
          "reminderMinutesBeforeDue":[15,60],
          "reminderTime":"09:00",
          "recurrence":{"type":"weekly","days":[1,4]}
        }]}
        """
        let tasks = VoiceDictationClient.parseFinalTasks(from: Data(json.utf8))

        XCTAssertEqual(tasks.count, 1)
        XCTAssertEqual(tasks[0].columnId, "col-2")
        XCTAssertEqual(tasks[0].notes, "Bins go out before 9")
        XCTAssertEqual(tasks[0].reminderMinutesBeforeDue, [15, 60])
        XCTAssertEqual(tasks[0].reminderTime, "09:00")
        XCTAssertEqual(tasks[0].recurrence, .weekly(days: [1, 4]))
    }

    func testWatchDraftPreservesBoardRoutingAndSupportsLegacyCommands() throws {
        let fallback = TaskifyWatchBoard(id: "current", name: "Current", openTaskCount: 0, kind: "week")
        let target = TaskifyWatchBoard(id: "errands", name: "Errands", openTaskCount: 0, kind: "lists")
        let wire = #"{"id":"draft","title":"Buy milk","boardId":"errands","columnId":"shopping"}"#
        let draft = try JSONDecoder().decode(TaskifyWatchVoiceDraft.self, from: Data(wire.utf8))
        let command = TaskifyWatchCommand(kind: .createVoiceTasks, boardID: fallback.id, voiceTasks: [draft])
        let restored = try TaskifyWatchTransfer.decodeCommand(TaskifyWatchTransfer.encode(command))
        let restoredDraft = try XCTUnwrap(restored.voiceTasks?.first)
        XCTAssertEqual(restoredDraft.boardId, target.id)
        XCTAssertEqual(restoredDraft.columnId, "shopping")
        XCTAssertEqual(restoredDraft.destinationBoard(in: [fallback, target], fallback: fallback), target)
        XCTAssertEqual(restoredDraft.destinationBoard(in: [fallback], fallback: fallback), fallback)

        let legacy = try JSONDecoder().decode(TaskifyWatchVoiceDraft.self, from: Data(#"{"id":"old","title":"Legacy"}"#.utf8))
        XCTAssertNil(legacy.boardId)
        XCTAssertEqual(legacy.destinationBoard(in: [fallback, target], fallback: fallback), fallback)
    }

    func testVoiceRecurrenceWireShapeMatchesWorkerAndPWA() throws {
        let json = #"{"type":"every","n":2,"unit":"week"}"#
        let decoded = try JSONDecoder().decode(VoiceRecurrence.self, from: Data(json.utf8))
        XCTAssertEqual(decoded, .every(count: 2, unit: "week"))
        XCTAssertEqual(decoded.taskRecurrence, .every(2, .week))

        let encodedData = try JSONEncoder().encode(VoiceRecurrence.weekly(days: [1, 4]))
        let encodedObject = try XCTUnwrap(JSONSerialization.jsonObject(with: encodedData) as? [String: Any])
        XCTAssertEqual(encodedObject["type"] as? String, "weekly")
        XCTAssertEqual(encodedObject["days"] as? [Int], [1, 4])
    }

    func testCandidatesEncodeNotesAndRecurrenceText() throws {
        let candidate = VoiceTaskCandidate(
            title: "Buy milk",
            notes: "2% and oat",
            recurrenceText: "every Monday"
        )
        let data = try JSONEncoder().encode(candidate)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(object["notes"] as? String, "2% and oat")
        XCTAssertEqual(object["recurrenceText"] as? String, "every Monday")
    }

    /// Invalid model output must not crash the save; it simply produces no
    /// recurrence rule so the task saves as a one-off.
    func testVoiceRecurrenceMapsToTaskRecurrence() {
        XCTAssertNil(VoiceRecurrence.none.taskRecurrence)
        XCTAssertEqual(VoiceRecurrence.daily.taskRecurrence, .daily())
        XCTAssertEqual(VoiceRecurrence.weekly(days: [1, 4, 9]).taskRecurrence, .weekly(days: [1, 4]))
        XCTAssertNil(VoiceRecurrence.weekly(days: []).taskRecurrence)
        XCTAssertEqual(VoiceRecurrence.every(count: 3, unit: "day").taskRecurrence, .every(3, .day))
        XCTAssertNil(VoiceRecurrence.every(count: 0, unit: "day").taskRecurrence)
        XCTAssertEqual(VoiceRecurrence.monthlyDay(day: 15, interval: 2).taskRecurrence, .monthlyDay(day: 15, interval: 2))
        XCTAssertNil(VoiceRecurrence.monthlyDay(day: 0, interval: nil).taskRecurrence)
    }

    func testParseFinalTasksDropsBlankTitles() {
        let json = #"{"tasks":[{"title":"  "},{"title":"Real task"}]}"#
        let tasks = VoiceDictationClient.parseFinalTasks(from: Data(json.utf8))

        XCTAssertEqual(tasks.map(\.title), ["Real task"])
    }

    func testCandidatesEncodeWithTheWorkersFieldNames() throws {
        let candidate = VoiceTaskCandidate(
            id: "c1",
            title: "Buy milk",
            dueText: "tomorrow",
            boardId: "board-1",
            subtasks: ["2%"],
            status: .confirmed
        )
        let data = try JSONEncoder().encode(candidate)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(object["id"] as? String, "c1")
        XCTAssertEqual(object["dueText"] as? String, "tomorrow")
        XCTAssertEqual(object["boardId"] as? String, "board-1")
        XCTAssertEqual(object["status"] as? String, "confirmed")
    }
}
