import CryptoKit
import TaskifyFileCipher
import Foundation

public struct EncryptedAttachmentFile: Sendable {
    public let url: URL
    public let plaintextSize: Int
    public let keyHex: String
    public let nonceHex: String
    public let sha256: String
}

/// Incremental AES-GCM, preserving the PWA's exact single-message formats. These
/// chunks are I/O buffers, not independently encrypted messages or a new protocol.
public enum AttachmentFileCrypto {
    public static func encryptChat(_ source: URL, directory: URL? = nil,
                                   progress: AttachmentProgressHandler? = nil) throws -> EncryptedAttachmentFile {
        let key = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        var generator = SystemRandomNumberGenerator()
        let nonce = Data((0..<16).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
        let destination = try AttachmentFiles.create(in: directory)
        do {
            let size = try transform(source, destination: destination, key: key, nonce: nonce, encrypt: true, progress: progress)
            progress?(.preparingUpload)
            return EncryptedAttachmentFile(url: destination, plaintextSize: size,
                keyHex: key.hexString, nonceHex: nonce.hexString, sha256: try AttachmentFiles.sha256(destination))
        } catch { try? FileManager.default.removeItem(at: destination); throw error }
    }

    public static func encryptTask(_ source: URL, boardID: String) throws -> URL {
        let key = Data(CryptoKit.SHA256.hash(data: Data("taskify-board-attachment-v2".utf8) + Data(boardID.utf8)))
        let nonce = CryptoKit.AES.GCM.Nonce().withUnsafeBytes { Data($0) }
        let destination = try AttachmentFiles.create()
        do {
            _ = try transform(source, destination: destination, key: key, nonce: nonce, encrypt: true,
                              prefix: Data("TFA2".utf8) + nonce)
            return destination
        } catch { try? FileManager.default.removeItem(at: destination); throw error }
    }

    public static func decryptChat(_ source: URL, attachment: NostrDirectMessageAttachment) throws -> URL {
        guard let key = try? Data(hex: attachment.keyHex), key.count == 32,
              let nonce = try? Data(hex: attachment.nonceHex), nonce.count == 16 else { throw AttachmentFileError.corrupt }
        _ = try AttachmentFiles.size(source, limit: AttachmentFiles.maximumBytes + 16)
        if let hash = attachment.sha256, try AttachmentFiles.sha256(source) != hash { throw AttachmentFileError.corrupt }
        return try decrypt(source, key: key, nonce: nonce, skip: 0)
    }

    public static func decryptTask(_ source: URL, boardID: String) throws -> URL {
        let handle = try FileHandle(forReadingFrom: source)
        defer { try? handle.close() }
        let prefix = try handle.read(upToCount: 16) ?? Data()
        let isV2 = prefix.starts(with: Data("TFA2".utf8))
        let nonce = isV2 ? Data(prefix.dropFirst(4)) : Data(prefix.prefix(12))
        guard nonce.count == 12 else { throw AttachmentFileError.corrupt }
        let domain = isV2 ? Data("taskify-board-attachment-v2".utf8) : Data()
        let key = Data(CryptoKit.SHA256.hash(data: domain + Data(boardID.utf8)))
        return try decrypt(source, key: key, nonce: nonce, skip: isV2 ? 16 : 12)
    }

    private static func decrypt(_ source: URL, key: Data, nonce: Data, skip: Int) throws -> URL {
        let destination = try AttachmentFiles.create()
        do {
            _ = try transform(source, destination: destination, key: key, nonce: nonce, encrypt: false, skip: skip)
            // No caller receives this URL until GCM's final authentication succeeds.
            return destination
        } catch { try? FileManager.default.removeItem(at: destination); throw error }
    }

    @discardableResult
    private static func transform(_ source: URL, destination: URL, key: Data, nonce: Data,
                                  encrypt: Bool, prefix: Data = Data(), skip: Int = 0,
                                  progress: AttachmentProgressHandler? = nil) throws -> Int {
        let size = try AttachmentFiles.size(source, limit: AttachmentFiles.maximumBytes + (encrypt ? 0 : 32))
        guard size > 0 else { throw AttachmentFileError.empty }
        guard encrypt || size >= skip + 16 else { throw AttachmentFileError.corrupt }
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        var tag: Data?
        if !encrypt {
            try input.seek(toOffset: UInt64(size - 16))
            tag = try input.read(upToCount: 16)
        }
        let cryptor = try StreamingGCM(key: key, nonce: nonce, encrypt: encrypt, authenticationTag: tag)
        try input.seek(toOffset: UInt64(skip))
        let output = try FileHandle(forWritingTo: destination)
        defer { try? output.close() }
        if !prefix.isEmpty { try output.write(contentsOf: prefix) }
        var remaining = size - skip - (encrypt ? 0 : 16)
        var total = 0
        var written = 0
        var lastProgressAt: TimeInterval = 0
        if encrypt { progress?(.encrypting(completed: 0, total: size)) }
        while remaining > 0 {
            try autoreleasepool {
                try Task.checkCancellation()
                guard let data = try input.read(upToCount: min(AttachmentFiles.chunkSize, remaining)), !data.isEmpty else {
                    throw AttachmentFileError.corrupt
                }
                remaining -= data.count
                total += data.count
                guard total <= AttachmentFiles.maximumBytes else { throw AttachmentFileError.tooLarge }
                let bytes = try cryptor.update(data)
                written += bytes.count
                if !encrypt && written > AttachmentFiles.maximumBytes { throw AttachmentFileError.tooLarge }
                try output.write(contentsOf: bytes)
                let now = ProcessInfo.processInfo.systemUptime
                if encrypt, now - lastProgressAt >= 0.1 || remaining == 0 {
                    progress?(.encrypting(completed: total, total: size))
                    lastProgressAt = now
                }
            }
        }
        guard try AttachmentFiles.size(source, limit: AttachmentFiles.maximumBytes + 32) == size else {
            throw AttachmentFileError.corrupt
        }
        let last = try cryptor.finish()
        written += last.count
        if !encrypt && written > AttachmentFiles.maximumBytes { throw AttachmentFileError.tooLarge }
        try output.write(contentsOf: Data(last))
        return encrypt ? total : written
    }
}
