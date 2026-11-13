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

/// The difficulty a relay states when it refuses an event for too little proof of work.
public enum TaskifyProofOfWorkRejection {
    /// NIP-01's `pow:` refusal, e.g. khatru's "pow: difficulty 8 is less than 20". Some relays
    /// enforce proof of work in a write policy without advertising `min_pow_difficulty` in their
    /// NIP-11 document, so the refusal is the only statement of the floor they actually apply.
    public static func difficulty(fromMessage message: String) -> Int? {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard text.hasPrefix("pow:") else { return nil }
        return text
            .split(whereSeparator: { !$0.isNumber })
            .compactMap { Int($0) }
            .filter { $0 > 0 }
            .max()
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
    private struct Entry: Codable { let difficulty: Int; let expiresAt: Date }
    private static let advertisedLifetime: TimeInterval = 43_200
    private static let failureLifetime: TimeInterval = 300
    /// A refuse-and-remember lasts a week, matching how long a relay's write policy is likely to
    /// stand. Re-learning costs one refused event, so it need not be eternal.
    private static let learnedLifetime: TimeInterval = 7 * 24 * 3_600
    /// Difficulties above this take hours on a client; a relay asking for more cannot be met, so
    /// it must not be remembered as an up-front target.
    private static let maximumDifficulty = 32
    private var cache: [String: Entry] = [:]
    private var pending: [String: Task<Entry, Never>] = [:]
    /// Floors a relay stated in a `pow:` refusal. Remembered so later events are mined to them
    /// before they are offered, instead of being refused and re-mined one at a time.
    private var learned: [String: Entry] = [:]

    private static let learnedURL: URL? = {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("TaskifyNative", isDirectory: true)
            .appendingPathComponent("relay-requirements.json", isDirectory: false)
    }()

    init() {
        guard let url = Self.learnedURL,
              let data = try? Data(contentsOf: url),
              let stored = try? JSONDecoder().decode([String: Entry].self, from: data) else { return }
        let now = Date()
        learned = stored.filter { $0.value.expiresAt > now }
    }

    /// Remembers the floor a relay stated in a refusal. It is the requirement the relay actually
    /// enforces, which NIP-11 does not always advertise; the next event is mined to it up front.
    public func record(difficulty: Int, for relay: String) {
        guard difficulty > 0, difficulty <= Self.maximumDifficulty,
              let key = Self.normalizedKey(relay) else { return }
        let now = Date()
        let known = learned[key].flatMap { $0.expiresAt > now ? $0.difficulty : nil } ?? 0
        learned[key] = Entry(
            difficulty: max(difficulty, known),
            expiresAt: now.addingTimeInterval(Self.learnedLifetime)
        )
        persistLearned()
    }

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
        guard let key = Self.normalizedKey(relay), let url = Self.advertisedURL(for: relay) else { return 0 }
        let now = Date()
        if let entry = cache[key], entry.expiresAt > now {
            return max(entry.difficulty, learnedFloor(key, now: now))
        }
        if let task = pending[key] {
            return max(await task.value.difficulty, learnedFloor(key, now: now))
        }
        let task = Task<Entry, Never> {
            do {
                var request = URLRequest(url: url, timeoutInterval: 5)
                request.setValue("application/nostr+json", forHTTPHeaderField: "Accept")
                let (data, response) = try await URLSession.shared.data(for: request)
                guard (response as? HTTPURLResponse)?.statusCode == 200, data.count <= 1_048_576,
                      let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    return Entry(difficulty: 0, expiresAt: Date().addingTimeInterval(Self.failureLifetime))
                }
                let limitation = json["limitation"] as? [String: Any]
                let target = (limitation?["min_pow_difficulty"] as? NSNumber)?.doubleValue ?? 0
                let difficulty = target.isFinite && target > 0 ? Int(min(256, ceil(target))) : 0
                return Entry(difficulty: difficulty, expiresAt: Date().addingTimeInterval(Self.advertisedLifetime))
            } catch { return Entry(difficulty: 0, expiresAt: Date().addingTimeInterval(Self.failureLifetime)) }
        }
        pending[key] = task
        let entry = await task.value
        pending[key] = nil
        if cache.count >= 256, let oldest = cache.min(by: { $0.value.expiresAt < $1.value.expiresAt })?.key { cache[oldest] = nil }
        cache[key] = entry
        return max(entry.difficulty, learnedFloor(key, now: now))
    }

    private func learnedFloor(_ key: String, now: Date) -> Int {
        guard let entry = learned[key] else { return 0 }
        guard entry.expiresAt > now else {
            learned[key] = nil
            return 0
        }
        return entry.difficulty
    }

    private func persistLearned() {
        guard let url = Self.learnedURL else { return }
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try JSONEncoder().encode(learned).write(to: url, options: .atomic)
        } catch {
            // A requirement that cannot be saved is still honored for this run.
        }
    }

    private static func normalizedKey(_ relay: String) -> String? {
        advertisedURL(for: relay)?.absoluteString
    }

    private static func advertisedURL(for relay: String) -> URL? {
        guard var components = URLComponents(string: relay), let scheme = components.scheme,
              ["wss", "ws"].contains(scheme), components.host != nil else { return nil }
        components.scheme = scheme == "wss" ? "https" : "http"
        return components.url
    }
}
