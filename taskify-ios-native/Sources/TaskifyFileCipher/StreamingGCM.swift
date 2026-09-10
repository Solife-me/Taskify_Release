import Foundation
@_implementationOnly import CryptoSwift

/// Isolates CryptoSwift's Foundation extensions and implementation errors from
/// the existing identity and attachment APIs. Decryption supplies the tag separately
/// to avoid combined-mode incremental buffering assumptions for partial final blocks.
public final class StreamingGCM {
    public enum Failure: Error { case invalidInput, authenticationFailed }
    private var cryptor: any Cryptor & Updatable
    public init(key: Data, nonce: Data, encrypt: Bool, authenticationTag: Data? = nil) throws {
        guard key.count == 32, [12, 16].contains(nonce.count), encrypt || authenticationTag?.count == 16 else {
            throw Failure.invalidInput
        }
        do {
            let mode = encrypt ? GCM(iv: Array(nonce), mode: .combined)
                : GCM(iv: Array(nonce), authenticationTag: Array(authenticationTag!), mode: .detached)
            let cipher = try AES(key: Array(key), blockMode: mode, padding: .noPadding)
            cryptor = try encrypt ? cipher.makeEncryptor() : cipher.makeDecryptor()
        } catch { throw Failure.invalidInput }
    }
    public func update(_ data: Data) throws -> Data {
        do { return Data(try cryptor.update(withBytes: Array(data))) }
        catch { throw Failure.authenticationFailed }
    }
    public func finish() throws -> Data {
        do { return Data(try cryptor.finish()) }
        catch { throw Failure.authenticationFailed }
    }
}
