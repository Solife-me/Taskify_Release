import Foundation
import Testing
@testable import TaskifyCore

private struct BoardPrintContractVectors: Decodable {
    struct Job: Decodable {
        let id: String
        let hash32: UInt32
        let code: Int
        let pattern: [Int]
    }
    let version: String
    let maxPages: Int
    let jobs: [Job]
    let pagePatterns: [[Int]]
}

private let boardPrintVectorsURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .appendingPathComponent("taskify-core/fixtures/board-print-contract-vectors.json")

@Test func boardPrintContractMatchesSharedTypeScriptVectors() throws {
    let vectors = try JSONDecoder().decode(
        BoardPrintContractVectors.self,
        from: Data(contentsOf: boardPrintVectorsURL)
    )
    #expect(BoardPrintContract.version == vectors.version)
    #expect(BoardPrintContract.maxPages == vectors.maxPages)
    for job in vectors.jobs {
        #expect(BoardPrintContract.hash32(job.id) == job.hash32)
        #expect(BoardPrintContract.jobCode(jobID: job.id) == job.code)
        #expect(BoardPrintContract.jobCodePattern(jobID: job.id) == job.pattern)
    }
    #expect(BoardPrintContract.pagePattern(pageIndex: 0) == vectors.pagePatterns[0])
    #expect(BoardPrintContract.pagePattern(pageIndex: 4) == vectors.pagePatterns[4])
    #expect(BoardPrintContract.pagePattern(pageIndex: 62) == vectors.pagePatterns[62])
}

@Test func boardPrintContractKeepsSafeLegacyVersionsReadable() {
    #expect(BoardPrintContract.isSupportedVersion("v3"))
    #expect(BoardPrintContract.isSupportedVersion("v2"))
    #expect(BoardPrintContract.isSupportedVersion("v1"))
    #expect(!BoardPrintContract.isSupportedVersion("v4"))
}

@Test func encryptedPrintManifestUsesCrossClientKeysAndNewestOwnerWins() throws {
    let old = PhysicalChecklistJob(
        id: "old", ownerID: "board:shared", title: "Board",
        createdAt: Date(timeIntervalSince1970: 10),
        items: [PhysicalChecklistItem(id: "task-1", title: "First")]
    )
    let new = PhysicalChecklistJob(
        id: "new", ownerID: "board:shared", title: "Board",
        createdAt: Date(timeIntervalSince1970: 20), paper: .a4,
        items: [PhysicalChecklistItem(id: "task-2", title: "Second", section: "Today")]
    )
    let merged = NostrPrintJobManifest.merged(
        remote: [NostrPrintJobManifest(job: old)],
        local: [NostrPrintJobManifest(job: new)]
    )
    #expect(merged.map(\.id) == ["new"])
    #expect(merged.first?.job == new)
    let json = String(decoding: try JSONEncoder().encode(merged[0]), as: UTF8.self)
    #expect(json.contains("\"ownerId\":\"board:shared\""))
    #expect(json.contains("\"createdAt\":20"))
}
