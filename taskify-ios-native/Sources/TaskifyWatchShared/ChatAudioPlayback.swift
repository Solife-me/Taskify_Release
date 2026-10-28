import AVFoundation
import SwiftUI

/// Playback pieces every chat client shares: the iPhone, Mac and Watch players and the audio
/// message card each of them draws.
public enum ChatAudioPlayback {
    /// Decrypted chat attachments are stored without a meaningful extension: the iPhone disk
    /// cache names files by hash and decryption writes `.bin`. AVFoundation refuses such a file
    /// with "Cannot Open", so the attachment's MIME type tells it what to parse instead. The type
    /// is only a hint, so a sender's mislabelled container still opens; an alias AVFoundation
    /// does not know (`audio/m4a`) falls back to MP4, the container every Taskify client records.
    public static func asset(file: URL, mimeType: String) -> AVURLAsset {
        let normalized = mimeType.lowercased()
        let hint = AVURLAsset.isPlayableExtendedMIMEType(normalized) ? normalized : "audio/mp4"
        return AVURLAsset(url: file, options: [AVURLAssetOverrideMIMETypeKey: hint])
    }

    /// `m:ss`, rounding down so the elapsed label never runs ahead of the audio.
    public static func timeLabel(_ interval: TimeInterval) -> String {
        let seconds = interval.isFinite ? max(0, Int(interval.rounded(.down))) : 0
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    /// Audio filenames carry a timestamp and an extension; the card shows the name without the
    /// extension so the timestamp is what survives truncation.
    public static func title(forFilename filename: String) -> String {
        let trimmed = (filename as NSString).deletingPathExtension
        return trimmed.isEmpty ? filename : trimmed
    }
}

/// A thin progress bar the listener can drag or tap to move through an audio message. It reports
/// the position live while dragging so the card can preview the time, and commits once on
/// release so the player seeks a single time rather than on every drag event.
public struct ChatAudioScrubber: View {
    private let progress: Double
    private let duration: TimeInterval
    private let tint: Color
    private let track: Color
    private let isEnabled: Bool
    private let onScrub: (Double?) -> Void
    private let onCommit: (Double) -> Void

    @State private var isDragging = false

    public init(
        progress: Double,
        duration: TimeInterval,
        tint: Color,
        track: Color,
        isEnabled: Bool,
        onScrub: @escaping (Double?) -> Void,
        onCommit: @escaping (Double) -> Void
    ) {
        self.progress = progress
        self.duration = duration
        self.tint = tint
        self.track = track
        self.isEnabled = isEnabled
        self.onScrub = onScrub
        self.onCommit = onCommit
    }

    public var body: some View {
        GeometryReader { geometry in
            let width = max(1, geometry.size.width)
            let clamped = min(max(progress, 0), 1)
            let knob: CGFloat = isDragging ? 13 : 9
            ZStack(alignment: .leading) {
                Capsule().fill(track).frame(height: 4)
                Capsule().fill(tint).frame(width: width * clamped, height: 4)
                if isEnabled {
                    Circle()
                        .fill(tint)
                        .frame(width: knob, height: knob)
                        .offset(x: min(max(0, width * clamped - knob / 2), width - knob))
                }
            }
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        guard isEnabled else { return }
                        isDragging = true
                        onScrub(fraction(at: value.location.x, width: width))
                    }
                    .onEnded { value in
                        guard isEnabled else { return }
                        isDragging = false
                        onScrub(nil)
                        onCommit(fraction(at: value.location.x, width: width))
                    },
                including: isEnabled ? .all : .none
            )
            .animation(.easeOut(duration: 0.12), value: isDragging)
        }
        .frame(height: 18)
        .accessibilityElement()
        .accessibilityLabel("Playback position")
        .accessibilityValue(
            duration > 0
                ? "\(ChatAudioPlayback.timeLabel(progress * duration)) of \(ChatAudioPlayback.timeLabel(duration))"
                : "Not playing"
        )
        .accessibilityAdjustableAction { direction in
            guard isEnabled, duration > 0 else { return }
            let step = min(1, 10 / duration)
            switch direction {
            case .increment: onCommit(min(1, progress + step))
            case .decrement: onCommit(max(0, progress - step))
            @unknown default: break
            }
        }
    }

    private func fraction(at x: CGFloat, width: CGFloat) -> Double {
        Double(min(max(0, x / width), 1))
    }
}

// MARK: - Recording

// The Watch records with its own simpler recorder; AVAssetExportSession, which joins a
// continued clip, does not exist on watchOS.
#if !os(watchOS)

/// Records an audio message for the iPhone and Mac composers. Stopping keeps the clip for
/// review; `start(continuing:)` records more onto a clip, the way Messages' "+ 0:01" button
/// does, and the pieces are joined into one file when that recording stops.
@MainActor
@Observable
public final class ChatAudioRecorder {
    public struct Recording: Equatable, Sendable {
        public let fileURL: URL
        public let duration: TimeInterval
        public let size: Int
        /// Normalized loudness (0...1) sampled every 100 ms, drawn as the clip's waveform.
        public let levels: [Float]

        public var suggestedName: String {
            let stamp = Date.now.formatted(
                .dateTime.year().month(.twoDigits).day(.twoDigits).hour(.twoDigits(amPM: .omitted))
                    .minute(.twoDigits).second(.twoDigits).locale(Locale(identifier: "en_US_POSIX"))
            )
            let safe = stamp.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: ".")
            return "Audio Message \(safe).m4a"
        }
    }

    public enum RecorderError: LocalizedError {
        case microphonePermissionDenied, couldNotStart, noRecording, emptyRecording, couldNotCombine

        public var errorDescription: String? {
            switch self {
            case .microphonePermissionDenied:
                "Taskify needs Microphone access to record audio messages. You can allow it in Settings."
            case .couldNotStart:
                "The audio recording couldn't start. Make sure another app isn't using the microphone."
            case .noRecording: "There isn't an audio recording to send."
            case .emptyRecording: "The audio recording was empty. Please try again."
            case .couldNotCombine: "The recording couldn't be continued. Please try again."
            }
        }
    }

    public private(set) var isRequestingPermission = false
    public private(set) var isRecording = false
    /// Length so far, including the clip being continued.
    public private(set) var elapsed: TimeInterval = 0
    /// Every level so far, including the clip being continued.
    public private(set) var levels: [Float] = []

    private let directory: () throws -> URL
    private let prepare: (URL) throws -> Void
    private let onWillRecord: @MainActor () -> Void
    private var recorder: AVAudioRecorder?
    private var segmentURL: URL?
    private var continuing: Recording?
    private var ticker: Task<Void, Never>?
    private var generation = UUID()

    /// - Parameters:
    ///   - directory: where recordings are written; the caller owns the files it receives.
    ///   - prepare: applied to each new file, for example to set data protection.
    ///   - onWillRecord: pauses any message playback before the microphone opens.
    public init(
        directory: @escaping () throws -> URL,
        prepare: @escaping (URL) throws -> Void = { _ in },
        onWillRecord: @escaping @MainActor () -> Void = {}
    ) {
        self.directory = directory
        self.prepare = prepare
        self.onWillRecord = onWillRecord
    }

    public func start(continuing previous: Recording? = nil) async throws {
        guard !isRecording, !isRequestingPermission else { return }
        let attempt = UUID()
        generation = attempt
        isRequestingPermission = true
        let granted = await Self.requestPermission()
        isRequestingPermission = false
        guard generation == attempt, !Task.isCancelled else { throw CancellationError() }
        guard granted else { throw RecorderError.microphonePermissionDenied }

        onWillRecord()
        try Self.activateRecordingSession()
        let url = try directory().appendingPathComponent("\(UUID().uuidString).m4a")
        do {
            let recorder = try AVAudioRecorder(url: url, settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 44_100,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 64_000,
                AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
            ])
            recorder.isMeteringEnabled = true
            guard recorder.prepareToRecord(), recorder.record() else { throw RecorderError.couldNotStart }
            try? prepare(url)
            self.recorder = recorder
            segmentURL = url
            continuing = previous
            levels = previous?.levels ?? []
            elapsed = previous?.duration ?? 0
            isRecording = true
            let base = previous?.duration ?? 0
            ticker = Task { @MainActor [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(100))
                    guard let self, !Task.isCancelled, let recorder = self.recorder else { return }
                    recorder.updateMeters()
                    self.elapsed = base + recorder.currentTime
                    self.levels.append(ChatAudioPlayback.normalizedLevel(power: recorder.averagePower(forChannel: 0)))
                }
            }
        } catch {
            try? FileManager.default.removeItem(at: url)
            Self.deactivateSession()
            throw error
        }
    }

    /// Stops recording and returns the whole clip, joined onto the one being continued.
    public func finish() async throws -> Recording {
        guard isRecording, let recorder, let segmentURL else { throw RecorderError.noRecording }
        let segmentDuration = recorder.currentTime
        let previous = continuing
        let allLevels = levels
        recorder.stop()
        reset()
        Self.deactivateSession()

        let size = (try? FileManager.default.attributesOfItem(atPath: segmentURL.path)[.size] as? Int) ?? 0
        guard size > 0, segmentDuration > 0 else {
            try? FileManager.default.removeItem(at: segmentURL)
            if let previous { return previous }
            throw RecorderError.emptyRecording
        }
        guard let previous else {
            return Recording(fileURL: segmentURL, duration: segmentDuration, size: size, levels: allLevels)
        }
        let joined = try directory().appendingPathComponent("\(UUID().uuidString).m4a")
        do {
            try await ChatAudioPlayback.concatenate([previous.fileURL, segmentURL], to: joined)
        } catch {
            try? FileManager.default.removeItem(at: segmentURL)
            try? FileManager.default.removeItem(at: joined)
            throw RecorderError.couldNotCombine
        }
        try? prepare(joined)
        try? FileManager.default.removeItem(at: segmentURL)
        try? FileManager.default.removeItem(at: previous.fileURL)
        let joinedSize = (try? FileManager.default.attributesOfItem(atPath: joined.path)[.size] as? Int) ?? 0
        return Recording(
            fileURL: joined,
            duration: previous.duration + segmentDuration,
            size: joinedSize,
            levels: allLevels
        )
    }

    /// Stops and deletes the segment being recorded. A clip being continued is left to its
    /// owner, which still holds it for review.
    public func cancel() {
        generation = UUID()
        recorder?.stop()
        if let segmentURL { try? FileManager.default.removeItem(at: segmentURL) }
        let wasActive = recorder != nil
        reset()
        if wasActive { Self.deactivateSession() }
    }

    private func reset() {
        ticker?.cancel()
        ticker = nil
        recorder = nil
        segmentURL = nil
        continuing = nil
        isRecording = false
        elapsed = 0
        levels = []
    }

    private static func requestPermission() async -> Bool {
        #if os(macOS)
        await AVCaptureDevice.requestAccess(for: .audio)
        #else
        await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
        }
        #endif
    }

    private static func activateRecordingSession() throws {
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true)
        #elseif os(watchOS)
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default)
        try session.setActive(true)
        #endif
    }

    private static func deactivateSession() {
        #if os(iOS) || os(watchOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }
}

public extension ChatAudioPlayback {
    /// Maps -160...0 dB average power onto 0...1, treating anything below -50 dB as silence so
    /// room noise doesn't fill the waveform.
    static func normalizedLevel(power: Float) -> Float {
        guard power.isFinite else { return 0 }
        return min(1, max(0, (power + 50) / 50))
    }

    /// Joins audio files end to end into one M4A file.
    static func concatenate(_ files: [URL], to output: URL) async throws {
        let composition = AVMutableComposition()
        guard let track = composition.addMutableTrack(
            withMediaType: .audio,
            preferredTrackID: kCMPersistentTrackID_Invalid
        ) else { throw CocoaError(.fileWriteUnknown) }
        var cursor = CMTime.zero
        for file in files {
            let asset = AVURLAsset(url: file)
            let duration = try await asset.load(.duration)
            guard let source = try await asset.loadTracks(withMediaType: .audio).first else { continue }
            try track.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: source, at: cursor)
            cursor = CMTimeAdd(cursor, duration)
        }
        guard let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetAppleM4A) else {
            throw CocoaError(.fileWriteUnknown)
        }
        if #available(iOS 18.0, macOS 15.0, watchOS 11.0, *) {
            try await export.export(to: output, as: .m4a)
        } else {
            export.outputURL = output
            export.outputFileType = .m4a
            await export.export()
            if let error = export.error { throw error }
            guard export.status == .completed else { throw CocoaError(.fileWriteUnknown) }
        }
    }
}

#endif

// MARK: - Clip preview

/// Plays a recorded clip back in the composer before it is sent.
@MainActor
@Observable
public final class ChatAudioDraftPlayer: NSObject, AVAudioPlayerDelegate {
    public private(set) var isPlaying = false
    public private(set) var currentTime: TimeInterval = 0
    public private(set) var progress: Double = 0

    private let onWillPlay: @MainActor () -> Void
    private var player: AVAudioPlayer?
    private var fileURL: URL?
    private var ticker: Task<Void, Never>?

    public init(onWillPlay: @escaping @MainActor () -> Void = {}) {
        self.onWillPlay = onWillPlay
    }

    public func toggle(_ url: URL) {
        if isPlaying {
            player?.pause()
            isPlaying = false
            ticker?.cancel()
            return
        }
        do {
            if player == nil || fileURL != url {
                onWillPlay()
                #if os(iOS) || os(watchOS)
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playback, mode: .spokenAudio)
                try session.setActive(true)
                #endif
                let player = try AVAudioPlayer(contentsOf: url)
                player.delegate = self
                self.player = player
                fileURL = url
            }
            player?.play()
            isPlaying = true
            ticker?.cancel()
            ticker = Task { @MainActor [weak self] in
                while !Task.isCancelled {
                    guard let self, let player = self.player else { return }
                    self.currentTime = player.currentTime
                    self.progress = player.duration > 0 ? player.currentTime / player.duration : 0
                    try? await Task.sleep(for: .milliseconds(50))
                }
            }
        } catch {
            stop()
        }
    }

    public func stop() {
        ticker?.cancel()
        ticker = nil
        player?.stop()
        player = nil
        fileURL = nil
        isPlaying = false
        currentTime = 0
        progress = 0
    }

    public nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            self.ticker?.cancel()
            self.isPlaying = false
            self.currentTime = 0
            self.progress = 0
            self.player?.currentTime = 0
        }
    }
}

// MARK: - Composer views

/// Rounded bars for a recording's loudness, Messages style. While recording the newest levels
/// scroll in from the right and the oldest fade out on the left; once stopped the whole clip is
/// fitted to the width and `progress` brightens the part that has played.
public struct ChatAudioWaveform: View {
    private let levels: [Float]
    private let progress: Double?
    private let tint: Color

    public init(levels: [Float], progress: Double?, tint: Color) {
        self.levels = levels
        self.progress = progress
        self.tint = tint
    }

    public var body: some View {
        GeometryReader { geometry in
            let barWidth: CGFloat = 3
            let spacing: CGFloat = 3
            let count = max(1, Int((geometry.size.width + spacing) / (barWidth + spacing)))
            let isLive = progress == nil
            let bars = Self.resample(levels, to: count, alignTrailing: isLive)
            HStack(alignment: .center, spacing: spacing) {
                ForEach(Array(bars.enumerated()), id: \.offset) { index, level in
                    let position = Double(index) / Double(count)
                    let opacity: Double = if let progress {
                        position < progress ? 0.95 : 0.4
                    } else {
                        // The oldest bars fade toward the leading edge as they scroll away.
                        min(1, 0.35 + position * 1.6)
                    }
                    Capsule()
                        .fill(tint.opacity(opacity))
                        .frame(width: barWidth, height: max(barWidth * 2.2, CGFloat(level) * geometry.size.height))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: isLive ? .trailing : .leading)
        }
        .frame(height: 22)
        .frame(maxWidth: .infinity)
        .accessibilityHidden(true)
    }

    /// Fits `levels` to `count` bars: a finished clip is averaged (or stretched) across the
    /// whole width; a live recording keeps its newest samples and pads silence on the left.
    public static func resample(_ levels: [Float], to count: Int, alignTrailing: Bool) -> [Float] {
        guard !levels.isEmpty else { return Array(repeating: 0, count: count) }
        if alignTrailing {
            let tail = Array(levels.suffix(count))
            return Array(repeating: 0, count: count - tail.count) + tail
        }
        return (0..<count).map { bar in
            let start = bar * levels.count / count
            let end = max(start + 1, (bar + 1) * levels.count / count)
            let slice = levels[start..<min(end, levels.count)]
            return slice.reduce(0, +) / Float(slice.count)
        }
    }
}

#if !os(watchOS)
/// What sits inside the composer capsule while an audio message is being made, as in Messages:
/// recording shows the live waveform, the time and a stop button; a stopped clip shows play,
/// its waveform, a "+ 0:01" button that records more, and send. Each app draws the capsule and
/// the cancel button around it.
public struct ChatAudioComposerControls: View {
    private let recorder: ChatAudioRecorder
    private let recording: ChatAudioRecorder.Recording?
    private let player: ChatAudioDraftPlayer
    private let isBusy: Bool
    private let accent: Color
    private let onStop: () -> Void
    private let onContinue: () -> Void
    private let onSend: () -> Void

    public init(
        recorder: ChatAudioRecorder,
        recording: ChatAudioRecorder.Recording?,
        player: ChatAudioDraftPlayer,
        isBusy: Bool,
        accent: Color,
        onStop: @escaping () -> Void,
        onContinue: @escaping () -> Void,
        onSend: @escaping () -> Void
    ) {
        self.recorder = recorder
        self.recording = recording
        self.player = player
        self.isBusy = isBusy
        self.accent = accent
        self.onStop = onStop
        self.onContinue = onContinue
        self.onSend = onSend
    }

    private let recordingRed = Color(red: 1, green: 0.38, blue: 0.36)

    public var body: some View {
        HStack(spacing: 10) {
            if recorder.isRecording || recording == nil {
                ChatAudioWaveform(levels: recorder.levels, progress: nil, tint: recordingRed)
                    .padding(.leading, 12)
                Text(ChatAudioPlayback.timeLabel(recorder.elapsed))
                    .font(.body.monospacedDigit().weight(.medium))
                    .foregroundStyle(recordingRed)
                Button(action: onStop) {
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(recordingRed)
                        .frame(width: 14, height: 14)
                        .frame(width: 40, height: 40)
                        .background(recordingRed.opacity(0.22), in: Circle())
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Stop recording")
            } else if let recording {
                Button { player.toggle(recording.fileURL) } label: {
                    Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.primary)
                        .frame(width: 40, height: 40)
                        .background(Color.primary.opacity(0.12), in: Circle())
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(player.isPlaying ? "Pause recording" : "Play recording")

                ChatAudioWaveform(levels: recording.levels, progress: player.progress, tint: .secondary)

                Button(action: onContinue) {
                    Text("+ \(ChatAudioPlayback.timeLabel(player.isPlaying ? player.currentTime : recording.duration))")
                        .font(.body.monospacedDigit().weight(.medium))
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 12)
                        .frame(height: 34)
                        .background(Color.primary.opacity(0.1), in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(isBusy)
                .accessibilityLabel("Record more")

                Button(action: onSend) {
                    ZStack {
                        if isBusy { ProgressView().tint(.white) }
                        else {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 17, weight: .bold))
                                .foregroundStyle(.white)
                        }
                    }
                    .frame(width: 52, height: 36)
                    .background(accent, in: Capsule())
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .disabled(isBusy)
                .accessibilityLabel("Send audio message")
            }
        }
        .padding(.vertical, 3)
        .padding(.trailing, 3)
        .padding(.leading, recording != nil && !recorder.isRecording ? 3 : 0)
    }
}
#endif
