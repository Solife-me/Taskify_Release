import Foundation
import XCTest
@testable import TaskifyCore

/// The Node core reads these vectors too, so every client follows the same fixed upload routes
/// and turns an Originless CID into the same usable public URL.
final class FileServerUploadVectorTests: XCTestCase {
    private struct VectorFile: Decodable {
        let opaqueUploads: [OpaqueUpload]
        let routes: [Route]
        let responses: [Response]
    }

    private struct OpaqueUpload: Decodable {
        let name: String
        let sha256: String
        let filename: String
    }

    private struct Route: Decodable {
        let name: String
        let type: String
        let serverURL: String
        let method: String
        let uploadURL: String
    }

    private struct Response: Decodable {
        let name: String
        let serverURL: String
        let payload: [String: String]
        let remoteURL: String
    }

    private static let vectorsURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // TaskifyCoreTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // taskify-ios-native
        .deletingLastPathComponent() // repository root
        .appendingPathComponent("taskify-core/fixtures/file-server-upload-vectors.json")

    func testOpaqueUploadFilenamesMatchSharedVectors() throws {
        for vector in try fixture().opaqueUploads {
            XCTAssertEqual(try EncryptedFileUpload.opaqueFilename(ciphertextSHA256: vector.sha256),
                           vector.filename, vector.name)
            XCTAssertFalse(vector.filename.contains(".pdf"))
        }
        XCTAssertThrowsError(try EncryptedFileUpload.opaqueFilename(ciphertextSHA256: "contract-final.pdf"))
    }

    func testFixedRoutesMatchSharedVectors() async throws {
        let file = try fixture()
        let source = try AttachmentFiles.write(Data([1, 2, 3]))
        defer { try? FileManager.default.removeItem(at: source) }

        for vector in file.routes {
            let type = try XCTUnwrap(TaskifyFileServerType(rawValue: vector.type), vector.name)
            let server = TaskifyFileServerEntry(url: vector.serverURL, type: type)
            let prepared = try await EncryptedFileUpload.prepare(
                file: source,
                filename: "encrypted.bin",
                server: server,
                privateKey: Data(repeating: 1, count: 32)
            )
            defer { if prepared.removesBody { try? FileManager.default.removeItem(at: prepared.body) } }
            XCTAssertEqual(prepared.request.httpMethod, vector.method, vector.name)
            XCTAssertEqual(prepared.request.url?.absoluteString, vector.uploadURL, vector.name)
        }
    }

    func testOriginlessResponsesMatchSharedVectors() throws {
        for vector in try fixture().responses {
            let server = TaskifyFileServerEntry(url: vector.serverURL, type: .originless)
            let data = try JSONEncoder().encode(vector.payload)
            XCTAssertEqual(try EncryptedFileUpload.remoteURL(data: data, server: server), vector.remoteURL, vector.name)
        }
    }

    private func fixture() throws -> VectorFile {
        try JSONDecoder().decode(VectorFile.self, from: Data(contentsOf: Self.vectorsURL))
    }
}
