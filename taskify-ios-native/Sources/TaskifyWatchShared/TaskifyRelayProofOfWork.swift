import Foundation

public enum TaskifyProofOfWorkError: LocalizedError {
    case unsupportedDifficulty, timedOut
    public var errorDescription: String? {
        switch self {
        case .unsupportedDifficulty: "The relay requires an unsupported proof-of-work difficulty."
        case .timedOut: "Preparing relay proof of work timed out."
        }
    }
}

/// The scope is entered on a background task, before any event IDs are retained.
public enum TaskifyRelayProofOfWork {
    @TaskLocal public static var difficulty = 0

    public static func leadingZeroBits(_ id: String) -> Int {
        guard id.utf8.count == 64 else { return 0 }
        var result = 0
        for character in id {
            guard let digit = character.hexDigitValue else { return 0 }
            if digit == 0 { result += 4 }
            else { return result + digit.leadingZeroBitCount - (Int.bitWidth - 4) }
        }
        return result
    }

    public static func mineTags(_ tags: [[String]], hash: ([[String]]) throws -> String) throws -> [[String]] {
        let target = difficulty
        guard target > 0 else { return tags }
        guard target <= 32 else { throw TaskifyProofOfWorkError.unsupportedDifficulty }
        let deadline = ProcessInfo.processInfo.systemUptime + 30
        var result = tags.filter { $0.first != "nonce" }
        result.append(["nonce", "0", String(target)])
        let index = result.count - 1
        var nonce: UInt64 = 0
        while true {
            if nonce % 128 == 0 {
                try Task.checkCancellation()
                guard ProcessInfo.processInfo.systemUptime < deadline else { throw TaskifyProofOfWorkError.timedOut }
            }
            result[index][1] = String(nonce)
            if leadingZeroBits(try hash(result)) >= target { return result }
            nonce += 1
        }
    }

    public static func prepare<T: Sendable>(relays: [String], operation: @escaping @Sendable () throws -> T) async throws -> T {
        let target = await TaskifyRelayRequirements.shared.difficulty(for: relays)
        try Task.checkCancellation()
        let work = Task.detached(priority: .utility) {
            try $difficulty.withValue(target) { try operation() }
        }
        return try await withTaskCancellationHandler { try await work.value } onCancel: { work.cancel() }
    }
}

public actor TaskifyRelayRequirements {
    public static let shared = TaskifyRelayRequirements()
    private struct Entry { let difficulty: Int; let expiresAt: Date }
    private var cache: [String: Entry] = [:]
    private var pending: [String: Task<Entry, Never>] = [:]

    public func difficulty(for relays: [String]) async -> Int {
        await withTaskGroup(of: Int.self) { group in
            var remaining = Array(Set(relays)).makeIterator()
            for _ in 0..<4 {
                if let relay = remaining.next() { group.addTask { await self.requirement(relay) } }
            }
            var result = 0
            for await difficulty in group {
                result = max(result, difficulty)
                if let relay = remaining.next() { group.addTask { await self.requirement(relay) } }
            }
            return result
        }
    }

    private func requirement(_ relay: String) async -> Int {
        guard var components = URLComponents(string: relay), let scheme = components.scheme,
              ["wss", "ws"].contains(scheme), components.host != nil else { return 0 }
        components.scheme = scheme == "wss" ? "https" : "http"
        guard let url = components.url else { return 0 }
        let key = url.absoluteString
        if let entry = cache[key], entry.expiresAt > Date() { return entry.difficulty }
        if let task = pending[key] { return await task.value.difficulty }
        let task = Task<Entry, Never> {
            do {
                var request = URLRequest(url: url, timeoutInterval: 5)
                request.setValue("application/nostr+json", forHTTPHeaderField: "Accept")
                let (data, response) = try await URLSession.shared.data(for: request)
                guard (response as? HTTPURLResponse)?.statusCode == 200, data.count <= 1_048_576,
                      let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    return Entry(difficulty: 0, expiresAt: Date().addingTimeInterval(300))
                }
                let limitation = json["limitation"] as? [String: Any]
                let target = (limitation?["min_pow_difficulty"] as? NSNumber)?.doubleValue ?? 0
                let difficulty = target.isFinite && target > 0 ? Int(min(256, ceil(target))) : 0
                return Entry(difficulty: difficulty, expiresAt: Date().addingTimeInterval(43_200))
            } catch { return Entry(difficulty: 0, expiresAt: Date().addingTimeInterval(300)) }
        }
        pending[key] = task
        let entry = await task.value
        pending[key] = nil
        if cache.count >= 256, let oldest = cache.min(by: { $0.value.expiresAt < $1.value.expiresAt })?.key { cache[oldest] = nil }
        cache[key] = entry
        return entry.difficulty
    }
}
