import XCTest
@testable import TaskifyCore

final class RelayRetryBackoffTests: XCTestCase {
    func testSlowConsumerBackpressuresIngressWithoutLosingMessages() async throws {
        let buffer = NostrRelayMessageBuffer()
        let completed = BufferProducerProgress()
        let producer = Task {
            for index in 0..<1_000 {
                await buffer.send(.notice(String(index)))
                await completed.record()
            }
            buffer.finish()
        }
        defer { producer.cancel() }
        try await Task.sleep(for: .milliseconds(150))
        let queued = await completed.count
        XCTAssertLessThanOrEqual(queued, 64, "A history replay must not accumulate unbounded decoded events")
        var received: [String] = []
        for await message in buffer.stream {
            if case .notice(let value) = message { received.append(value) }
        }
        await producer.value
        XCTAssertEqual(received, (0..<1_000).map(String.init))
    }

    func testFullIngressBufferCanBeCancelledWithoutAConsumer() async {
        let buffer = NostrRelayMessageBuffer()
        for _ in 0..<64 { await buffer.send(.notice("queued")) }
        let stopped = expectation(description: "blocked producer stops")
        let producer = Task {
            await buffer.send(.notice("waiting"))
            stopped.fulfill()
        }
        await Task.yield()
        producer.cancel()
        await fulfillment(of: [stopped], timeout: 1)
        buffer.finish()
    }

    func testFinishingFullIngressBufferReleasesProducer() async {
        let buffer = NostrRelayMessageBuffer()
        for _ in 0..<64 { await buffer.send(.notice("queued")) }
        let stopped = expectation(description: "finished buffer releases producer")
        let producer = Task {
            await buffer.send(.notice("waiting"))
            stopped.fulfill()
        }
        defer { producer.cancel() }
        await Task.yield()
        buffer.finish()
        await fulfillment(of: [stopped], timeout: 1)
    }

    func testPersistentFailureBacksOffInsteadOfRetryingEverySecond() {
        var backoff = RelayRetryBackoff()
        let delays = (0..<10).map { _ in backoff.nextDelay() }
        XCTAssertEqual(delays, [1, 2, 4, 8, 16, 30, 30, 30, 30, 30])
    }

    func testLongOutageStaysBoundedAndFreshConnectionCanRetryPromptly() {
        var backoff = RelayRetryBackoff()
        for _ in 0..<10_000 {
            let delay = backoff.nextDelay()
            XCTAssertTrue((1...30).contains(delay))
        }
        XCTAssertEqual(backoff.nextDelay(), 30)
        // The engine discards this state only on a relay response or an explicit retry.
        backoff = RelayRetryBackoff()
        XCTAssertEqual(backoff.nextDelay(), 1)
    }
}

private actor BufferProducerProgress {
    private(set) var count = 0
    func record() { count += 1 }
}
