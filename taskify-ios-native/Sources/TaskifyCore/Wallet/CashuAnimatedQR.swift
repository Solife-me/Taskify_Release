import Foundation
import URKit

public struct CashuAnimatedQRAnimation: Equatable, Sendable {
    public let frames: [String]
    public let payloadByteCount: Int

    public init?(token: String, maxFragmentLength: Int = 200) {
        let canonical = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canonical.lowercased().hasPrefix("cashu"),
              let payload = canonical.data(using: .utf8),
              !payload.isEmpty else {
            return nil
        }

        do {
            // NUT-16 transports the serialized token as a CBOR byte string in
            // a `ur:bytes` fountain sequence.
            let ur = try UR(type: "bytes", untaggedCBOR: payload)
            let encoder = UREncoder(
                ur,
                maxFragmentLen: max(30, maxFragmentLength),
                firstSeqNum: 0
            )
            guard !encoder.isSinglePart, encoder.seqLen > 1 else { return nil }

            var generated: [String] = []
            generated.reserveCapacity(encoder.seqLen)
            for _ in 0..<encoder.seqLen {
                generated.append(encoder.nextPart())
            }
            guard generated.count > 1 else { return nil }
            frames = generated
            payloadByteCount = payload.count
        } catch {
            return nil
        }
    }
}

public enum CashuAnimatedQRCollectionResult: Equatable, Sendable {
    case notAnimated
    case progress(received: Int, expected: Int?, duplicate: Bool)
    case complete(token: String)
    case invalid(message: String)
}

/// Stateful NUT-16 decoder for camera scanners. A collector is intentionally
/// scoped to one scan session so fragments from different bearer tokens cannot
/// be combined accidentally.
public final class CashuAnimatedQRCollector {
    private var urDecoder = URDecoder()
    private var seenURParts: Set<String> = []
    private var legacySet: LegacySet?

    public init() {}

    public func reset() {
        urDecoder = URDecoder()
        seenURParts.removeAll(keepingCapacity: true)
        legacySet = nil
    }

    public func add(_ rawValue: String) -> CashuAnimatedQRCollectionResult {
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.lowercased().hasPrefix("ur:") {
            return addUR(value)
        }
        if value.hasPrefix("cashuA:") {
            return addLegacy(value)
        }
        return .notAnimated
    }

    private func addUR(_ value: String) -> CashuAnimatedQRCollectionResult {
        let canonical = value.lowercased()
        let duplicate = seenURParts.contains(canonical)
        let accepted = urDecoder.receivePart(canonical)
        guard accepted || duplicate else {
            return .invalid(message: "That animated Cashu QR frame is invalid.")
        }
        seenURParts.insert(canonical)

        if let result = urDecoder.result {
            defer { reset() }
            do {
                let ur = try result.get()
                guard ur.type == "bytes" else {
                    return .invalid(message: "That animated QR code does not contain a Cashu token.")
                }
                let payload = try Data(cbor: ur.cbor)
                guard let token = String(data: payload, encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines),
                      token.lowercased().hasPrefix("cashu") else {
                    return .invalid(message: "The animated QR payload is not a Cashu token.")
                }
                return .complete(token: token)
            } catch {
                return .invalid(message: "The animated Cashu token could not be assembled.")
            }
        }

        let expected = urDecoder.expectedFragmentCount.flatMap { $0 > 0 ? $0 : nil }
        return .progress(
            received: seenURParts.count,
            expected: expected,
            duplicate: duplicate
        )
    }

    private func addLegacy(_ value: String) -> CashuAnimatedQRCollectionResult {
        guard let frame = LegacyFrame(value) else {
            return .invalid(message: "That animated Cashu QR frame is invalid.")
        }

        if legacySet == nil
            || legacySet?.version != frame.version
            || legacySet?.digest != frame.digest
            || legacySet?.total != frame.total {
            legacySet = LegacySet(
                version: frame.version,
                digest: frame.digest,
                total: frame.total,
                chunks: [:]
            )
        }

        let duplicate = legacySet?.chunks[frame.index] != nil
        legacySet?.chunks[frame.index] = frame.chunk
        guard let current = legacySet else {
            return .invalid(message: "That animated Cashu QR frame is invalid.")
        }
        guard current.chunks.count == current.total else {
            return .progress(
                received: current.chunks.count,
                expected: current.total,
                duplicate: duplicate
            )
        }

        defer { legacySet = nil }
        let encoded = (1...current.total).compactMap { current.chunks[$0] }.joined()
        guard let payload = Data(base64URLEncoded: encoded),
              let token = String(data: payload, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
              token.lowercased().hasPrefix("cashu") else {
            return .invalid(message: "The animated Cashu token could not be assembled.")
        }
        return .complete(token: token)
    }

    private struct LegacyFrame {
        let version: Int
        let index: Int
        let total: Int
        let digest: String
        let chunk: String

        init?(_ value: String) {
            let parts = value.split(separator: ":", omittingEmptySubsequences: false)
            guard parts.count == 6,
                  parts[0] == "cashuA",
                  let version = Int(parts[1]), version > 0,
                  let index = Int(parts[2]), index > 0,
                  let total = Int(parts[3]), total > 0,
                  index <= total,
                  parts[4].count >= 6,
                  !parts[5].isEmpty else {
                return nil
            }
            self.version = version
            self.index = index
            self.total = total
            digest = String(parts[4])
            chunk = String(parts[5])
        }
    }

    private struct LegacySet {
        let version: Int
        let digest: String
        let total: Int
        var chunks: [Int: String]
    }
}

private extension Data {
    init?(base64URLEncoded value: String) {
        var normalized = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padding = (4 - normalized.count % 4) % 4
        normalized.append(String(repeating: "=", count: padding))
        self.init(base64Encoded: normalized)
    }
}
