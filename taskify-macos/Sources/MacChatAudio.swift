import AVFoundation
import AppKit
import MediaPlayer
import SwiftUI
import TaskifyCore
import TaskifyWatchShared

@MainActor
final class MacChatAudioPlayback: ObservableObject {
    static let shared = MacChatAudioPlayback()

    @Published private(set) var attachmentURL: String?
    @Published private(set) var isLoading = false
    @Published private(set) var isPlaying = false
    @Published private(set) var currentTime: TimeInterval = 0
    @Published private(set) var duration: TimeInterval = 0
    @Published private(set) var error: String?

    private var player: AVPlayer?
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var loadTask: Task<Void, Never>?
    private var title = "Audio Message"
    /// Counts seeks so the periodic observer stops reporting the pre-seek position, which
    /// would otherwise snap the scrubber back for a moment after it is released.
    private var seekGeneration = 0
    private var isSeeking = false

    private init() { configureRemoteCommands() }

    func isCurrent(_ attachment: NostrDirectMessageAttachment) -> Bool {
        attachmentURL == attachment.url
    }

    func toggle(_ attachment: NostrDirectMessageAttachment) {
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
    func seek(by offset: TimeInterval, attachment: NostrDirectMessageAttachment) {
        guard isCurrent(attachment), player != nil, !isLoading else { return }
        seek(to: currentTime + offset)
    }

    func seek(toFraction fraction: Double, attachment: NostrDirectMessageAttachment) {
        guard isCurrent(attachment), player != nil, !isLoading, duration > 0 else { return }
        seek(to: min(max(fraction, 0), 1) * duration)
    }

    func pauseForRecording() { pause() }

    private func loadAndPlay(_ attachment: NostrDirectMessageAttachment) {
        loadTask?.cancel()
        removeObservers()
        player?.pause()
        player = nil
        attachmentURL = attachment.url
        title = ChatAudioPlayback.title(forFilename: attachment.displayName)
        currentTime = 0
        duration = 0
        isPlaying = false
        isLoading = true
        error = nil
        updateNowPlaying()

        let expectedURL = attachment.url
        loadTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                // The shared decrypted-attachment cache owns the file; a replay or another
                // window reuses it instead of downloading and decrypting again.
                let file = try await DirectMessageAttachmentDataLoader.shared.file(for: attachment)
                try Task.checkCancellation()
                guard self.attachmentURL == expectedURL else { return }
                // Decryption writes a `.bin` file; the MIME hint is what lets AVFoundation open it.
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
                // Replaced by another audio message.
            } catch {
                guard self.attachmentURL == expectedURL else { return }
                self.isLoading = false
                self.isPlaying = false
                self.error = error.localizedDescription
                self.updateNowPlaying()
            }
        }
    }

    private func play() {
        guard let player else { return }
        if duration > 0, currentTime >= duration - 0.25 { seek(to: 0) }
        player.play()
        isPlaying = true
        error = nil
        updateNowPlaying()
    }

    private func pause() {
        player?.pause()
        isPlaying = false
        updateNowPlaying()
    }

    private func seek(to requested: TimeInterval) {
        guard let player else { return }
        let upper = duration > 0 ? duration : max(0, requested)
        let target = min(max(0, requested), upper)
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
        updateNowPlaying()
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
                self.updateNowPlaying()
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
                self.updateNowPlaying()
            }
        }
    }

    private func removeObservers() {
        if let timeObserver, let player { player.removeTimeObserver(timeObserver) }
        timeObserver = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
    }

    private func configureRemoteCommands() {
        let commands = MPRemoteCommandCenter.shared()
        commands.playCommand.isEnabled = true
        commands.pauseCommand.isEnabled = true
        commands.togglePlayPauseCommand.isEnabled = true
        commands.skipForwardCommand.isEnabled = true
        commands.skipBackwardCommand.isEnabled = true
        commands.changePlaybackPositionCommand.isEnabled = true
        commands.playCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.play() }
            return .success
        }
        commands.pauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.pause() }
            return .success
        }
        commands.togglePlayPauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.isPlaying ? self.pause() : self.play()
            }
            return .success
        }
        commands.skipForwardCommand.preferredIntervals = [10]
        commands.skipForwardCommand.addTarget { [weak self] _ in
            Task { @MainActor in guard let self else { return }; self.seek(to: self.currentTime + 10) }
            return .success
        }
        commands.skipBackwardCommand.preferredIntervals = [10]
        commands.skipBackwardCommand.addTarget { [weak self] _ in
            Task { @MainActor in guard let self else { return }; self.seek(to: self.currentTime - 10) }
            return .success
        }
        commands.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            Task { @MainActor in self?.seek(to: event.positionTime) }
            return .success
        }
    }

    private func updateNowPlaying() {
        guard attachmentURL != nil else {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            return
        }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: "Taskify",
            MPNowPlayingInfoPropertyElapsedPlaybackTime: currentTime,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
        ]
        if duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = duration }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private static func seconds(_ time: CMTime) -> TimeInterval {
        let value = CMTimeGetSeconds(time)
        return value.isFinite && value >= 0 ? value : 0
    }
}

struct MacChatAudioAttachment: View {
    let attachment: NostrDirectMessageAttachment
    @ObservedObject private var playback = MacChatAudioPlayback.shared
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
        VStack(spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "waveform").foregroundStyle(Color.accentColor).accessibilityHidden(true)
                Text(ChatAudioPlayback.title(forFilename: attachment.displayName))
                    .lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 0)
            }
            .font(.caption.weight(.semibold))

            HStack(spacing: 20) {
                skip("gobackward.10", label: "Back 10 seconds", by: -10)
                Button { playback.toggle(attachment) } label: {
                    ZStack {
                        if isLoading {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(.white)
                        }
                    }
                    .frame(width: 30, height: 30)
                    .background(Color.accentColor, in: Circle())
                    .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(isLoading)
                .help(isPlaying ? "Pause" : "Play")
                .accessibilityLabel(isLoading ? "Loading audio" : (isPlaying ? "Pause audio" : "Play audio"))
                skip("goforward.10", label: "Forward 10 seconds", by: 10)
            }
            .frame(maxWidth: .infinity)

            HStack(spacing: 8) {
                Text(ChatAudioPlayback.timeLabel(progress * duration)).frame(minWidth: 28, alignment: .leading)
                ChatAudioScrubber(
                    progress: progress,
                    duration: duration,
                    tint: .accentColor,
                    track: Color.secondary.opacity(0.25),
                    isEnabled: isLoaded,
                    onScrub: { scrubFraction = $0 },
                    onCommit: { playback.seek(toFraction: $0, attachment: attachment) }
                )
                Text(duration > 0 ? ChatAudioPlayback.timeLabel(duration) : "--:--")
                    .frame(minWidth: 28, alignment: .trailing)
            }
            .font(.caption2.monospacedDigit())
            .foregroundStyle(.secondary)

            if current, let error = playback.error {
                Text(error).font(.caption2).foregroundStyle(.red).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 11).padding(.top, 9).padding(.bottom, 4)
        .frame(width: 250)
        .background(MacChatAttachmentStyle.cardFill, in: RoundedRectangle(cornerRadius: MacChatAttachmentStyle.cornerRadius, style: .continuous))
    }

    private func skip(_ image: String, label: String, by offset: TimeInterval) -> some View {
        Button { playback.seek(by: offset, attachment: attachment) } label: {
            Image(systemName: image).font(.system(size: 14, weight: .medium)).frame(width: 26, height: 26)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isLoaded)
        .opacity(isLoaded ? 1 : 0.4)
        .help(label)
        .accessibilityLabel(label)
    }
}
