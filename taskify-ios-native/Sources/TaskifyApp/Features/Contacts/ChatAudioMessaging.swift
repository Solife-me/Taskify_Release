import AVFoundation
import Foundation
import MediaPlayer
import SwiftUI
import TaskifyCore
import TaskifyWatchShared

@MainActor
@Observable
final class DirectMessageAudioPlayback: NSObject {
    static let shared = DirectMessageAudioPlayback()

    private(set) var attachmentKey: String?
    private(set) var isLoading = false
    private(set) var isPlaying = false
    private(set) var currentTime: TimeInterval = 0
    private(set) var duration: TimeInterval = 0
    private(set) var errorMessage: String?
    private(set) var downloadMessage: String?

    private var player: AVPlayer?
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var loadTask: Task<Void, Never>?
    private var title = "Audio Message"
    private var wasPlayingBeforeInterruption = false
    /// Counts seeks so the periodic observer stops reporting the pre-seek position, which
    /// would otherwise snap the scrubber back for a moment after it is released.
    private var seekGeneration = 0
    private var isSeeking = false

    override private init() {
        super.init()
        configureRemoteCommands()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAudioSessionInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance()
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAudioRouteChange(_:)),
            name: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance()
        )
    }

    func isCurrent(_ attachment: NostrDirectMessageAttachment) -> Bool {
        attachmentKey == attachment.cacheKey
    }

    func toggle(_ attachment: NostrDirectMessageAttachment) {
        if isCurrent(attachment) {
            guard !isLoading else { return }
            guard player != nil else {
                loadAndPlay(attachment)
                return
            }
            isPlaying ? pause() : resume()
            return
        }
        loadAndPlay(attachment)
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

    func pauseForRecording() {
        if isLoading {
            loadTask?.cancel()
            loadTask = nil
            isLoading = false
            isPlaying = false
            attachmentKey = nil
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            return
        }
        pause()
    }

    private func loadAndPlay(_ attachment: NostrDirectMessageAttachment) {
        loadTask?.cancel()
        removePlayerObservers()
        player?.pause()
        player = nil
        attachmentKey = attachment.cacheKey
        title = ChatAudioPlayback.title(forFilename: attachment.displayName)
        currentTime = 0
        duration = 0
        isPlaying = false
        isLoading = true
        errorMessage = nil
        downloadMessage = nil
        updateNowPlayingInfo()

        let expectedKey = attachment.cacheKey
        loadTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let file = try await DirectMessageAttachmentDataLoader.shared.file(
                    for: attachment,
                    progress: { [weak self] update in
                        Task { @MainActor in self?.downloadMessage = update.message }
                    }
                )
                try Task.checkCancellation()
                self.downloadMessage = nil
                guard self.attachmentKey == expectedKey else { return }
                try self.activatePlaybackSession()

                let asset = ChatAudioPlayback.asset(file: file, mimeType: attachment.mimeType)
                let assetDuration = try? await asset.load(.duration)
                try Task.checkCancellation()
                guard self.attachmentKey == expectedKey else { return }

                let item = AVPlayerItem(asset: asset)
                let player = AVPlayer(playerItem: item)
                self.player = player
                if let assetDuration {
                    self.duration = Self.seconds(assetDuration)
                }
                self.installPlayerObservers(player: player, item: item)
                self.isLoading = false
                player.play()
                self.isPlaying = true
                self.updateNowPlayingInfo()
            } catch is CancellationError {
                // A newer audio message replaced this load.
            } catch {
                guard self.attachmentKey == expectedKey else { return }
                self.isLoading = false
                self.downloadMessage = nil
                self.isPlaying = false
                self.errorMessage = error.localizedDescription
                self.updateNowPlayingInfo()
            }
        }
    }

    private func resume() {
        guard let player else { return }
        do {
            try activatePlaybackSession()
            if duration > 0, currentTime >= duration - 0.25 {
                seek(to: 0)
            }
            player.play()
            isPlaying = true
            errorMessage = nil
            updateNowPlayingInfo()
        } catch {
            errorMessage = error.localizedDescription
            isPlaying = false
        }
    }

    private func pause() {
        player?.pause()
        isPlaying = false
        updateNowPlayingInfo()
    }

    private func seek(to requestedTime: TimeInterval) {
        guard let player else { return }
        let upperBound = duration > 0 ? duration : max(0, requestedTime)
        let target = min(max(0, requestedTime), upperBound)
        seekGeneration += 1
        let generation = seekGeneration
        isSeeking = true
        player.seek(
            to: CMTime(seconds: target, preferredTimescale: 600),
            toleranceBefore: .zero,
            toleranceAfter: .zero
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.seekGeneration == generation else { return }
                self.isSeeking = false
            }
        }
        currentTime = target
        updateNowPlayingInfo()
    }

    private func activatePlaybackSession() throws {
        let session = AVAudioSession.sharedInstance()
        // AirPlay comes with .playback; .allowAirPlay is only valid with .playAndRecord and
        // makes setCategory throw (-50), which failed every play tap before audio loaded.
        try session.setCategory(.playback, mode: .spokenAudio)
        try session.setActive(true)
    }

    private func installPlayerObservers(player: AVPlayer, item: AVPlayerItem) {
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.25, preferredTimescale: 600),
            queue: .main
        ) { [weak self, weak player] time in
            Task { @MainActor in
                guard let self, let player, self.player === player, !self.isSeeking else { return }
                self.currentTime = Self.seconds(time)
                let itemDuration = Self.seconds(player.currentItem?.duration ?? .invalid)
                if itemDuration > 0 { self.duration = itemDuration }
                self.isPlaying = player.timeControlStatus == .playing
                self.updateNowPlayingInfo()
            }
        }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self, weak item] notification in
            Task { @MainActor in
                guard let self,
                      notification.object as? AVPlayerItem === item,
                      self.player?.currentItem === item else { return }
                self.currentTime = self.duration
                self.isPlaying = false
                self.updateNowPlayingInfo()
            }
        }
    }

    private func removePlayerObservers() {
        if let timeObserver, let player {
            player.removeTimeObserver(timeObserver)
        }
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
        commands.skipForwardCommand.preferredIntervals = [10]
        commands.skipBackwardCommand.isEnabled = true
        commands.skipBackwardCommand.preferredIntervals = [10]
        commands.changePlaybackPositionCommand.isEnabled = true

        commands.playCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.resume() }
            return .success
        }
        commands.pauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.pause() }
            return .success
        }
        commands.togglePlayPauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.isPlaying ? self.pause() : self.resume()
            }
            return .success
        }
        commands.skipForwardCommand.addTarget { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.seek(to: self.currentTime + 10)
            }
            return .success
        }
        commands.skipBackwardCommand.addTarget { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.seek(to: self.currentTime - 10)
            }
            return .success
        }
        commands.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            Task { @MainActor in self?.seek(to: event.positionTime) }
            return .success
        }
    }

    private func updateNowPlayingInfo() {
        guard attachmentKey != nil else {
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

    @objc private func handleAudioSessionInterruption(_ notification: Notification) {
        guard let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: rawType) else { return }
        switch type {
        case .began:
            wasPlayingBeforeInterruption = isPlaying
            pause()
        case .ended:
            guard wasPlayingBeforeInterruption,
                  let rawOptions = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt,
                  AVAudioSession.InterruptionOptions(rawValue: rawOptions).contains(.shouldResume) else { return }
            wasPlayingBeforeInterruption = false
            resume()
        @unknown default:
            break
        }
    }

    @objc private func handleAudioRouteChange(_ notification: Notification) {
        guard let rawReason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
              AVAudioSession.RouteChangeReason(rawValue: rawReason) == .oldDeviceUnavailable else { return }
        pause()
    }

    private static func seconds(_ time: CMTime) -> TimeInterval {
        let value = CMTimeGetSeconds(time)
        return value.isFinite && value >= 0 ? value : 0
    }
}

struct DirectMessageAudioAttachmentView: View {
    let attachment: NostrDirectMessageAttachment
    @State private var playback = DirectMessageAudioPlayback.shared
    /// Where the listener's finger is while dragging the scrubber, so the bar and the elapsed
    /// label follow the drag and the player seeks once on release.
    @State private var scrubFraction: Double?

    private var isCurrent: Bool { playback.isCurrent(attachment) }
    private var isLoading: Bool { isCurrent && playback.isLoading }
    private var isPlaying: Bool { isCurrent && playback.isPlaying }
    private var isLoaded: Bool { isCurrent && !playback.isLoading && playback.duration > 0 }
    private var duration: TimeInterval { isCurrent ? playback.duration : 0 }

    private var progress: Double {
        if let scrubFraction { return scrubFraction }
        guard duration > 0 else { return 0 }
        return playback.currentTime / duration
    }

    var body: some View {
        VStack(spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "waveform")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TaskifyTheme.accent)
                    .accessibilityHidden(true)
                Text(ChatAudioPlayback.title(forFilename: attachment.displayName))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
            }

            HStack(spacing: 26) {
                audioControlButton(systemName: "gobackward.10", accessibilityLabel: "Back 10 seconds") {
                    playback.seek(by: -10, attachment: attachment)
                }

                Button { playback.toggle(attachment) } label: {
                    ZStack {
                        if isLoading {
                            ProgressView().controlSize(.small).tint(TaskifyTheme.primaryText)
                        } else {
                            Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                                .font(.system(size: 16, weight: .semibold))
                                .contentTransition(.symbolEffect(.replace))
                        }
                    }
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .frame(width: 36, height: 36)
                    .background(TaskifyTheme.accent.opacity(0.7), in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(isLoading)
                .accessibilityLabel(isLoading ? "Loading audio" : (isPlaying ? "Pause audio" : "Play audio"))

                audioControlButton(systemName: "goforward.10", accessibilityLabel: "Forward 10 seconds") {
                    playback.seek(by: 10, attachment: attachment)
                }
            }
            .frame(maxWidth: .infinity)

            HStack(spacing: 8) {
                Text(ChatAudioPlayback.timeLabel(progress * duration))
                    .frame(minWidth: 30, alignment: .leading)
                ChatAudioScrubber(
                    progress: progress,
                    duration: duration,
                    tint: TaskifyTheme.accent,
                    track: Color.white.opacity(0.14),
                    isEnabled: isLoaded,
                    onScrub: { scrubFraction = $0 },
                    onCommit: { playback.seek(toFraction: $0, attachment: attachment) }
                )
                Text(duration > 0 ? ChatAudioPlayback.timeLabel(duration) : "--:--")
                    .frame(minWidth: 30, alignment: .trailing)
            }
            .font(.caption2.monospacedDigit())
            .foregroundStyle(TaskifyTheme.secondaryText)

            if isCurrent, let downloadMessage = playback.downloadMessage, isLoading {
                Text(downloadMessage)
                    .font(.caption2)
                    .foregroundStyle(TaskifyTheme.secondaryText)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if isCurrent, let errorMessage = playback.errorMessage {
                Text(errorMessage)
                    .font(.caption2)
                    .foregroundStyle(.red)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 5)
        .frame(width: 250)
        .background(
            DirectMessageAttachmentStyle.cardFill,
            in: RoundedRectangle(cornerRadius: DirectMessageAttachmentStyle.cornerRadius, style: .continuous)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Audio message, \(ChatAudioPlayback.title(forFilename: attachment.displayName))")
    }

    private func audioControlButton(
        systemName: String,
        accessibilityLabel: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(TaskifyTheme.primaryText)
                .frame(width: 32, height: 32)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!isLoaded)
        .opacity(isLoaded ? 1 : 0.4)
        .accessibilityLabel(accessibilityLabel)
    }
}
