import Foundation
import os
import TaskifyCore
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private struct PreviewResponse: Decodable {
        let event: NostrEvent
    }

    /// Records why a notification kept the generic alert or went out without Reply, never the
    /// message itself, so intermittent cases can be diagnosed in Console with the iPhone connected.
    private static let logger = Logger(
        subsystem: "solife.me.Taskify.Native.NotificationService",
        category: "Preview"
    )

    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var genericAlert: UNNotificationContent?
    private var workTask: Task<Void, Never>?
    private let finishLock = NSLock()

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        genericAlert = request.content
        workTask = Task { [weak self] in
            guard let self else { return }
            await process(request)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        Self.logger.error("Time expired before the preview was ready; delivering the generic alert")
        workTask?.cancel()
        finish(with: nil)
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
                snapshot: snapshot,
                selection: DMPushNotificationSharedSettings.selection
            ) else {
                Self.logger.info("No preview for this event; delivering the generic alert")
                finish(with: nil)
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
            if let replyTarget = DMPushNotificationPreviewPolicy.replyTarget(
                for: decrypted,
                identityPublicKey: identity.publicKeyHex
            ) {
                // The system shows Reply only if the category is registered when the notification
                // is presented; the app may not have run since this build was installed.
                await TaskifyNotificationCategories.registerIfNeeded()
                content.categoryIdentifier = TaskifyNotificationContract.directMessageCategoryIdentifier
                for (key, value) in replyTarget.userInfo { userInfo[key] = value }
            } else {
                Self.logger.notice("Preview has no reply target; delivering it without Reply")
            }
            content.userInfo = userInfo
            finish(with: content)
        } catch {
            let nsError = error as NSError
            Self.logger.error(
                "Preview failed (\(nsError.domain, privacy: .public) \(nsError.code, privacy: .public)); delivering the generic alert"
            )
            finish(with: nil)
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

    /// Delivers the decrypted preview, or the unchanged generic APNs alert when `content` is nil.
    /// Hiding a notification requires Apple's managed Notification Filtering entitlement, which
    /// this extension does not have, so unselected categories, payments, and events that cannot be
    /// fetched or decrypted keep the generic alert instead of being suppressed.
    private func finish(with content: UNNotificationContent?) {
        finishLock.lock()
        guard let handler = contentHandler, let genericAlert else {
            finishLock.unlock()
            return
        }
        contentHandler = nil
        self.genericAlert = nil
        finishLock.unlock()
        handler(content ?? genericAlert)
    }
}
