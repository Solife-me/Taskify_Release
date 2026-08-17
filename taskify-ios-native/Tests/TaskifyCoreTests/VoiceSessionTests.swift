import Foundation
import XCTest
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
          {"type":"create_task","title":"Buy milk","dueText":"tomorrow","subtasks":["2%"]},
          {"type":"update_task","targetRef":"milk","changes":{"dueText":"Friday"}},
          {"type":"delete_task","targetRef":"all"},
          {"type":"mark_uncertain","targetRef":"task:abc"}
        ]}
        """
        let operations = VoiceDictationClient.parseOperations(from: Data(json.utf8))

        XCTAssertEqual(operations.map(\.type), [.createTask, .updateTask, .deleteTask, .markUncertain])
        XCTAssertEqual(operations[0].subtasks, ["2%"])
        XCTAssertEqual(operations[1].changes?.dueText, "Friday")
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
