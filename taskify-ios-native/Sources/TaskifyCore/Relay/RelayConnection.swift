/// RelayConnection.swift
/// Single Nostr relay WebSocket connection with automatic reconnection and keepalive pings.
///
/// Improvements over initial version (Primal-informed patterns, no GPL code):
/// - Ping/keepalive every 10s — mirrors Primal's `socket?.ping(interval: 10.0)`.
///   Detects silent dead connections that URLSessionWebSocketTask doesn't surface.
/// - `pingIntervalSeconds` / `maxReconnectDelaySecs` exposed as constants for tests.
/// - `hasPendingMessages()` exposed for test observability.
/// - Ping failure triggers reconnect (same path as receive error).

import Foundation

// MARK: - RelayPoolProtocol

/// Protocol for RelayPool so RelayConnection can be tested with a mock pool.
public protocol RelayPoolProtocol: AnyObject {
    nonisolated func dispatch(message: RelayMessage, from relayUrl: String)
    func relayDidConnect(url: String) async
    func relayDidDisconnect(url: String) async
    func relayDidFailPermanently(url: String, error: NSError?) async
}

private final class RelayConnectionDelegateProxy: NSObject, URLSessionWebSocketDelegate {
    var owner: RelayConnection?

    init(owner: RelayConnection) {
        self.owner = owner
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        guard let owner else { return }
        Task { await owner.webSocketDidOpen(task: webSocketTask) }
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        guard let owner else { return }
        Task { await owner.webSocketDidClose(task: webSocketTask, closeCode: closeCode, reason: reason) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        guard let owner, let error, let webSocketTask = task as? URLSessionWebSocketTask else { return }
        let nsError = error as NSError
        Task { await owner.webSocketDidComplete(task: webSocketTask, error: nsError) }
    }
}

// MARK: - RelayConnection

public actor RelayConnection {

    // MARK: Constants (exposed for tests)

    /// Ping interval in seconds — matches Primal's 10s keepalive.
    public static let pingIntervalSeconds: TimeInterval = 10.0
    /// Maximum reconnect backoff — caps exponential growth.
    public static let maxReconnectDelaySecs: TimeInterval = 30.0

    public let url: String
    private weak var pool: (any RelayPoolProtocol)?
    private var session: URLSession?
    private var delegateProxy: RelayConnectionDelegateProxy?
    private var webSocketTask: URLSessionWebSocketTask?
    private var reconnectDelay: TimeInterval = 1.0
    private var shouldReconnect = true
    private var isConnected = false
    private var pendingMessages: [String] = []
    private var pingTask: Task<Void, Never>? = nil

    public init(url: String, pool: any RelayPoolProtocol) {
        self.url = url
        self.pool = pool
    }

    // MARK: Connect / disconnect

    public func connect() async {
        shouldReconnect = true
        await openWebSocket()
    }

    public func disconnect(notifyPool: Bool = true) async {
        shouldReconnect = false
        await teardownCurrentConnection(closeCode: .normalClosure, notifyPool: notifyPool)
    }

    // MARK: Send

    public func send(_ text: String) async {
        guard let task = webSocketTask, isConnected else {
            pendingMessages.append(text)
            return
        }

        do {
            try await task.send(.string(text))
        } catch {
            pendingMessages.append(text)
            await handleDisconnect(triggering: task, error: error as NSError)
        }
    }

    // MARK: State queries

    public func connected() -> Bool { isConnected }

    /// Exposed for test observability.
    public func hasPendingMessages() -> Bool { !pendingMessages.isEmpty }

    // MARK: Internal — WebSocket lifecycle

    private func openWebSocket() async {
        guard let wsURL = URL(string: url) else { return }
        let delegateProxy = RelayConnectionDelegateProxy(owner: self)
        let session = URLSession(configuration: .default, delegate: delegateProxy, delegateQueue: nil)
        let task = session.webSocketTask(with: wsURL)
        self.delegateProxy = delegateProxy
        self.session = session
        webSocketTask = task
        task.resume()
        startReceiving(task: task)
    }

    private func startReceiving(task: URLSessionWebSocketTask) {
        Task {
            while true {
                do {
                    let message = try await task.receive()
                    await markConnectedIfNeeded(task: task)
                    switch message {
                    case .string(let text):
                        if let parsed = RelayMessage.parse(text) {
                            pool?.dispatch(message: parsed, from: url)
                        }
                    case .data(let data):
                        if let text = String(data: data, encoding: .utf8),
                           let parsed = RelayMessage.parse(text) {
                            pool?.dispatch(message: parsed, from: url)
                        }
                    @unknown default:
                        break
                    }
                } catch {
                    await handleDisconnect(triggering: task, error: error as NSError)
                    return
                }
            }
        }
    }

    /// Sends a WebSocket ping every `pingIntervalSeconds`.
    /// If the ping fails, it means the connection is silently dead — trigger reconnect.
    /// Mirrors Primal's `socket?.ping(interval: 10.0)` behaviour.
    ///
    /// Uses the callback-based `sendPing(pongReceiveHandler:)` API wrapped in a continuation
    /// because `URLSessionWebSocketTask` does not have an async `sendPing()` overload.
    private func startPingLoop(task: URLSessionWebSocketTask) {
        pingTask?.cancel()
        pingTask = Task { [weak self] in
            while true {
                try? await Task.sleep(nanoseconds: UInt64(Self.pingIntervalSeconds * 1_000_000_000))
                guard let self, !Task.isCancelled else { return }
                let stillConnected = await self.connected()
                guard stillConnected else { return }
                let pingError = await withCheckedContinuation { (continuation: CheckedContinuation<(any Error)?, Never>) in
                    task.sendPing { error in
                        continuation.resume(returning: error)
                    }
                }
                if pingError != nil {
                    // Ping failed — connection is silently dead
                    await self.handleDisconnect(triggering: task, error: pingError as NSError?)
                    return
                }
            }
        }
    }

    private func flushPendingMessages(task: URLSessionWebSocketTask) async {
        guard isConnected, !pendingMessages.isEmpty else { return }
        let queued = pendingMessages
        pendingMessages.removeAll()

        for (index, message) in queued.enumerated() {
            guard let currentTask = webSocketTask, currentTask === task, isConnected else {
                pendingMessages = Array(queued[index...]) + pendingMessages
                return
            }
            do {
                try await task.send(.string(message))
            } catch {
                pendingMessages = Array(queued[index...]) + pendingMessages
                await handleDisconnect(triggering: task, error: error as NSError)
                return
            }
        }
    }

    private func markConnectedIfNeeded(task: URLSessionWebSocketTask) async {
        guard let currentTask = webSocketTask, currentTask === task else { return }
        guard !isConnected else { return }
        isConnected = true
        reconnectDelay = 1.0
        startPingLoop(task: task)
        await flushPendingMessages(task: task)
        if let pool {
            await pool.relayDidConnect(url: url)
        }
    }

    fileprivate func webSocketDidOpen(task: URLSessionWebSocketTask) async {
        await markConnectedIfNeeded(task: task)
    }

    fileprivate func webSocketDidClose(
        task: URLSessionWebSocketTask,
        closeCode _: URLSessionWebSocketTask.CloseCode,
        reason _: Data?
    ) async {
        await handleDisconnect(triggering: task, error: nil)
    }

    fileprivate func webSocketDidComplete(task: URLSessionWebSocketTask, error: NSError) async {
        await handleDisconnect(triggering: task, error: error)
    }

    static func shouldAutoReconnect(after error: NSError?) -> Bool {
        guard let error else { return true }
        guard error.domain == NSURLErrorDomain else { return true }

        switch error.code {
        case NSURLErrorSecureConnectionFailed,
             NSURLErrorServerCertificateHasBadDate,
             NSURLErrorServerCertificateUntrusted,
             NSURLErrorServerCertificateHasUnknownRoot,
             NSURLErrorServerCertificateNotYetValid,
             NSURLErrorClientCertificateRejected,
             NSURLErrorClientCertificateRequired:
            return false
        default:
            return true
        }
    }

    private func teardownCurrentConnection(
        closeCode: URLSessionWebSocketTask.CloseCode,
        notifyPool: Bool
    ) async {
        let wasConnected = isConnected
        pingTask?.cancel()
        pingTask = nil
        let task = webSocketTask
        webSocketTask = nil
        let session = self.session
        self.session = nil
        delegateProxy?.owner = nil
        delegateProxy = nil
        isConnected = false

        task?.cancel(with: closeCode, reason: nil)
        session?.invalidateAndCancel()

        if notifyPool, wasConnected, let pool {
            await pool.relayDidDisconnect(url: url)
        }
    }

    private func handleDisconnect(
        triggering task: URLSessionWebSocketTask,
        error: NSError?
    ) async {
        guard let currentTask = webSocketTask, currentTask === task else { return }
        let shouldRetry = shouldReconnect && Self.shouldAutoReconnect(after: error)
        await teardownCurrentConnection(closeCode: .goingAway, notifyPool: true)
        if shouldReconnect, !shouldRetry, let pool {
            await pool.relayDidFailPermanently(url: url, error: error)
        }
        guard shouldRetry else { return }
        let delay = reconnectDelay
        reconnectDelay = min(reconnectDelay * 2, Self.maxReconnectDelaySecs)
        try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        guard shouldReconnect, webSocketTask == nil else { return }
        await openWebSocket()
    }
}
