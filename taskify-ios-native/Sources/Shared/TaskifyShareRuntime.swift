import Foundation
import Intents
import Security
import TaskifyCore

/// Only the messaging identity is copied to this group. Wallet queries continue
/// using their existing default group, which remains first in the app entitlement.
enum TaskifyShareIdentity {
    static var group: String? { Bundle.main.object(forInfoDictionaryKey: "TaskifyShareKeychainGroup") as? String }
    private static var query: [String: Any]? {
        guard let group, !group.contains("$(") else { return nil }
        return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "TaskifyShareIdentity",
                kSecAttrAccount as String: "nostr", kSecAttrAccessGroup as String: group]
    }
    static func save(_ identity: NostrIdentity) throws {
        guard var item = query else { throw URLError(.userAuthenticationRequired) }
        let attributes: [String: Any] = [kSecValueData as String: identity.privateKey,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(item as CFDictionary, attributes as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw URLError(.userAuthenticationRequired) }
        item.merge(attributes) { _, new in new }
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw URLError(.userAuthenticationRequired) }
    }
    static func load(account: String) throws -> NostrIdentity {
        guard var item = query else { throw URLError(.userAuthenticationRequired) }
        item[kSecReturnData as String] = true
        item[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        guard SecItemCopyMatching(item as CFDictionary, &value) == errSecSuccess, let key = value as? Data else {
            throw URLError(.userAuthenticationRequired)
        }
        let identity = try NostrIdentity(privateKey: key)
        guard identity.publicKeyHex == account else { throw URLError(.userAuthenticationRequired) }
        return identity
    }
    static func clear() { if let query { SecItemDelete(query as CFDictionary) } }
}

enum TaskifyShareSuggestions {
    static func donate(account: String, recipient: ShareRecipient, incoming: Bool = false) {
        let id = recipient.suggestionID(account: account)
        let person = INPerson(personHandle: INPersonHandle(value: id, type: .unknown), nameComponents: nil,
            displayName: recipient.name, image: nil, contactIdentifier: nil, customIdentifier: id)
        let intent = INSendMessageIntent(recipients: recipient.isGroup ? nil : [person], outgoingMessageType: .outgoingMessageText,
            content: nil, speakableGroupName: INSpeakableString(spokenPhrase: recipient.name),
            conversationIdentifier: id, serviceName: nil, sender: nil, attachments: nil)
        let metadata = INSendMessageIntentDonationMetadata()
        metadata.recipientCount = recipient.members.count
        intent.donationMetadata = metadata
        let interaction = INInteraction(intent: intent, response: nil)
        interaction.groupIdentifier = id
        interaction.direction = incoming ? .incoming : .outgoing
        interaction.donate(completion: nil)
    }
    static func remove(account: String, recipient: ShareRecipient) {
        INInteraction.delete(with: recipient.suggestionID(account: account), completion: nil)
    }
    static func clear() { INInteraction.deleteAll(completion: nil) }
}

/// One background session per transfer. iOS hands this session to the containing
/// app when the extension exits; both run this same completion implementation.
final class TaskifyShareUploadSession: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    static let prefix = "solife.me.Taskify.Native.share."
    private static let registryLock = NSLock()
    private static var sessions: [String: TaskifyShareUploadSession] = [:]
    private let id: UUID
    private var session: URLSession!
    private var responseData = Data()
    private var backgroundCompletion: (() -> Void)?
    private let completionLock = NSLock()
    private var processing = false
    private var finishedEvents = false

    private init(id: UUID, completion: (() -> Void)?) {
        self.id = id
        self.backgroundCompletion = completion
        super.init()
        let configuration = URLSessionConfiguration.background(withIdentifier: Self.prefix + id.uuidString)
        configuration.sharedContainerIdentifier = ShareTransferStore.groupID
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        configuration.waitsForConnectivity = true
        configuration.timeoutIntervalForRequest = 120
        configuration.timeoutIntervalForResource = 3_600
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }

    static func reconnect(identifier: String, completion: @escaping () -> Void) {
        guard identifier.hasPrefix(prefix), let id = UUID(uuidString: String(identifier.dropFirst(prefix.count))) else { completion(); return }
        registryLock.lock()
        defer { registryLock.unlock() }
        if let existing = sessions[identifier] {
            existing.completionLock.lock()
            existing.backgroundCompletion = completion
            existing.completionLock.unlock()
        } else { sessions[identifier] = TaskifyShareUploadSession(id: id, completion: completion) }
    }

    static func enqueue(_ job: ShareTransfer, prepared: EncryptedFileUploadRequest) throws {
        var saved = job
        saved.bodyName = prepared.body.lastPathComponent
        saved.sessionID = prefix + job.id.uuidString
        saved.state = "uploading"
        try ShareTransferStore.save(saved)
        registryLock.lock()
        let owner = TaskifyShareUploadSession(id: job.id, completion: nil)
        sessions[prefix + job.id.uuidString] = owner
        registryLock.unlock()
        owner.session.uploadTask(with: prepared.request, fromFile: prepared.body).resume()
    }

    static func cancel(_ job: ShareTransfer) {
        let identifier = prefix + job.id.uuidString
        registryLock.lock()
        let owner = sessions[identifier] ?? TaskifyShareUploadSession(id: job.id, completion: nil)
        sessions.removeValue(forKey: identifier)
        registryLock.unlock()
        owner.session.invalidateAndCancel()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard responseData.count + data.count <= 1_024 * 1_024 else { dataTask.cancel(); return }
        responseData.append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        completionLock.lock(); processing = true; completionLock.unlock()
        let data = responseData
        Task {
            defer { self.didProcess() }
            guard let lease = ShareTransferLease(id: id) else { return }
            defer { withExtendedLifetime(lease) {} }
            do {
                var job = try ShareTransferStore.load(id)
                guard let current = try? ShareTransferStore.account(), current.publicKey == job.account,
                      current.recipients.contains(where: { $0.id == job.recipient.id && $0.members == job.recipient.members }) else {
                    ShareTransferStore.remove(id); return
                }
                if let error { throw error }
                guard let response = task.response as? HTTPURLResponse else { throw AttachmentFileError.invalidFile }
                job.remoteURL = try await EncryptedFileUpload.finish(data: data, response: response, server: job.server,
                    authorization: task.originalRequest?.value(forHTTPHeaderField: "Authorization"))
                job.state = "sending"
                try ShareTransferStore.save(job)
                let identity = try TaskifyShareIdentity.load(account: job.account)
                job = try await ShareMessageDelivery.prepare(job, identity: identity, account: current)
                _ = try await ShareMessageDelivery.publish(job, identity: identity)
                Self.removeBodies(job)
            } catch {
                if var job = try? ShareTransferStore.load(id) {
                    job.state = "failed"; job.error = error.localizedDescription
                    try? ShareTransferStore.save(job)
                }
            }
        }
    }
    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        completionLock.lock(); finishedEvents = true; completionLock.unlock()
        finishIfReady()
    }
    private func didProcess() {
        completionLock.lock(); processing = false; completionLock.unlock()
        finishIfReady()
    }
    private func finishIfReady() {
        completionLock.lock()
        guard finishedEvents, !processing else { completionLock.unlock(); return }
        let completion = backgroundCompletion
        backgroundCompletion = nil
        completionLock.unlock()
        DispatchQueue.main.async { completion?() }
        session.finishTasksAndInvalidate()
        Self.registryLock.lock()
        Self.sessions.removeValue(forKey: Self.prefix + id.uuidString)
        Self.registryLock.unlock()
    }
    static func removeBodies(_ job: ShareTransfer) {
        for name in Set([job.bodyName, job.ciphertextName].compactMap { $0 }) {
            if let url = try? ShareTransferStore.file(name, job: job.id) { try? FileManager.default.removeItem(at: url) }
        }
    }

    /// Foreground recovery of failed transfers, re-signing expiring upload auth.
    static func retry(_ input: ShareTransfer) async {
        guard let lease = ShareTransferLease(id: input.id) else { return }
        defer { withExtendedLifetime(lease) {} }
        do {
            var job = try ShareTransferStore.load(input.id)
            guard job.state != "sent" else { return }
            if job.state == "uploading" {
                // Recover the small persist-before-resume crash window after the
                // background resource timeout. Active uploads retain session ownership.
                guard job.createdAt < Date().addingTimeInterval(-75 * 60) else { return }
                cancel(job)
                job.state = "failed"
                try ShareTransferStore.save(job)
            }
            let account = try ShareTransferStore.account()
            let identity = try TaskifyShareIdentity.load(account: job.account)
            guard account.publicKey == job.account, account.recipients.contains(where: {
                $0.id == job.recipient.id && $0.members == job.recipient.members
            }) else { ShareTransferStore.remove(job.id); return }
            if job.remoteURL == nil, let name = job.ciphertextName {
                job.remoteURL = try await EncryptedFileUpload.upload(file: ShareTransferStore.file(name, job: job.id),
                    filename: "\(job.sha256 ?? UUID().uuidString).bin", server: job.server, privateKey: identity.privateKey)
                try ShareTransferStore.save(job)
            }
            job = try await ShareMessageDelivery.prepare(job, identity: identity, account: account)
            _ = try await ShareMessageDelivery.publish(job, identity: identity)
            removeBodies(job)
        } catch {
            if var job = try? ShareTransferStore.load(input.id) {
                job.state = "failed"; job.error = error.localizedDescription; try? ShareTransferStore.save(job)
            }
        }
    }
}
