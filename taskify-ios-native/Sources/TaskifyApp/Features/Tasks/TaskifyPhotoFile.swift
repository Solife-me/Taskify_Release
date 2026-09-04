import CoreTransferable
import Foundation
import TaskifyCore
import UniformTypeIdentifiers

struct TaskifyPhotoFile: Transferable, Sendable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .data) { received in
            TaskifyPhotoFile(url: try AttachmentFiles.importFile(received.file))
        }
    }
}
