import Foundation
import TaskifyCore
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private struct PreviewResponse: Decodable {
        let event: NostrEvent
    }

    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var fallbackContent: UNNotificationContent?
    private var workTask: Task<Void, Never>?
    private let finishLock = NSLock()

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        fallbackContent = DMPushNotificationSharedSettings.selection == .payments
            ? UNNotificationContent()
            : request.content
        workTask = Task { [weak self] in
            guard let self else { return }
            await process(request)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        workTask?.cancel()
        finish(with: fallbackContent ?? UNNotificationContent())
    }

    private func process(_ request: UNNotificationRequest) async {
        do {
            let event = try await fetchEvent(from: request.content.userInfo)
            guard !Task.isCancelled else { return }
            guard let identity = try KeychainIdentityStore().load() else {
                throw CocoaError(.fileReadNoSuchFile)
            }
            let decrypted = try NIP17GiftWrap.unwrapRumor(event, recipient: identity)
            let snapshot = try await JSONTaskStore().load()
            guard let presentation = DMPushNotificationPreviewPolicy.presentation(
                for: decrypted,
                identityPublicKey: identity.publicKeyHex,
                contacts: snapshot.contacts ?? [],
                selection: DMPushNotificationSharedSettings.selection
            ) else {
                finish(with: UNNotificationContent())
                return
            }
            guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
                throw CocoaError(.coderInvalidValue)
            }
            content.title = presentation.title
            content.subtitle = presentation.subtitle ?? ""
            content.body = presentation.body
            content.threadIdentifier = "taskify-direct-messages"
            var userInfo = content.userInfo
            userInfo[TaskifyNotificationContract.destinationKey] =
                TaskifyNotificationContract.Destination.chat.rawValue
            content.userInfo = userInfo
            finish(with: content)
        } catch {
            finish(with: fallbackContent ?? request.content)
        }
    }

    private func fetchEvent(from userInfo: [AnyHashable: Any]) async throws -> NostrEvent {
        guard let taskify = userInfo["taskify"] as? [String: Any],
              taskify["type"] as? String == "dm-preview",
              let rawURL = taskify["previewURL"] as? String,
              let url = URL(string: rawURL),
              url.scheme?.lowercased() == "https" else {
            throw URLError(.badURL)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.timeoutIntervalForRequest = 8
        configuration.timeoutIntervalForResource = 10
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse,
              http.statusCode == 200,
              data.count <= 256 * 1024 else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(PreviewResponse.self, from: data).event
    }

    private func finish(with content: UNNotificationContent) {
        finishLock.lock()
        guard let handler = contentHandler else {
            finishLock.unlock()
            return
        }
        contentHandler = nil
        fallbackContent = nil
        finishLock.unlock()
        handler(content)
    }
}
