import AVFoundation
import CryptoKit
import Foundation
import Observation
import SwiftUI
import TaskifyWatchShared

@MainActor
@Observable
final class TaskifyWatchAudioPlayback {
    static let shared = TaskifyWatchAudioPlayback()

    private(set) var attachmentURL: URL?
    private(set) var isLoading = false
    private(set) var isPlaying = false
    private(set) var currentTime: TimeInterval = 0
    private(set) var duration: TimeInterval = 0
    private(set) var errorMessage: String?

    private var player: AVPlayer?
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var loadTask: Task<Void, Never>?
    private var localFile: URL?
    /// Counts seeks so the periodic observer stops reporting the pre-seek position, which
    /// would otherwise snap the scrubber back for a moment after it is released.
    private var seekGeneration = 0
    private var isSeeking = false

    func isCurrent(_ attachment: TaskifyWatchChatAttachment) -> Bool {
        attachmentURL == attachment.url
    }

    func toggle(_ attachment: TaskifyWatchChatAttachment) {
        guard isCurrent(attachment) else {
            loadAndPlay(attachment)
            return
        }
        guard !isLoading else { return }
        if player == nil {
            loadAndPlay(attachment)
        } else if isPlaying {
            pause()
        } else {
            play()
        }
    }

    /// Skipping only moves a message that is already loaded; the card disables the skip
    /// buttons until then, since there is no position to skip from.
    func seek(by offset: TimeInterval, attachment: TaskifyWatchChatAttachment) {
        guard isCurrent(attachment), player != nil, !isLoading else { return }
        seek(to: currentTime + offset)
    }

    func seek(toFraction fraction: Double, attachment: TaskifyWatchChatAttachment) {
        guard isCurrent(attachment), player != nil, !isLoading, duration > 0 else { return }
        seek(to: min(max(fraction, 0), 1) * duration)
    }

    func pauseForRecording() { pause() }

    private func loadAndPlay(_ attachment: TaskifyWatchChatAttachment) {
        loadTask?.cancel()
        removeObservers()
        player?.pause()
        player = nil
        if let localFile { try? FileManager.default.removeItem(at: localFile) }
        localFile = nil
        attachmentURL = attachment.url
        currentTime = 0
        duration = 0
        isPlaying = false
        isLoading = true
        errorMessage = nil

        let expectedURL = attachment.url
        loadTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let file = try await TaskifyWatchAudioTransfer.decrypt(attachment)
                try Task.checkCancellation()
                guard self.attachmentURL == expectedURL else {
                    try? FileManager.default.removeItem(at: file)
                    return
                }
                self.localFile = file
                try self.activatePlaybackSession()
                let asset = ChatAudioPlayback.asset(file: file, mimeType: attachment.mimeType)
                let loadedDuration = try? await asset.load(.duration)
                try Task.checkCancellation()
                guard self.attachmentURL == expectedURL else { return }
                let item = AVPlayerItem(asset: asset)
                let player = AVPlayer(playerItem: item)
                self.player = player
                if let loadedDuration { self.duration = Self.seconds(loadedDuration) }
                self.installObservers(player: player, item: item)
                self.isLoading = false
                self.play()
            } catch is CancellationError {
                // A different message replaced this load.
            } catch {
                guard self.attachmentURL == expectedURL else { return }
                self.isLoading = false
                self.isPlaying = false
                self.errorMessage = error.localizedDescription
            }
        }
    }

    private func activatePlaybackSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .spokenAudio)
        try session.setActive(true)
    }

    private func play() {
        guard let player else { return }
        do {
            try activatePlaybackSession()
            if duration > 0, currentTime >= duration - 0.25 { seek(to: 0) }
            player.play()
            isPlaying = true
            errorMessage = nil
        } catch {
            isPlaying = false
            errorMessage = error.localizedDescription
        }
    }

    private func pause() {
        player?.pause()
        isPlaying = false
    }

    private func seek(to requested: TimeInterval) {
        guard let player else { return }
        let target = min(max(0, requested), duration > 0 ? duration : max(0, requested))
        seekGeneration += 1
        let generation = seekGeneration
        isSeeking = true
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600),
                    toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.seekGeneration == generation else { return }
                self.isSeeking = false
            }
        }
        currentTime = target
    }

    private func installObservers(player: AVPlayer, item: AVPlayerItem) {
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main
        ) { [weak self, weak player] time in
            Task { @MainActor in
                guard let self, let player, self.player === player, !self.isSeeking else { return }
                self.currentTime = Self.seconds(time)
                let itemDuration = Self.seconds(player.currentItem?.duration ?? .invalid)
                if itemDuration > 0 { self.duration = itemDuration }
                self.isPlaying = player.timeControlStatus == .playing
            }
        }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
        ) { [weak self, weak item] notification in
            Task { @MainActor in
                guard let self, notification.object as? AVPlayerItem === item,
                      self.player?.currentItem === item else { return }
                self.currentTime = self.duration
                self.isPlaying = false
            }
        }
    }

    private func removeObservers() {
        if let timeObserver, let player { player.removeTimeObserver(timeObserver) }
        timeObserver = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
    }

    private static func seconds(_ time: CMTime) -> TimeInterval {
        let value = CMTimeGetSeconds(time)
        return value.isFinite && value >= 0 ? value : 0
    }
}

@MainActor
@Observable
final class TaskifyWatchAudioRecorder {
    struct Recording {
        let fileURL: URL
        let filename: String
    }

    private(set) var isRecording = false
    private(set) var isRequestingPermission = false
    private(set) var elapsed: TimeInterval = 0
    private var recorder: AVAudioRecorder?
    private var timer: Task<Void, Never>?
    private var fileURL: URL?

    func start() async throws {
        guard !isRecording, !isRequestingPermission else { return }
        isRequestingPermission = true
        defer { isRequestingPermission = false }
        let granted = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard granted else { throw TaskifyWatchAudioError.permissionDenied }
        TaskifyWatchAudioPlayback.shared.pauseForRecording()
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default)
        try session.setActive(true)
        let directory = FileManager.default.temporaryDirectory
        let url = directory.appendingPathComponent("\(UUID().uuidString).m4a")
        let recorder = try AVAudioRecorder(url: url, settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 64_000,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ])
        guard recorder.prepareToRecord(), recorder.record() else {
            try? FileManager.default.removeItem(at: url)
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            throw TaskifyWatchAudioError.couldNotStart
        }
        self.recorder = recorder
        fileURL = url
        elapsed = 0
        isRecording = true
        timer = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                guard let self else { return }
                self.elapsed = self.recorder?.currentTime ?? self.elapsed
            }
        }
    }

    func finish() throws -> Recording {
        guard let recorder, let fileURL, isRecording else { throw TaskifyWatchAudioError.noRecording }
        let duration = max(elapsed, recorder.currentTime)
        recorder.stop()
        timer?.cancel()
        timer = nil
        self.recorder = nil
        self.fileURL = nil
        isRecording = false
        elapsed = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        let size = try fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard duration > 0, size > 0, size <= TaskifyWatchAudioTransfer.maximumPlaintextBytes else {
            try? FileManager.default.removeItem(at: fileURL)
            throw TaskifyWatchAudioError.empty
        }
        return Recording(fileURL: fileURL, filename: "Audio Message \(Int(Date().timeIntervalSince1970)).m4a")
    }

    func cancel() {
        recorder?.stop()
        timer?.cancel()
        if let fileURL { try? FileManager.default.removeItem(at: fileURL) }
        recorder = nil
        timer = nil
        fileURL = nil
        isRecording = false
        elapsed = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

enum TaskifyWatchAudioError: LocalizedError {
    case permissionDenied, couldNotStart, noRecording, empty, invalidAttachment, fileServerUnavailable
    case tooLarge, invalidServer, uploadFailed
    var errorDescription: String? {
        switch self {
        case .permissionDenied: "Allow Microphone access to record audio messages."
        case .couldNotStart: "The audio recording couldn't start."
        case .noRecording: "There isn't an audio recording to send."
        case .empty: "The audio recording was empty. Please try again."
        case .invalidAttachment: "This audio message is invalid."
        case .fileServerUnavailable: "Open Taskify on iPhone and sync this Watch before sending audio."
        case .tooLarge: "This audio message is too large to send from Apple Watch."
        case .invalidServer: "The configured encrypted file server is invalid."
        case .uploadFailed: "The encrypted audio upload failed. Please try again."
        }
    }
}

struct TaskifyWatchEncryptedAudio: Sendable {
    let ciphertext: Data
    let keyHex: String
    let nonceHex: String
    let sha256: String
    let plaintextSize: Int
}

enum TaskifyWatchAudioTransfer {
    static let maximumPlaintextBytes = 25 * 1_024 * 1_024

    static func encrypt(_ fileURL: URL) throws -> TaskifyWatchEncryptedAudio {
        let plaintext = try Data(contentsOf: fileURL, options: .mappedIfSafe)
        guard !plaintext.isEmpty, plaintext.count <= maximumPlaintextBytes else {
            throw plaintext.isEmpty ? TaskifyWatchAudioError.empty : TaskifyWatchAudioError.tooLarge
        }
        let key = SymmetricKey(size: .bits256)
        var generator = SystemRandomNumberGenerator()
        let nonceData = Data((0..<16).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
        let box = try AES.GCM.seal(plaintext, using: key, nonce: AES.GCM.Nonce(data: nonceData))
        let ciphertext = box.ciphertext + box.tag
        let keyData = key.withUnsafeBytes { Data($0) }
        return TaskifyWatchEncryptedAudio(
            ciphertext: ciphertext,
            keyHex: keyData.watchAudioHex,
            nonceHex: nonceData.watchAudioHex,
            sha256: Data(SHA256.hash(data: ciphertext)).watchAudioHex,
            plaintextSize: plaintext.count
        )
    }

    static func decrypt(_ attachment: TaskifyWatchChatAttachment) async throws -> URL {
        var request = URLRequest(url: attachment.url, timeoutInterval: 60)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (ciphertext, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse,
              (200..<300).contains(response.statusCode),
              ciphertext.count <= maximumPlaintextBytes + 16,
              ciphertext.count >= 16 else { throw TaskifyWatchAudioError.invalidAttachment }
        if let expected = attachment.ciphertextSHA256,
           Data(SHA256.hash(data: ciphertext)).watchAudioHex != expected.lowercased() {
            throw TaskifyWatchAudioError.invalidAttachment
        }
        guard let key = Data(watchAudioHex: attachment.keyHex),
              let nonce = Data(watchAudioHex: attachment.nonceHex),
              key.count == 32, nonce.count == 16 else { throw TaskifyWatchAudioError.invalidAttachment }
        let tagStart = ciphertext.index(ciphertext.endIndex, offsetBy: -16)
        let box = try AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(data: nonce),
            ciphertext: ciphertext[..<tagStart],
            tag: ciphertext[tagStart...]
        )
        let plaintext = try AES.GCM.open(box, using: SymmetricKey(data: key))
        guard plaintext.count <= maximumPlaintextBytes,
              attachment.size == nil || attachment.size == plaintext.count else {
            throw TaskifyWatchAudioError.invalidAttachment
        }
        let file = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskify-watch-audio-\(UUID().uuidString).m4a")
        try plaintext.write(to: file, options: [.atomic, .completeFileProtection])
        return file
    }

    static func opaqueUploadFilename(ciphertextSHA256: String) -> String? {
        let hash = ciphertextSHA256.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard hash.count == 64, hash.allSatisfy({ $0.isHexDigit }) else { return nil }
        return hash + ".bin"
    }

    static func upload(
        _ encrypted: TaskifyWatchEncryptedAudio,
        serverURL: String,
        serverType: String,
        privateKey: Data
    ) async throws -> String {
        guard let uploadFilename = opaqueUploadFilename(ciphertextSHA256: encrypted.sha256) else {
            throw TaskifyWatchAudioError.invalidAttachment
        }
        guard let base = URL(string: serverURL), base.scheme?.lowercased() == "https", base.host != nil else {
            throw TaskifyWatchAudioError.invalidServer
        }
        let endpoint: URL
        let method: String
        let isNIP96 = serverType == "nip96"
        if isNIP96 {
            endpoint = try await nip96Endpoint(base)
            method = "POST"
        } else if serverType == "blossom" {
            endpoint = base.appendingPathComponent("upload")
            method = "PUT"
        } else if serverType == "originless" {
            endpoint = base.appendingPathComponent("up")
            method = "POST"
        } else {
            throw TaskifyWatchAudioError.invalidServer
        }
        var request = URLRequest(url: endpoint, timeoutInterval: 120)
        request.httpMethod = method
        if serverType == "blossom" {
            request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            request.setValue(try authHeader(
                kind: 24_242,
                tags: [["t", "upload"], ["x", encrypted.sha256],
                       ["expiration", String(Int(Date().timeIntervalSince1970) + 3_600)]],
                content: "Upload Blob",
                privateKey: privateKey,
                urlSafe: true
            ), forHTTPHeaderField: "Authorization")
            request.httpBody = encrypted.ciphertext
        } else {
            let boundary = "TaskifyWatch-\(UUID().uuidString)"
            request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            request.httpBody = multipart(
                encrypted.ciphertext, filename: uploadFilename, boundary: boundary, includeMetadata: isNIP96
            )
            if isNIP96 {
                request.setValue(try authHeader(
                    kind: 27_235,
                    tags: [["u", endpoint.absoluteString], ["method", "POST"],
                           ["payload", encrypted.sha256]],
                    content: "",
                    privateKey: privateKey,
                    urlSafe: false
                ), forHTTPHeaderField: "Authorization")
            }
        }
        var (data, response) = try await URLSession.shared.data(for: request)
        guard var http = response as? HTTPURLResponse else { throw TaskifyWatchAudioError.uploadFailed }
        if http.statusCode == 202,
           let processingURL = jsonString("processing_url", in: data).flatMap({ URL(string: $0, relativeTo: endpoint)?.absoluteURL }) {
            for _ in 0..<12 where http.statusCode == 202 {
                try await Task.sleep(for: .seconds(1))
                var poll = URLRequest(url: processingURL, timeoutInterval: 20)
                poll.setValue(request.value(forHTTPHeaderField: "Authorization"), forHTTPHeaderField: "Authorization")
                (data, response) = try await URLSession.shared.data(for: poll)
                guard let next = response as? HTTPURLResponse else { throw TaskifyWatchAudioError.uploadFailed }
                http = next
            }
        }
        guard (200..<300).contains(http.statusCode), http.statusCode != 202 else {
            throw TaskifyWatchAudioError.uploadFailed
        }
        return try remoteURL(data: data, base: base)
    }

    private static func nip96Endpoint(_ base: URL) async throws -> URL {
        let discovery = base.appendingPathComponent(".well-known/nostr/nip96.json")
        let (data, response) = try await URLSession.shared.data(from: discovery)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              let raw = jsonString("api_url", in: data),
              let endpoint = URL(string: raw, relativeTo: base)?.absoluteURL,
              endpoint.scheme?.lowercased() == "https" else { throw TaskifyWatchAudioError.invalidServer }
        return endpoint
    }

    private static func authHeader(
        kind: Int, tags: [[String]], content: String, privateKey: Data, urlSafe: Bool
    ) throws -> String {
        let event = try TaskifyWatchNostrCrypto.signedEvent(
            privateKey: privateKey,
            createdAt: Int(Date().timeIntervalSince1970),
            kind: kind,
            tags: tags,
            content: content
        )
        var value = try JSONEncoder().encode(event).base64EncodedString()
        if urlSafe {
            value = value.replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        return "Nostr \(value)"
    }

    private static func multipart(
        _ data: Data, filename: String, boundary: String, includeMetadata: Bool
    ) -> Data {
        let safe = filename.replacingOccurrences(of: "\"", with: "'")
            .replacingOccurrences(of: "\r", with: " ").replacingOccurrences(of: "\n", with: " ")
        var body = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(safe)\"\r\nContent-Type: application/octet-stream\r\n\r\n".utf8)
        body.append(data)
        body.append(Data("\r\n".utf8))
        if includeMetadata {
            for (key, value) in [("filename", safe), ("content_type", "application/octet-stream"),
                                 ("size", String(data.count))] {
                body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(key)\"\r\n\r\n\(value)\r\n".utf8))
            }
        }
        body.append(Data("--\(boundary)--\r\n".utf8))
        return body
    }

    private static func remoteURL(data: Data, base: URL) throws -> String {
        guard let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw TaskifyWatchAudioError.uploadFailed
        }
        if let nip94 = (payload["nip94_event"] ?? payload["nip94"]) as? [String: Any],
           let tags = nip94["tags"] as? [[Any]] {
            for tag in tags where tag.count >= 2 && tag[0] as? String == "url" {
                if let raw = tag[1] as? String, let url = validRemote(raw) { return url.absoluteString }
            }
        }
        for key in ["url", "cidUrl", "gatewayUrl", "fileUrl", "ipfs"] {
            if let raw = payload[key] as? String, let url = validRemote(raw) { return url.absoluteString }
        }
        if let cid = (payload["cid"] ?? payload["ipfs"]) as? String,
           (cid.count >= 46 || cid.hasPrefix("b")),
           cid.allSatisfy({ $0.isLetter || $0.isNumber }) {
            return "https://dweb.link/ipfs/\(cid)"
        }
        if let path = payload["path"] as? String,
           let url = validRemote(URL(string: path, relativeTo: base)?.absoluteString ?? "") {
            return url.absoluteString
        }
        throw TaskifyWatchAudioError.uploadFailed
    }

    private static func jsonString(_ key: String, in data: Data) -> String? {
        (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?[key] as? String
    }

    private static func validRemote(_ value: String) -> URL? {
        guard let url = URL(string: value), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              url.host != nil else { return nil }
        return url
    }
}

private extension Data {
    init?(watchAudioHex value: String) {
        guard value.count.isMultiple(of: 2) else { return nil }
        var result = Data(capacity: value.count / 2)
        var index = value.startIndex
        while index < value.endIndex {
            let next = value.index(index, offsetBy: 2)
            guard let byte = UInt8(value[index..<next], radix: 16) else { return nil }
            result.append(byte)
            index = next
        }
        self = result
    }

    var watchAudioHex: String { map { String(format: "%02x", $0) }.joined() }
}

struct TaskifyWatchAudioAttachmentView: View {
    let attachment: TaskifyWatchChatAttachment
    @State private var playback = TaskifyWatchAudioPlayback.shared
    @State private var scrubFraction: Double?

    private var current: Bool { playback.isCurrent(attachment) }
    private var isLoading: Bool { current && playback.isLoading }
    private var isPlaying: Bool { current && playback.isPlaying }
    private var isLoaded: Bool { current && !playback.isLoading && playback.duration > 0 }
    private var duration: TimeInterval { current ? playback.duration : 0 }
    private var progress: Double {
        if let scrubFraction { return scrubFraction }
        guard duration > 0 else { return 0 }
        return playback.currentTime / duration
    }

    var body: some View {
        VStack(spacing: 3) {
            HStack(spacing: 4) {
                Image(systemName: "waveform").foregroundStyle(.tint).accessibilityHidden(true)
                Text(ChatAudioPlayback.title(forFilename: attachment.filename ?? "Audio"))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
            }
            .font(.caption2.weight(.semibold))

            HStack(spacing: 12) {
                skip("gobackward.10", label: "Back 10 seconds", by: -10)
                Button { playback.toggle(attachment) } label: {
                    ZStack {
                        if isLoading {
                            ProgressView().controlSize(.mini)
                        } else {
                            Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                                .font(.system(size: 14, weight: .semibold))
                        }
                    }
                    .frame(width: 30, height: 30)
                    .background(Color.accentColor.opacity(0.7), in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(isLoading)
                .accessibilityLabel(isLoading ? "Loading audio" : (isPlaying ? "Pause audio" : "Play audio"))
                skip("goforward.10", label: "Forward 10 seconds", by: 10)
            }
            .frame(maxWidth: .infinity)

            HStack(spacing: 4) {
                Text(ChatAudioPlayback.timeLabel(progress * duration))
                ChatAudioScrubber(
                    progress: progress,
                    duration: duration,
                    tint: .accentColor,
                    track: Color.white.opacity(0.18),
                    isEnabled: isLoaded,
                    onScrub: { scrubFraction = $0 },
                    onCommit: { playback.seek(toFraction: $0, attachment: attachment) }
                )
                Text(duration > 0 ? ChatAudioPlayback.timeLabel(duration) : "--:--")
            }
            .font(.system(size: 10).monospacedDigit())
            .foregroundStyle(.secondary)

            if current, let error = playback.errorMessage {
                Text(error).font(.caption2).foregroundStyle(.red).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func skip(_ name: String, label: String, by offset: TimeInterval) -> some View {
        Button { playback.seek(by: offset, attachment: attachment) } label: {
            Image(systemName: name).font(.system(size: 14, weight: .medium)).frame(width: 26, height: 26)
        }
        .buttonStyle(.plain)
        .disabled(!isLoaded)
        .opacity(isLoaded ? 1 : 0.4)
        .accessibilityLabel(label)
    }
}
