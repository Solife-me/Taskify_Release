import AVFoundation
import Foundation
import XCTest
import TaskifyWatchShared

final class ChatAudioPlaybackTests: XCTestCase {
    /// Decrypted attachments live in hash-named cache files with no extension; without the MIME
    /// hint AVFoundation fails them with "Cannot Open" and no audio message plays.
    func testDecryptedAudioWithoutExtensionOpensWithMIMEHint() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ChatAudioPlaybackTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let recorded = directory.appendingPathComponent("recorded.m4a")
        try writeTone(to: recorded, seconds: 1)
        let cached = directory.appendingPathComponent("3f9a1c0e")
        try FileManager.default.moveItem(at: recorded, to: cached)

        let unhinted = AVURLAsset(url: cached)
        do {
            _ = try await unhinted.load(.duration)
            XCTFail("AVFoundation opened an extensionless file; the MIME hint may no longer be needed")
        } catch {}

        for mimeType in ["audio/mp4", "audio/x-m4a", "audio/m4a", "AUDIO/MP4"] {
            let duration = try await ChatAudioPlayback.asset(file: cached, mimeType: mimeType).load(.duration)
            XCTAssertEqual(CMTimeGetSeconds(duration), 1, accuracy: 0.1, mimeType)
        }
    }

    func testTimeLabelAndTitle() {
        XCTAssertEqual(ChatAudioPlayback.timeLabel(0), "0:00")
        XCTAssertEqual(ChatAudioPlayback.timeLabel(59.9), "0:59")
        XCTAssertEqual(ChatAudioPlayback.timeLabel(754), "12:34")
        XCTAssertEqual(ChatAudioPlayback.timeLabel(-.infinity), "0:00")
        XCTAssertEqual(ChatAudioPlayback.title(forFilename: "Audio Message 2026-10-28.m4a"), "Audio Message 2026-10-28")
        XCTAssertEqual(ChatAudioPlayback.title(forFilename: "Audio"), "Audio")
    }

    private func writeTone(to url: URL, seconds: Double) throws {
        let sampleRate = 44_100.0
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1))
        let file = try AVAudioFile(forWriting: url, settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: 1,
        ])
        let frames = AVAudioFrameCount(sampleRate * seconds)
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames))
        buffer.frameLength = frames
        let samples = try XCTUnwrap(buffer.floatChannelData?[0])
        for frame in 0..<Int(frames) {
            samples[frame] = Float(sin(2 * Double.pi * 440 * Double(frame) / sampleRate) * 0.2)
        }
        try file.write(from: buffer)
    }
}
