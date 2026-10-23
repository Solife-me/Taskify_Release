import CoreTransferable
import Foundation
import ImageIO
import TaskifyCore
import UniformTypeIdentifiers

enum MacAttachmentImportSource: Sendable {
    case file(URL)
    case rawImage(Data)
}

struct MacAttachmentTransferPayload: Transferable, Sendable {
    let source: MacAttachmentImportSource

    static var transferRepresentation: some TransferRepresentation {
        ProxyRepresentation(importing: { (url: URL) in
            MacAttachmentTransferPayload(source: .file(url))
        })
        DataRepresentation(importedContentType: .image) {
            MacAttachmentTransferPayload(source: .rawImage($0))
        }
    }
}

struct MacMaterializedAttachment: Equatable, Sendable {
    let url: URL
    let name: String
    let mimeType: String
}

/// The one boundary between transferable paste/drop payloads and the files consumed by the
/// existing encrypted attachment uploader. Raw images are identified from their bytes rather
/// than a pasteboard promise, then written with a safe generated name and real extension.
enum MacAttachmentImporter {
    static func materialize(
        _ source: MacAttachmentImportSource,
        into directory: URL? = nil
    ) throws -> MacMaterializedAttachment {
        switch source {
        case .file(let sourceURL):
            guard sourceURL.isFileURL else { throw AttachmentFileError.invalidFile }
            let name = sourceURL.lastPathComponent
            let mimeType = UTType(filenameExtension: sourceURL.pathExtension)?.preferredMIMEType
                ?? "application/octet-stream"
            return MacMaterializedAttachment(
                url: try AttachmentFiles.importFile(sourceURL, into: directory),
                name: name,
                mimeType: mimeType
            )

        case .rawImage(let data):
            guard !data.isEmpty else { throw AttachmentFileError.empty }
            guard data.count <= AttachmentFiles.maximumBytes else { throw AttachmentFileError.tooLarge }
            guard let imageSource = CGImageSourceCreateWithData(data as CFData, nil),
                  let identifier = CGImageSourceGetType(imageSource) else {
                throw AttachmentFileError.invalidFile
            }
            guard let type = UTType(identifier as String),
                  type.conforms(to: .image),
                  let suffix = type.preferredFilenameExtension,
                  let mimeType = type.preferredMIMEType else {
                throw AttachmentFileError.invalidFile
            }
            let url = try AttachmentFiles.create(in: directory, suffix: suffix)
            do {
                let handle = try FileHandle(forWritingTo: url)
                defer { try? handle.close() }
                try handle.write(contentsOf: data)
                return MacMaterializedAttachment(
                    url: url,
                    name: "Pasted Image.\(suffix)",
                    mimeType: mimeType
                )
            } catch {
                try? FileManager.default.removeItem(at: url)
                throw error
            }
        }
    }
}
