import AVFoundation
import SwiftUI
import TaskifyCore
import UIKit
import VisionKit

struct TaskAttachmentCameraPicker: UIViewControllerRepresentable {
    let onCapture: (UIImage) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.delegate = context.coordinator
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.allowsEditing = false
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        private let parent: TaskAttachmentCameraPicker

        init(parent: TaskAttachmentCameraPicker) {
            self.parent = parent
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            guard let image = info[.originalImage] as? UIImage else {
                parent.onCancel()
                return
            }
            parent.onCapture(image)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.onCancel()
        }
    }
}

struct TaskAttachmentDocumentScanner: UIViewControllerRepresentable {
    let onScan: ([UIImage]) -> Void
    let onCancel: () -> Void
    let onError: (Error) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let scanner = VNDocumentCameraViewController()
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ uiViewController: VNDocumentCameraViewController, context: Context) {}

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        private let parent: TaskAttachmentDocumentScanner

        init(parent: TaskAttachmentDocumentScanner) {
            self.parent = parent
        }

        func documentCameraViewController(
            _ controller: VNDocumentCameraViewController,
            didFinishWith scan: VNDocumentCameraScan
        ) {
            parent.onScan((0..<scan.pageCount).map(scan.imageOfPage(at:)))
        }

        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            parent.onCancel()
        }

        func documentCameraViewController(
            _ controller: VNDocumentCameraViewController,
            didFailWithError error: Error
        ) {
            parent.onError(error)
        }
    }
}

enum TaskAttachmentPDFRenderer {
    private static let pageBounds = CGRect(x: 0, y: 0, width: 612, height: 792)
    private static let pageInset: CGFloat = 18

    static func pdfData(from pages: [UIImage]) throws -> Data {
        guard !pages.isEmpty else { throw TaskAttachmentUploadError.unsupportedFile }

        let renderer = UIGraphicsPDFRenderer(bounds: pageBounds)
        let data = renderer.pdfData { context in
            for image in pages {
                context.beginPage()
                UIColor.white.setFill()
                context.fill(pageBounds)

                let availableBounds = pageBounds.insetBy(dx: pageInset, dy: pageInset)
                image.draw(in: aspectFitRect(for: image.size, inside: availableBounds))
            }
        }
        guard !data.isEmpty else { throw TaskAttachmentUploadError.unsupportedFile }
        return data
    }

    private static func aspectFitRect(for size: CGSize, inside bounds: CGRect) -> CGRect {
        guard size.width > 0, size.height > 0 else { return bounds }
        let scale = min(bounds.width / size.width, bounds.height / size.height)
        let fittedSize = CGSize(width: size.width * scale, height: size.height * scale)
        return CGRect(
            x: bounds.midX - (fittedSize.width / 2),
            y: bounds.midY - (fittedSize.height / 2),
            width: fittedSize.width,
            height: fittedSize.height
        )
    }
}

// MARK: - Multi-photo chat camera

/// Owns the AVCapture session for the chat composer's multi-photo camera. Photos remain in the
/// SwiftUI picker until Done; only then does the existing chat attachment pipeline receive them.
final class MultiPhotoCameraModel: NSObject, ObservableObject, @unchecked Sendable {
    @Published private(set) var isReady = false
    @Published private(set) var isCapturing = false
    @Published private(set) var canSwitchCamera = true
    @Published private(set) var flashMode: AVCaptureDevice.FlashMode = .off
    @Published private(set) var statusMessage: String?

    let session = AVCaptureSession()
    private let photoOutput = AVCapturePhotoOutput()
    private let sessionQueue = DispatchQueue(label: "taskify.chat.multi-photo-camera")
    private var currentInput: AVCaptureDeviceInput?
    private var currentPosition: AVCaptureDevice.Position = .back
    private var photoDelegates: [Int64: PhotoCaptureDelegate] = [:]
    private var notificationTokens: [NSObjectProtocol] = []
    private let fixtureMode = ProcessInfo.processInfo.environment["TASKIFY_UI_TEST_MULTI_PHOTO_CAMERA"] == "1"

    override init() {
        super.init()
        let center = NotificationCenter.default
        notificationTokens.append(center.addObserver(
            forName: .AVCaptureSessionRuntimeError,
            object: session,
            queue: .main
        ) { [weak self] notification in
            guard let error = notification.userInfo?[AVCaptureSessionErrorKey] as? Error else { return }
            self?.isReady = false
            self?.statusMessage = error.localizedDescription
        })
        notificationTokens.append(center.addObserver(
            forName: .AVCaptureSessionWasInterrupted,
            object: session,
            queue: .main
        ) { [weak self] _ in
            self?.statusMessage = "The camera session was interrupted."
        })
    }

    deinit {
        notificationTokens.forEach(NotificationCenter.default.removeObserver)
    }

    func prepare() async {
        if fixtureMode {
            DispatchQueue.main.async { [weak self] in
                self?.isReady = true
                self?.canSwitchCamera = false
                self?.statusMessage = nil
            }
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            await startSession(position: currentPosition)
        case .notDetermined:
            let granted = await withCheckedContinuation { continuation in
                AVCaptureDevice.requestAccess(for: .video) { continuation.resume(returning: $0) }
            }
            if granted {
                await startSession(position: currentPosition)
            } else {
                statusMessage = "Allow Camera access in Settings to take photos."
            }
        case .denied, .restricted:
            statusMessage = "Allow Camera access in Settings to take photos."
        @unknown default:
            statusMessage = "Camera access is unavailable."
        }
    }

    func stop() {
        guard !fixtureMode else { return }
        sessionQueue.async { [weak self] in
            guard let self, self.session.isRunning else { return }
            self.session.stopRunning()
        }
        isReady = false
    }

    func switchCamera() {
        guard canSwitchCamera, !isCapturing, !fixtureMode else { return }
        let next: AVCaptureDevice.Position = currentPosition == .back ? .front : .back
        currentPosition = next
        isReady = false
        Task { await startSession(position: next) }
    }

    func cycleFlash() {
        guard !fixtureMode else { return }
        switch flashMode {
        case .off: flashMode = .auto
        case .auto: flashMode = .on
        default: flashMode = .off
        }
    }

    func capturePhoto(completion: @escaping (UIImage?) -> Void) {
        guard isReady, !isCapturing else { return }
        isCapturing = true
        let settings = AVCapturePhotoSettings()
        let device = currentInput?.device
        if let device, device.hasFlash, photoOutput.supportedFlashModes.contains(flashMode) {
            settings.flashMode = flashMode
        }
        if let connection = photoOutput.connection(with: .video),
           connection.isVideoRotationAngleSupported(90) {
            connection.videoRotationAngle = 90
        }
        let captureID = settings.uniqueID
        let delegate = PhotoCaptureDelegate { [weak self] image, error in
            guard let self else { return }
            self.photoDelegates.removeValue(forKey: captureID)
            self.isCapturing = false
            if let error {
                self.statusMessage = error.localizedDescription
            }
            completion(image)
        }
        photoDelegates[captureID] = delegate
        photoOutput.capturePhoto(with: settings, delegate: delegate)
    }

    private func startSession(position: AVCaptureDevice.Position) async {
        await withCheckedContinuation { continuation in
            sessionQueue.async { [weak self] in
                guard let self else {
                    continuation.resume()
                    return
                }
                let result = self.configure(position: position)
                DispatchQueue.main.async {
                    self.isReady = result == nil
                    self.statusMessage = result
                    self.canSwitchCamera = self.hasCamera(.front) && self.hasCamera(.back)
                    continuation.resume()
                }
            }
        }
    }

    private func configure(position: AVCaptureDevice.Position) -> String? {
        guard let device = AVCaptureDevice.default(
            .builtInWideAngleCamera,
            for: .video,
            position: position
        ) else {
            return "No camera is available on this device."
        }
        let input: AVCaptureDeviceInput
        do {
            input = try AVCaptureDeviceInput(device: device)
        } catch {
            return error.localizedDescription
        }
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        if let currentInput { session.removeInput(currentInput) }
        session.sessionPreset = .photo
        guard session.canAddInput(input) else {
            return "The camera could not start."
        }
        if !session.outputs.contains(where: { $0 === photoOutput }) {
            guard session.canAddOutput(photoOutput) else {
                return "The camera could not start."
            }
            session.addOutput(photoOutput)
        }
        session.addInput(input)
        photoOutput.maxPhotoQualityPrioritization = .balanced
        currentInput = input
        currentPosition = position
        if !session.isRunning { session.startRunning() }
        return nil
    }

    private func hasCamera(_ position: AVCaptureDevice.Position) -> Bool {
        AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position) != nil
    }

    private final class PhotoCaptureDelegate: NSObject, AVCapturePhotoCaptureDelegate {
        private let completion: (UIImage?, Error?) -> Void

        init(completion: @escaping (UIImage?, Error?) -> Void) {
            self.completion = completion
        }

        func photoOutput(
            _ output: AVCapturePhotoOutput,
            didFinishProcessingPhoto photo: AVCapturePhoto,
            error: Error?
        ) {
            let image = photo.fileDataRepresentation().flatMap(UIImage.init(data:))
            DispatchQueue.main.async {
                self.completion(image, error)
            }
        }
    }
}

private final class MultiPhotoCameraPreviewLayerView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}

private struct MultiPhotoCameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> MultiPhotoCameraPreviewLayerView {
        let view = MultiPhotoCameraPreviewLayerView()
        view.backgroundColor = .black
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        if let connection = view.previewLayer.connection,
           connection.isVideoRotationAngleSupported(90) {
            connection.videoRotationAngle = 90
        }
        return view
    }

    func updateUIView(_ view: MultiPhotoCameraPreviewLayerView, context: Context) {
        if view.previewLayer.session !== session {
            view.previewLayer.session = session
        }
        if let connection = view.previewLayer.connection,
           connection.isVideoRotationAngleSupported(90) {
            connection.videoRotationAngle = 90
        }
    }
}

struct MultiPhotoCameraPicker: View {
    @Environment(\.dismiss) private var dismiss
    let maximumCount: Int
    let onDone: ([UIImage]) -> Void
    let onCancel: () -> Void

    @StateObject private var camera = MultiPhotoCameraModel()
    @State private var selection: MultiPhotoCaptureSelection
    @State private var photos: [UIImage] = []
    private let fixtureMode = ProcessInfo.processInfo.environment["TASKIFY_UI_TEST_MULTI_PHOTO_CAMERA"] == "1"

    init(
        maximumCount: Int,
        onDone: @escaping ([UIImage]) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.maximumCount = maximumCount
        self.onDone = onDone
        self.onCancel = onCancel
        _selection = State(initialValue: MultiPhotoCaptureSelection(maximumCount: maximumCount))
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if fixtureMode {
                LinearGradient(
                    colors: [Color(red: 0.18, green: 0.24, blue: 0.34), Color(red: 0.06, green: 0.07, blue: 0.1)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
                .ignoresSafeArea()
                Text("Camera test fixture")
                    .font(.headline)
                    .foregroundStyle(.white.opacity(0.42))
            } else if camera.isReady {
                MultiPhotoCameraPreview(session: camera.session)
                    .ignoresSafeArea()
            } else {
                VStack(spacing: 12) {
                    ProgressView().tint(.white)
                    Text(camera.statusMessage ?? "Starting camera…")
                        .font(.subheadline)
                        .foregroundStyle(.white.opacity(0.8))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }
            }

            VStack(spacing: 0) {
                topBar
                Spacer()
                bottomPanel
            }
        }
        .task { await camera.prepare() }
        .onDisappear { camera.stop() }
    }

    private var topBar: some View {
        HStack(spacing: 12) {
            Button(action: cancel) {
                Image(systemName: "xmark")
                    .font(.system(size: 16, weight: .bold))
                    .frame(width: 44, height: 44)
                    .background(.black.opacity(0.42), in: Circle())
            }
            .accessibilityLabel("Cancel camera")
            .accessibilityIdentifier("multi-photo-camera-cancel")

            Spacer()

            Text("\(selection.count)/\(selection.maximumCount)")
                .font(.subheadline.weight(.semibold).monospacedDigit())
                .padding(.horizontal, 12)
                .frame(height: 36)
                .background(.black.opacity(0.42), in: Capsule())
                .accessibilityLabel("\(selection.count) of \(selection.maximumCount) photos")

            Spacer()

            if !fixtureMode {
                Button {
                    camera.cycleFlash()
                } label: {
                    Image(systemName: flashSymbol)
                        .font(.system(size: 16, weight: .semibold))
                        .frame(width: 44, height: 44)
                        .background(.black.opacity(0.42), in: Circle())
                }
                .disabled(!camera.isReady)
                .accessibilityLabel("Flash \(flashLabel)")

                Button {
                    camera.switchCamera()
                } label: {
                    Image(systemName: "arrow.triangle.2.circlepath.camera")
                        .font(.system(size: 16, weight: .semibold))
                        .frame(width: 44, height: 44)
                        .background(.black.opacity(0.42), in: Circle())
                }
                .disabled(!camera.canSwitchCamera || !camera.isReady)
                .accessibilityLabel("Switch camera")
            } else {
                Color.clear.frame(width: 92, height: 44)
            }
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 16)
        .padding(.top, 10)
    }

    private var bottomPanel: some View {
        VStack(spacing: 12) {
            if !photos.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Array(photos.enumerated()), id: \.offset) { index, image in
                            ZStack(alignment: .topTrailing) {
                                Image(uiImage: image)
                                    .resizable()
                                    .scaledToFill()
                                    .frame(width: 58, height: 58)
                                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                    .accessibilityHidden(true)
                                Button {
                                    removePhoto(at: index)
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .font(.system(size: 19, weight: .semibold))
                                        .symbolRenderingMode(.palette)
                                        .foregroundStyle(.white, .black.opacity(0.72))
                                }
                                .buttonStyle(.plain)
                                .offset(x: 5, y: -5)
                                .accessibilityLabel("Remove photo \(index + 1)")
                                .accessibilityIdentifier("multi-photo-camera-remove-\(index)")
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 7)
                }
            }

            HStack(spacing: 22) {
                Button {
                    if selection.removeLast(), !photos.isEmpty { photos.removeLast() }
                } label: {
                    Text("Retake")
                        .font(.subheadline.weight(.semibold))
                        .frame(minWidth: 72, minHeight: 44)
                }
                .disabled(photos.isEmpty)
                .opacity(photos.isEmpty ? 0.42 : 1)
                .accessibilityIdentifier("multi-photo-camera-retake")

                Button {
                    capture()
                } label: {
                    ZStack {
                        Circle().stroke(.white, lineWidth: 5).frame(width: 76, height: 76)
                        Circle().fill(.white).frame(width: 60, height: 60)
                        if camera.isCapturing {
                            ProgressView().tint(.black)
                        }
                    }
                }
                .disabled(!selection.canCapture || (camera.isCapturing || (!camera.isReady && !fixtureMode)))
                .opacity(selection.canCapture ? 1 : 0.45)
                .accessibilityLabel("Take photo")
                .accessibilityIdentifier("multi-photo-camera-capture")

                Button {
                    guard !photos.isEmpty else { return }
                    dismiss()
                    onDone(photos)
                } label: {
                    Text("Done")
                        .font(.subheadline.bold())
                        .frame(minWidth: 72, minHeight: 44)
                        .background(.white.opacity(photos.isEmpty ? 0.12 : 0.22), in: Capsule())
                }
                .disabled(photos.isEmpty)
                .accessibilityIdentifier("multi-photo-camera-done")
            }
            .foregroundStyle(.white)

            if selection.canCapture {
                Text("\(selection.remainingCount) photo\(selection.remainingCount == 1 ? "" : "s") remaining")
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.66))
            } else {
                Text("Maximum \(selection.maximumCount) photos reached")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }
        }
        .padding(.bottom, 14)
        .padding(.top, 10)
        .background(
            LinearGradient(
                colors: [.clear, .black.opacity(0.78)],
                startPoint: .top,
                endPoint: .bottom
            )
        )
    }

    private func cancel() {
        dismiss()
        onCancel()
    }

    private var flashLabel: String {
        switch camera.flashMode {
        case .auto: "Automatic"
        case .on: "On"
        default: "Off"
        }
    }

    private var flashSymbol: String {
        switch camera.flashMode {
        case .auto: "bolt.badge.automatic.fill"
        case .on: "bolt.fill"
        default: "bolt.slash.fill"
        }
    }

    private func capture() {
        if fixtureMode {
            addFixturePhoto()
            return
        }
        camera.capturePhoto { image in
            guard let image else { return }
            addPhoto(image)
        }
    }

    private func addPhoto(_ image: UIImage) {
        guard selection.add() else { return }
        photos.append(image)
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        if !selection.canCapture {
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        }
    }

    private func removePhoto(at index: Int) {
        guard selection.remove(at: index), photos.indices.contains(index) else { return }
        photos.remove(at: index)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    private func addFixturePhoto() {
        let index = selection.count
        let colors: [UIColor] = [.systemTeal, .systemOrange, .systemPurple, .systemGreen, .systemPink]
        let image = UIGraphicsImageRenderer(size: CGSize(width: 320, height: 320)).image { context in
            colors[index % colors.count].setFill()
            context.fill(CGRect(x: 0, y: 0, width: 320, height: 320))
            UIColor.white.withAlphaComponent(0.28).setFill()
            context.fill(CGRect(x: 0, y: 230, width: 320, height: 90))
        }
        addPhoto(image)
    }
}
