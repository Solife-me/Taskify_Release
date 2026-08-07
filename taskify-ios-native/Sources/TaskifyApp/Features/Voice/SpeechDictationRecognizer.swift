import AVFoundation
import Foundation
import Speech

/// Live speech-to-text for the voice dictation sheet, standing in for the PWA's Web Speech API
/// (`useVoiceSession.ts`'s `createSpeechRecognition`). Same shape of output -- a stream of final
/// segments plus a continuously-revised interim tail -- so the session logic in `VoiceSessionState`
/// is driven identically on both platforms.
///
/// Prefers on-device recognition where the device supports it, so the audio itself never leaves the
/// phone. Only the resulting text is sent anywhere, and only once the user stops speaking.
@Observable
@MainActor
final class SpeechDictationRecognizer {
    enum Availability: Equatable {
        case unknown
        case ready
        case denied(String)
        case unsupported(String)
    }

    private(set) var availability: Availability = .unknown
    private(set) var isListening = false
    /// Text the recognizer has settled on, emitted segment by segment.
    var onCommit: ((String) -> Void)?
    /// The current best guess for speech still in progress; replaced wholesale as it firms up.
    var onInterim: ((String) -> Void)?
    var onError: ((String) -> Void)?

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    /// How much of the current recognition result has already been handed to `onCommit`. A single
    /// `SFSpeechRecognitionTask` reports the whole utterance each time rather than just the delta,
    /// so without this the transcript accumulates duplicated text.
    private var committedCharacterCount = 0

    var isAvailable: Bool { availability == .ready }

    /// Asks for microphone and speech-recognition access. Both are required: speech recognition
    /// authorization alone still can't capture audio.
    func requestAuthorization() async {
        guard recognizer != nil else {
            availability = .unsupported("Speech recognition isn't available for English on this device.")
            return
        }

        let speechStatus = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard speechStatus == .authorized else {
            availability = .denied("Taskify needs Speech Recognition access to turn what you say into tasks. You can enable it in Settings.")
            return
        }

        let micGranted = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard micGranted else {
            availability = .denied("Taskify needs Microphone access to hear you. You can enable it in Settings.")
            return
        }

        availability = .ready
    }

    func start() {
        guard !isListening, let recognizer, recognizer.isAvailable else {
            if recognizer?.isAvailable == false {
                onError?("Speech recognition is temporarily unavailable. Try again in a moment.")
            }
            return
        }

        do {
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            if recognizer.supportsOnDeviceRecognition {
                request.requiresOnDeviceRecognition = true
            }
            self.request = request
            committedCharacterCount = 0

            let inputNode = audioEngine.inputNode
            let format = inputNode.outputFormat(forBus: 0)
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak request] buffer, _ in
                request?.append(buffer)
            }

            audioEngine.prepare()
            try audioEngine.start()
            isListening = true

            task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                Task { @MainActor in
                    guard let self else { return }
                    if let result {
                        self.handle(result)
                    }
                    if error != nil || result?.isFinal == true {
                        self.finishAudio()
                    }
                }
            }
        } catch {
            finishAudio()
            onError?("Couldn't start recording. Make sure nothing else is using the microphone.")
        }
    }

    func stop() {
        guard isListening else { return }
        // Flushing the pending audio lets the recognizer finalize its tail before teardown, so the
        // last few words aren't lost when the user taps stop mid-sentence.
        request?.endAudio()
        finishAudio()
    }

    private func handle(_ result: SFSpeechRecognitionResult) {
        let full = result.bestTranscription.formattedString
        guard full.count >= committedCharacterCount else {
            // The recognizer revised its transcript shorter than what we already committed; restart
            // the accounting against the new text rather than slicing out of range.
            committedCharacterCount = 0
            onInterim?(full)
            return
        }

        let pending = String(full.dropFirst(committedCharacterCount))
        if result.isFinal {
            let trimmed = pending.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { onCommit?(trimmed) }
            committedCharacterCount = full.count
            onInterim?("")
        } else {
            onInterim?(pending.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }

    private func finishAudio() {
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        task?.cancel()
        task = nil
        request = nil
        isListening = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
