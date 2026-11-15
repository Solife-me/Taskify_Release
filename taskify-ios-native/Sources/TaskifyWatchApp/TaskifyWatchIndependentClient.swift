import Foundation
import TaskifyWatchShared

struct TaskifyWatchIndependentProfile: Codable, Equatable, Sendable {
    let publicKeyHex: String
    let publicKeyNpub: String
    let relayURLs: [String]
}

enum TaskifyWatchIndependentError: LocalizedError {
    case accountUnavailable
    case serviceUnavailable
    case relayUnavailable
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .accountUnavailable: "Independent Watch sync needs to be authorized again on iPhone."
        case .serviceUnavailable: "Taskify's Watch service is unavailable right now."
        case .relayUnavailable: "No configured Nostr relay accepted the Watch update yet."
        case .invalidResponse: "Taskify received an invalid Watch sync response."
        }
    }
}

struct TaskifyWatchPublishPlan {
    private let requirements: TaskifyRelayRequirements
    private var floors: [String: Int] = [:]
    let relays: [String]

    init(relays: [String], requirements: TaskifyRelayRequirements) async {
        self.relays = relays
        self.requirements = requirements
        for relay in relays { floors[relay] = await requirements.knownDifficulty(for: relay) }
    }

    var ordinary: [String] { relays.filter { floors[$0, default: 0] == 0 } }

    mutating func learn(results: [TaskifyWatchGatewayRelayResult], event: TaskifyWatchNostrEvent) async {
        for result in results where result.status != "accepted" {
            guard let url = TaskifyWatchRelayRouting.normalizedRelayURLs([result.relay]).first,
                  let relay = relays.first(where: { TaskifyWatchRelayRouting.normalizedRelayURLs([$0]).first == url }),
                  let difficulty = result.message.flatMap(TaskifyProofOfWorkRejection.difficulty(fromMessage:)),
                  difficulty <= 32,
                  !TaskifyRelayProofOfWork.satisfies(id: event.id, tags: event.tags, difficulty: difficulty) else { continue }
            floors[relay] = max(floors[relay, default: 0], difficulty)
            await requirements.record(difficulty: difficulty, for: relay)
        }
    }

    mutating func refreshUnaccepted(_ accepted: Set<String>) async {
        let pending = ordinary.filter { !accepted.contains($0) }
        await withTaskGroup(of: (String, Int).self) { group in
            for relay in pending {
                let requirements = self.requirements
                group.addTask { (relay, await requirements.difficulty(for: [relay])) }
            }
            for await (relay, difficulty) in group { floors[relay] = difficulty }
        }
    }

    func strict(excluding accepted: Set<String>) -> (relays: [String], difficulty: Int) {
        let targets = relays.filter { !accepted.contains($0) && floors[$0, default: 0] > 0 }
        return (targets, targets.compactMap { floors[$0] }.max() ?? 0)
    }

    mutating func deliver(
        _ event: TaskifyWatchNostrEvent,
        prepare: (Int) async throws -> TaskifyWatchNostrEvent,
        submit: (TaskifyWatchNostrEvent, [String]) async throws -> [TaskifyWatchGatewayRelayResult]
    ) async throws -> TaskifyWatchNostrEvent? {
        var accepted: Set<String> = []
        var acceptedEvent: TaskifyWatchNostrEvent?
        if !ordinary.isEmpty {
            let results = try await submit(event, ordinary)
            accepted.formUnion(TaskifyWatchRelayRouting.normalizedRelayURLs(results.filter { $0.status == "accepted" }.map(\.relay)))
            if !accepted.isEmpty { acceptedEvent = event }
            await learn(results: results, event: event)
            await refreshUnaccepted(accepted)
        }
        var strict = strict(excluding: accepted)
        for _ in 0..<2 where strict.difficulty > 0 {
            do {
                let mined = try await prepare(strict.difficulty)
                let results = try await submit(mined, strict.relays)
                let newlyAccepted = TaskifyWatchRelayRouting.normalizedRelayURLs(results.filter { $0.status == "accepted" }.map(\.relay))
                accepted.formUnion(newlyAccepted)
                if !newlyAccepted.isEmpty && acceptedEvent == nil { acceptedEvent = mined }
                await learn(results: results, event: mined)
                let next = self.strict(excluding: accepted)
                guard next.difficulty > strict.difficulty else { break }
                strict = next
            } catch {
                if acceptedEvent == nil || Task.isCancelled { throw error }
                break
            }
        }
        return acceptedEvent
    }

}

/// High-level HTTPS transport for an independent watchOS app. The bridge receives only signed,
/// board-encrypted Nostr events and cannot decrypt them; all keys and event construction stay on
/// Apple Watch. This avoids making unsupported persistent relay WebSockets the Watch's data path.
struct TaskifyWatchIndependentClient: Sendable {
    static let defaultBaseURL = URL(string: "https://taskify.solife.me")!

    private let fallbackBaseURL: URL
    private let session: URLSession
    private let requirements: TaskifyRelayRequirements

    init(baseURL: URL = Self.defaultBaseURL, session: URLSession = .shared,
         requirements: TaskifyRelayRequirements = .shared) {
        self.fallbackBaseURL = baseURL
        self.session = session
        self.requirements = requirements
    }

    @discardableResult
    func publish(
        _ event: TaskifyWatchNostrEvent,
        relayURLs: [String],
        boardID: String,
        gatewayBaseURL: URL?,
        profile: TaskifyWatchIndependentProfile,
        privateKey: Data
    ) async throws -> TaskifyWatchNostrEvent {
        // Watch traffic uses shared server IPs. The iPhone fans the durable board command out
        // to public relays from its own connection.
        let targets = TaskifyFirstPartyRelays.watchPublishTargets(boardRelayURLs: relayURLs)
        var plan = await TaskifyWatchPublishPlan(relays: targets, requirements: requirements)
        let delivered = try await plan.deliver(event, prepare: { difficulty in
            try await TaskifyWatchNostrCrypto.prepareBoardEvent(event, boardID: boardID, difficulty: difficulty)
        }, submit: { wireEvent, relays in
            try await submitTaskEvent(wireEvent, relays: relays, boardID: boardID,
                gatewayBaseURL: gatewayBaseURL, profile: profile, privateKey: privateKey)
        })
        guard let delivered else { throw TaskifyWatchIndependentError.relayUnavailable }
        return delivered
    }

    private func submitTaskEvent(
        _ event: TaskifyWatchNostrEvent, relays: [String], boardID: String, gatewayBaseURL: URL?,
        profile: TaskifyWatchIndependentProfile, privateKey: Data
    ) async throws -> [TaskifyWatchGatewayRelayResult] {
        if let gatewayBaseURL {
            do {
                return try await publishThroughGateway(event, relayURLs: relays, boardID: boardID,
                    gatewayBaseURL: gatewayBaseURL, privateKey: privateKey)
            } catch {
                if Task.isCancelled { throw CancellationError() }
                // Only Taskify's own gateway may fall back to the legacy Taskify Worker.
                guard Self.allowsWorkerFallback(after: gatewayBaseURL) else { throw error }
            }
        }

        struct Body: Encodable {
            let relays: [String]
            let event: TaskifyWatchNostrEvent
        }
        struct Reply: Decodable {
            struct Result: Decodable { let relay: String; let accepted: Bool; let message: String? }
            let accepted: Int
            let results: [Result]?
        }
        let reply: Reply = try await authenticatedPost(path: "api/watch/nostr/publish",
            body: Body(relays: relays, event: event), profile: profile, privateKey: privateKey,
            acceptsRelayFailureBody: true)
        return reply.results?.map {
            TaskifyWatchGatewayRelayResult(relay: $0.relay, status: $0.accepted ? "accepted" : "rejected",
                message: $0.message, session: nil, challenge: nil)
        } ?? relays.prefix(reply.accepted).map {
            TaskifyWatchGatewayRelayResult(relay: $0, status: "accepted", message: nil, session: nil, challenge: nil)
        }
    }

    func fetchTasks(
        boards: [TaskifyWatchBoard],
        gatewayBaseURL: URL?,
        profile: TaskifyWatchIndependentProfile,
        privateKey: Data
    ) async throws -> [TaskifyWatchNostrEvent] {
        struct Filter: Encodable {
            let kinds: [Int]
            let authors: [String]
            let boardTags: [String]
            let limit: Int

            enum CodingKeys: String, CodingKey {
                case kinds
                case authors
                case boardTags = "#b"
                case limit
            }
        }
        struct Body: Encodable {
            let relays: [String]
            let filter: Filter
        }
        struct Reply: Decodable { let events: [TaskifyWatchNostrEvent] }

        let usableBoards = boards.compactMap {
            board -> (boardID: String, author: String, boardTag: String, relays: [String])? in
            guard let boardID = board.nostrBoardID,
                  let author = try? TaskifyWatchNostrCrypto.boardPublicKeyHex(for: boardID) else {
                return nil
            }
            return (
                boardID,
                author,
                TaskifyWatchNostrCrypto.boardTag(for: boardID),
                board.relayURLs ?? []
            )
        }
        let authors = Array(Set(usableBoards.map(\.author))).sorted()
        let boardTags = Array(Set(usableBoards.map(\.boardTag))).sorted()
        // Include Taskify's relay: Watch changes are published there first and only reach the
        // board's other relays once the phone republishes them.
        let relays = normalizedRelays(
            usableBoards.flatMap(\.relays) + profile.relayURLs + [TaskifyFirstPartyRelays.relayURL]
        )
        guard !authors.isEmpty, !relays.isEmpty else {
            throw TaskifyWatchIndependentError.accountUnavailable
        }
        if let gatewayBaseURL {
            do {
                return try await fetchCachedTasks(
                    boards: usableBoards,
                    relayURLs: relays,
                    gatewayBaseURL: gatewayBaseURL,
                    profile: profile,
                    privateKey: privateKey
                )
            } catch {
                if Task.isCancelled { throw CancellationError() }
                // A self-hoster chose this gateway as the task service. Never copy its signed
                // request and board list to Taskify's Worker when that service is unavailable.
                guard Self.allowsWorkerFallback(after: gatewayBaseURL) else { throw error }
                // Keep the old Worker path only as a temporary failover for Taskify's gateway.
            }
        }
        let reply: Reply = try await authenticatedPost(
            path: "api/watch/nostr/query",
            body: Body(
                relays: relays,
                filter: Filter(
                    kinds: [
                        TaskifyWatchNostrCrypto.boardEventKind,
                        TaskifyWatchNostrCrypto.taskEventKind,
                    ],
                    authors: authors,
                    boardTags: boardTags,
                    limit: 1_000
                )
            ),
            profile: profile,
            privateKey: privateKey
        )
        return reply.events
    }

    struct TaskHistoryResult: Sendable {
        var events: [TaskifyWatchNostrEvent]
        var cursors: [String: TaskifyWatchTaskHistoryCursor]
        var completed: Bool
        var receivedPage: Bool
    }

    private struct TaskHistorySource: Sendable {
        let boardID: String
        let author: String
        let boardTag: String
        let relay: String?

        var key: String { boardTag + "|" + (relay ?? "") }
    }

    private struct TaskHistoryPage: Decodable {
        let events: [TaskifyWatchNostrEvent]
        let historyPage: Bool?
        let refreshed: Bool?
        let authorizations: [TaskifyWatchGatewayRelayResult]?
    }

    /// Page independent sources in rotation. Each source has its own inclusive timestamp
    /// boundary so recent activity on other boards cannot crowd out older events.
    func recoverTaskHistory(
        boards: [TaskifyWatchBoard],
        gatewayBaseURL: URL?,
        profile: TaskifyWatchIndependentProfile,
        privateKey: Data,
        previous: [String: TaskifyWatchTaskHistoryCursor] = [:],
        pageBudget: Int = 24,
        now: Date = Date()
    ) async throws -> TaskHistoryResult {
        let pageSize = 100
        let maxPageSize = 1_000
        let stamp = Int(now.timeIntervalSince1970)
        let gatewayKey = gatewayBaseURL?.absoluteString ?? fallbackBaseURL.absoluteString
        var sources: [String: TaskHistorySource] = [:]
        for board in boards {
            guard let boardID = board.nostrBoardID,
                  let author = try? TaskifyWatchNostrCrypto.boardPublicKeyHex(for: boardID) else { continue }
            let boardTag = TaskifyWatchNostrCrypto.boardTag(for: boardID)
            let relayURLs = normalizedRelays(
                ((board.relayURLs?.isEmpty == false ? board.relayURLs : nil) ?? profile.relayURLs)
                    + [TaskifyFirstPartyRelays.relayURL]
            )
            var targets: [String?] = relayURLs.map(Optional.some)
            if gatewayBaseURL != nil { targets.insert(nil, at: 0) }
            for relay in targets {
                let source = TaskHistorySource(boardID: boardID, author: author, boardTag: boardTag, relay: relay)
                sources[gatewayKey + "|" + source.key] = source
            }
        }

        var cursors = previous.filter { sources[$0.key] != nil }
        let ordered = sources.keys.sorted {
            let lhs = previous[$0]?.lastAttemptAt ?? .distantPast
            let rhs = previous[$1]?.lastAttemptAt ?? .distantPast
            return lhs == rhs ? $0 < $1 : lhs < rhs
        }
        var pending: [String] = []
        for key in ordered {
            let old = cursors[key]
            if old?.finished == true, let old, stamp < old.startedAt + 60 { continue }
            if old == nil || old?.finished == true {
                let since = old.map { max(0, min($0.startedAt, stamp) - 300) } ?? 0
                cursors[key] = TaskifyWatchTaskHistoryCursor(since: since, until: stamp + 60, startedAt: stamp, limit: pageSize)
            }
            pending.append(key)
        }

        var accepted: [String: TaskifyWatchNostrEvent] = [:]
        var receivedPage = pending.isEmpty
        var needsLegacyRead = false
        let deadline = ContinuousClock.now + .seconds(20)
        for _ in 0..<max(0, pageBudget) {
            try Task.checkCancellation()
            guard !pending.isEmpty, ContinuousClock.now < deadline else { break }
            let key = pending.removeFirst()
            guard let source = sources[key], var cursor = cursors[key] else { continue }
            cursor.lastAttemptAt = Date()
            defer { cursors[key] = cursor }
            do {
                let page = try await taskHistoryPage(
                    source: source, cursor: cursor, gatewayBaseURL: gatewayBaseURL,
                    profile: profile, privateKey: privateKey
                )
                receivedPage = true
                needsLegacyRead = needsLegacyRead || (source.relay != nil && page.historyPage != true)
                let events = page.events.filter {
                    ($0.kind == TaskifyWatchNostrCrypto.taskEventKind || $0.kind == TaskifyWatchNostrCrypto.boardEventKind)
                        && $0.publicKey == source.author && $0.firstTagValue(named: "b") == source.boardTag
                        && (cursor.since...cursor.until).contains($0.createdAt) && TaskifyWatchNostrCrypto.verify($0)
                }
                // Keep just the winning version of each address across all pages in this pass.
                for event in events {
                    guard let address = event.firstTagValue(named: "d") else { continue }
                    let addressKey = "\(event.kind)|\(event.publicKey)|\(address)"
                    if let existing = accepted[addressKey],
                       !TaskifyWatchRelayVersion(event).wins(over: TaskifyWatchRelayVersion(existing)) { continue }
                    accepted[addressKey] = event
                }
                guard page.historyPage == true, page.refreshed == true,
                      events.count == page.events.count, events.count <= cursor.limit else { continue }
                guard let oldest = events.map(\.createdAt).min() else {
                    cursor.finished = true
                    continue
                }
                if oldest < cursor.until {
                    cursor.until = oldest
                    cursor.limit = pageSize
                } else if events.count >= cursor.limit {
                    guard cursor.limit < maxPageSize else { continue }
                    cursor.limit = min(maxPageSize, cursor.limit * 2)
                } else if oldest == cursor.since {
                    cursor.finished = true
                    continue
                } else {
                    cursor.until = oldest - 1
                    cursor.limit = pageSize
                }
                pending.append(key)
            } catch {
                try Task.checkCancellation()
                // Leave the previous bound intact; other boards can still make progress.
            }
        }

        try Task.checkCancellation()
        // Older hosted or self-hosted bridges can still supply their recent snapshot while
        // their history route is rolling out. It cannot establish a history checkpoint.
        if needsLegacyRead, ContinuousClock.now < deadline,
           let recent = try? await fetchTasks(boards: boards, gatewayBaseURL: gatewayBaseURL,
                                              profile: profile, privateKey: privateKey) {
            let boardTagsByAuthor = Dictionary(sources.values.map { ($0.author, $0.boardTag) },
                                               uniquingKeysWith: { first, _ in first })
            for event in recent {
                guard let tag = boardTagsByAuthor[event.publicKey], event.firstTagValue(named: "b") == tag,
                      let address = event.firstTagValue(named: "d"), TaskifyWatchNostrCrypto.verify(event) else { continue }
                let key = "\(event.kind)|\(event.publicKey)|\(address)"
                if let existing = accepted[key],
                   !TaskifyWatchRelayVersion(event).wins(over: TaskifyWatchRelayVersion(existing)) { continue }
                accepted[key] = event
            }
        }

        return TaskHistoryResult(
            events: Array(accepted.values), cursors: cursors,
            completed: cursors.values.allSatisfy(\.finished), receivedPage: receivedPage
        )
    }

    private func taskHistoryPage(
        source: TaskHistorySource,
        cursor: TaskifyWatchTaskHistoryCursor,
        gatewayBaseURL: URL?,
        profile: TaskifyWatchIndependentProfile,
        privateKey: Data
    ) async throws -> TaskHistoryPage {
        if let gatewayBaseURL {
            do {
                let page = try await gatewayTaskHistoryPage(
                    source: source, cursor: cursor, baseURL: gatewayBaseURL, profile: profile, privateKey: privateKey
                )
                if page.historyPage == true || source.relay == nil || !Self.allowsWorkerFallback(after: gatewayBaseURL) {
                    return page
                }
            } catch {
                try Task.checkCancellation()
                guard source.relay != nil, Self.allowsWorkerFallback(after: gatewayBaseURL) else { throw error }
            }
        }
        guard let relay = source.relay else { throw TaskifyWatchIndependentError.serviceUnavailable }
        struct Filter: Encodable {
            let authors: [String]
            let boardTags: [String]
            let since: Int
            let until: Int
            let limit: Int

            enum CodingKeys: String, CodingKey {
                case authors, since, until, limit
                case boardTags = "#b"
            }
        }
        struct Body: Encodable {
            let relays: [String]
            let filter: Filter
            let history = true
        }
        let filter = Filter(authors: [source.author], boardTags: [source.boardTag],
                            since: cursor.since, until: cursor.until, limit: cursor.limit)
        return try await authenticatedPost(
            path: "api/watch/nostr/query", body: Body(relays: [relay], filter: filter), profile: profile, privateKey: privateKey
        )
    }

    private func gatewayTaskHistoryPage(
        source: TaskHistorySource,
        cursor: TaskifyWatchTaskHistoryCursor,
        baseURL: URL,
        profile: TaskifyWatchIndependentProfile,
        privateKey: Data
    ) async throws -> TaskHistoryPage {
        struct Source: Encodable {
            let author: String
            let boardTag: String
            let proof: TaskifyWatchNostrEvent
        }
        struct Bounds: Encodable {
            let since: Int
            let until: Int
            let cacheOnly: Bool
        }
        struct Body: Encodable {
            let sources: [Source]
            let relays: [String]
            let limit: Int
            let history: Bounds
            let requestNonce = UUID()
        }
        let endpoint = baseURL.appendingPathComponent("v1/watch/tasks/query")
        let proof = try TaskifyWatchNostrCrypto.taskCacheAccessProof(
            boardID: source.boardID, accountPublicKey: profile.publicKeyHex, url: endpoint,
            createdAt: Int(Date().timeIntervalSince1970)
        )
        let body = Body(sources: [Source(author: source.author, boardTag: source.boardTag, proof: proof)],
                        relays: source.relay.map { [$0] } ?? [], limit: cursor.limit,
                        history: Bounds(since: cursor.since, until: cursor.until, cacheOnly: source.relay == nil))
        let page: TaskHistoryPage = try await nip98Post(url: endpoint, body: body, privateKey: privateKey)
        guard let challenge = page.authorizations?.first,
              challenge.relay == source.relay, let token = challenge.session, let nonce = challenge.challenge,
              challenge.status == "auth-required" else { return page }
        struct Authorization: Encodable { let event: TaskifyWatchNostrEvent }
        let event = try TaskifyWatchNostrCrypto.nip42AuthorizationEvent(
            privateKey: privateKey, relayURL: challenge.relay, challenge: nonce
        )
        let reply: TaskifyWatchGatewayAuthorizationResult = try await nip98Post(
            url: baseURL.appendingPathComponent("v1/watch/outbox/\(token)/authorize"),
            body: Authorization(event: event), privateKey: privateKey
        )
        guard reply.result.status == "accepted", let events = reply.events,
              events.count <= cursor.limit else { return page }
        return TaskHistoryPage(events: events, historyPage: page.historyPage, refreshed: true, authorizations: nil)
    }

    private func fetchCachedTasks(
        boards: [(boardID: String, author: String, boardTag: String, relays: [String])],
        relayURLs: [String],
        gatewayBaseURL: URL,
        profile: TaskifyWatchIndependentProfile,
        privateKey: Data
    ) async throws -> [TaskifyWatchNostrEvent] {
        struct Source: Encodable {
            let author: String
            let boardTag: String
            let proof: TaskifyWatchNostrEvent
        }
        struct Body: Encodable {
            let relays: [String]
            let sources: [Source]
            let limit: Int
        }
        struct Reply: Decodable {
            let events: [TaskifyWatchNostrEvent]
            let refreshed: Bool
            let cacheHit: Bool
            let authorizations: [TaskifyWatchGatewayRelayResult]?
        }
        let endpoint = gatewayBaseURL.appendingPathComponent("v1/watch/tasks/query")
        let createdAt = Int(Date().timeIntervalSince1970)
        let uniqueBoards = Dictionary(grouping: boards, by: \.author).compactMap {
            $0.value.first
        }.sorted { $0.author < $1.author }
        let sources = try uniqueBoards.map { board in
            Source(
                author: board.author,
                boardTag: board.boardTag,
                proof: try TaskifyWatchNostrCrypto.taskCacheAccessProof(
                    boardID: board.boardID,
                    accountPublicKey: profile.publicKeyHex,
                    url: endpoint,
                    createdAt: createdAt
                )
            )
        }
        let reply: Reply = try await nip98Post(
            url: endpoint,
            body: Body(relays: relayURLs, sources: sources, limit: 1_000),
            privateKey: privateKey
        )
        var events = reply.events
        var authenticatedRead = false
        for challenge in (reply.authorizations ?? []).prefix(relayURLs.count) {
            guard relayURLs.contains(challenge.relay), let token = challenge.session,
                  let nonce = challenge.challenge, challenge.status == "auth-required" else { continue }
            struct Authorization: Encodable { let event: TaskifyWatchNostrEvent }
            let event = try TaskifyWatchNostrCrypto.nip42AuthorizationEvent(privateKey: privateKey,
                relayURL: challenge.relay, challenge: nonce)
            guard let authorized: TaskifyWatchGatewayAuthorizationResult = try? await nip98Post(
                url: gatewayBaseURL.appendingPathComponent("v1/watch/outbox/\(token)/authorize"),
                body: Authorization(event: event), privateKey: privateKey),
                authorized.result.status == "accepted", let fetched = authorized.events,
                fetched.count <= 1_000 else { continue }
            let valid = fetched.filter { candidate in
                boards.contains { $0.author == candidate.publicKey && $0.boardTag == candidate.firstTagValue(named: "b") }
                    && [TaskifyWatchNostrCrypto.boardEventKind, TaskifyWatchNostrCrypto.taskEventKind].contains(candidate.kind)
                    && TaskifyWatchNostrCrypto.verify(candidate)
            }
            guard valid.count == fetched.count else { continue }
            events.append(contentsOf: valid)
            authenticatedRead = true
        }
        guard reply.refreshed || reply.cacheHit || authenticatedRead else {
            throw TaskifyWatchIndependentError.relayUnavailable
        }
        return Array(Dictionary(events.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }).values.sorted { $0.createdAt > $1.createdAt }.prefix(1_000))
    }

    private func publishThroughGateway(
        _ event: TaskifyWatchNostrEvent,
        relayURLs: [String],
        boardID: String,
        gatewayBaseURL: URL,
        privateKey: Data
    ) async throws -> [TaskifyWatchGatewayRelayResult] {
        struct Body: Encodable {
            let event: TaskifyWatchNostrEvent
            let relays: [String]
        }
        struct Reply: Decodable { let results: [TaskifyWatchGatewayRelayResult] }
        struct AuthorizationBody: Encodable { let event: TaskifyWatchNostrEvent }
        struct AuthorizationReply: Decodable { let result: TaskifyWatchGatewayRelayResult }

        let endpoint = gatewayBaseURL.appendingPathComponent("v1/watch/task-events/publish")
        let reply: Reply = try await nip98Post(
            url: endpoint,
            body: Body(event: event, relays: relayURLs),
            privateKey: privateKey,
            acceptedStatuses: 200...202
        )
        var results = reply.results
        for index in results.indices where results[index].status == "auth-required" {
            let result = results[index]
            guard let sessionID = result.session,
                  let challenge = result.challenge else { continue }
            let authorization = try TaskifyWatchNostrCrypto.nip42BoardAuthorizationEvent(
                boardID: boardID,
                relayURL: result.relay,
                challenge: challenge
            )
            let authorizationURL = gatewayBaseURL.appendingPathComponent(
                "v1/watch/outbox/\(sessionID)/authorize"
            )
            if let authorized: AuthorizationReply = try? await nip98Post(
                url: authorizationURL,
                body: AuthorizationBody(event: authorization),
                privateKey: privateKey
            ) {
                results[index] = authorized.result
            }
        }
        return results
    }

    private func nip98Post<Body: Encodable, Reply: Decodable>(
        url: URL,
        body: Body,
        privateKey: Data,
        acceptedStatuses: ClosedRange<Int> = 200...299
    ) async throws -> Reply {
        guard url.scheme?.lowercased() == "https", url.host != nil else {
            throw TaskifyWatchIndependentError.serviceUnavailable
        }
        let data = try encoded(body)
        var request = URLRequest(url: url, timeoutInterval: 30)
        request.httpMethod = "POST"
        request.httpBody = data
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(
            try TaskifyWatchNostrCrypto.nip98AuthorizationHeader(
                privateKey: privateKey,
                url: url,
                method: "POST",
                body: data
            ),
            forHTTPHeaderField: "Authorization"
        )
        let (responseData, rawResponse) = try await session.data(for: request)
        guard let response = rawResponse as? HTTPURLResponse,
              acceptedStatuses.contains(response.statusCode) else {
            throw TaskifyWatchIndependentError.serviceUnavailable
        }
        guard let reply = try? JSONDecoder().decode(Reply.self, from: responseData) else {
            throw TaskifyWatchIndependentError.invalidResponse
        }
        return reply
    }

    func interpretVoice(
        transcript: String,
        boardID: String,
        boards: [TaskifyWatchVoiceBoardContext],
        profile: TaskifyWatchIndependentProfile,
        privateKey: Data
    ) async throws -> TaskifyWatchVoicePreview {
        let requestID = UUID().uuidString
        let referenceDate = Date()
        let referenceTimeZone = TimeZone.current
        let candidateTasks = try await extractVoice(
            transcript: transcript,
            profile: profile,
            privateKey: privateKey
        )
        let tasks = await finalizeVoice(
            candidates: candidateTasks,
            boardID: boardID,
            boards: boards,
            profile: profile,
            privateKey: privateKey,
            now: referenceDate,
            timeZone: referenceTimeZone
        )
        let final = tasks.isEmpty
            ? [VoiceFinalWire(title: transcript, dueISO: nil, notes: nil, subtasks: nil, priority: nil)]
            : tasks
        return TaskifyWatchVoicePreview(
            requestID: requestID,
            transcript: transcript,
            tasks: final.enumerated().map { index, task in
                TaskifyWatchVoiceDraft(
                    id: "\(requestID)-\(index)",
                    title: task.title,
                    dueISO: task.dueISO,
                    boardId: task.boardId,
                    notes: task.notes,
                    subtasks: task.subtasks,
                    priority: task.priority,
                    reminderMinutesBeforeDue: task.reminderMinutesBeforeDue,
                    reminderTime: task.reminderTime,
                    columnId: task.columnId,
                    recurrence: task.recurrence
                )
            }
        )
    }

    private func extractVoice(
        transcript: String,
        profile: TaskifyWatchIndependentProfile,
        privateKey: Data
    ) async throws -> [VoiceCandidateWire] {
        struct Body: Encodable {
            let npub: String
            let transcript: String
            let candidates: [VoiceCandidateWire]
            let sessionDurationSeconds: Int
        }
        struct Reply: Decodable { let operations: [VoiceOperationWire]? }

        let body = Body(
            npub: profile.publicKeyNpub,
            transcript: transcript,
            candidates: [],
            sessionDurationSeconds: max(1, transcript.split(whereSeparator: \.isWhitespace).count / 2)
        )
        let reply: Reply = try await authenticatedPost(
            path: "api/voice/extract",
            body: body,
            profile: profile,
            privateKey: privateKey,
            acceptsRateLimitBody: true
        )
        let candidates = (reply.operations ?? []).compactMap { operation -> VoiceCandidateWire? in
            guard operation.type == "create_task" else { return nil }
            let title = (operation.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { return nil }
            return VoiceCandidateWire(
                id: UUID().uuidString,
                title: title,
                dueText: operation.dueText,
                reminderText: operation.reminderText,
                notes: operation.notes,
                recurrenceText: operation.recurrenceText,
                boardId: operation.boardId,
                subtasks: operation.subtasks,
                status: "confirmed"
            )
        }
        return candidates.isEmpty
            ? [VoiceCandidateWire(id: UUID().uuidString, title: transcript, status: "confirmed")]
            : candidates
    }

    private func finalizeVoice(
        candidates: [VoiceCandidateWire],
        boardID: String,
        boards: [TaskifyWatchVoiceBoardContext],
        profile: TaskifyWatchIndependentProfile,
        privateKey: Data,
        now: Date,
        timeZone: TimeZone
    ) async -> [VoiceFinalWire] {
        struct Body: Encodable {
            let npub: String
            let candidates: [VoiceCandidateWire]
            let boardId: String
            let boards: [TaskifyWatchVoiceBoardContext]
            let referenceDate: String
            let referenceTimeZone: String
            let referenceOffsetMinutes: Int
        }
        struct Reply: Decodable { let tasks: [VoiceFinalWire]? }
        let body = Body(
            npub: profile.publicKeyNpub,
            candidates: candidates,
            boardId: boardID,
            boards: boards,
            referenceDate: ISO8601DateFormatter().string(from: now),
            referenceTimeZone: timeZone.identifier,
            referenceOffsetMinutes: -timeZone.secondsFromGMT(for: now) / 60
        )
        guard let reply: Reply = try? await authenticatedPost(
            path: "api/voice/finalize",
            body: body,
            profile: profile,
            privateKey: privateKey
        ) else {
            return candidates.map {
                VoiceFinalWire(title: $0.title, dueISO: nil, notes: nil, subtasks: $0.subtasks, priority: nil)
            }
        }
        return (reply.tasks ?? []).filter {
            !$0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    private func authenticatedPost<Body: Encodable, Reply: Decodable>(
        path: String,
        body: Body,
        profile: TaskifyWatchIndependentProfile,
        privateKey: Data,
        acceptsRateLimitBody: Bool = false,
        acceptsRelayFailureBody: Bool = false
    ) async throws -> Reply {
        let data = try encoded(body)
        let url = fallbackBaseURL.appendingPathComponent(path)
        let authentication = try TaskifyWatchNostrCrypto.requestAuthentication(
            privateKey: privateKey,
            publicKeyHex: profile.publicKeyHex,
            method: "POST",
            url: url,
            body: data
        )
        // Voice can try several providers; allow the Worker's bounded fallback chain to finish.
        let timeout: TimeInterval = path.hasPrefix("api/voice/") ? 60 : 15
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.httpBody = data
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        for (name, value) in authentication.headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        return try await response(for: request, acceptsRateLimitBody: acceptsRateLimitBody,
            acceptsRelayFailureBody: acceptsRelayFailureBody)
    }

    private func response<Reply: Decodable>(
        for request: URLRequest,
        acceptsRateLimitBody: Bool = false,
        acceptsRelayFailureBody: Bool = false
    ) async throws -> Reply {
        let (data, rawResponse) = try await session.data(for: request)
        guard let response = rawResponse as? HTTPURLResponse,
              (200..<300).contains(response.statusCode)
                || (acceptsRateLimitBody && response.statusCode == 429)
                || (acceptsRelayFailureBody && response.statusCode == 502) else {
            throw TaskifyWatchIndependentError.serviceUnavailable
        }
        guard let decoded = try? JSONDecoder().decode(Reply.self, from: data) else {
            throw TaskifyWatchIndependentError.invalidResponse
        }
        return decoded
    }

    private func encoded<Value: Encodable>(_ value: Value) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(value)
    }

    private static func allowsWorkerFallback(after gatewayBaseURL: URL) -> Bool {
        gatewayBaseURL.scheme?.lowercased() == "https"
            && gatewayBaseURL.host?.lowercased() == "push.solife.me"
            && (gatewayBaseURL.port == nil || gatewayBaseURL.port == 443)
    }

    private func normalizedRelays(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.compactMap { value in
            let normalized = value.trimmingCharacters(in: CharacterSet(charactersIn: " /"))
            guard normalized.hasPrefix("wss://"), seen.insert(normalized).inserted else { return nil }
            return normalized
        }
    }
}

private struct VoiceCandidateWire: Codable, Sendable {
    let id: String
    let title: String
    let dueText: String?
    let reminderText: String?
    let notes: String?
    let recurrenceText: String?
    let boardId: String?
    let subtasks: [String]?
    let status: String

    init(
        id: String,
        title: String,
        dueText: String? = nil,
        reminderText: String? = nil,
        notes: String? = nil,
        recurrenceText: String? = nil,
        boardId: String? = nil,
        subtasks: [String]? = nil,
        status: String
    ) {
        self.id = id
        self.title = title
        self.dueText = dueText
        self.reminderText = reminderText
        self.notes = notes
        self.recurrenceText = recurrenceText
        self.boardId = boardId
        self.subtasks = subtasks
        self.status = status
    }
}

private struct VoiceOperationWire: Decodable, Sendable {
    let type: String
    let title: String?
    let dueText: String?
    let reminderText: String?
    let notes: String?
    let recurrenceText: String?
    let boardId: String?
    let subtasks: [String]?
}

private struct VoiceFinalWire: Codable, Sendable {
    let title: String
    let dueISO: String?
    let boardId: String?
    let columnId: String?
    let notes: String?
    let subtasks: [String]?
    let priority: Int?
    let reminderMinutesBeforeDue: [Int]?
    let reminderTime: String?
    let recurrence: VoiceRecurrence?

    init(
        title: String,
        dueISO: String? = nil,
        boardId: String? = nil,
        columnId: String? = nil,
        notes: String? = nil,
        subtasks: [String]? = nil,
        priority: Int? = nil,
        reminderMinutesBeforeDue: [Int]? = nil,
        reminderTime: String? = nil,
        recurrence: VoiceRecurrence? = nil
    ) {
        self.title = title
        self.dueISO = dueISO
        self.boardId = boardId
        self.columnId = columnId
        self.notes = notes
        self.subtasks = subtasks
        self.priority = priority
        self.reminderMinutesBeforeDue = reminderMinutesBeforeDue
        self.reminderTime = reminderTime
        self.recurrence = recurrence
    }
}
