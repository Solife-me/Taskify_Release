import Foundation

public enum Bech32Error: LocalizedError {
    case invalidEncoding
    case invalidPrefix
    case invalidChecksum
    case invalidData

    public var errorDescription: String? {
        switch self {
        case .invalidEncoding: "The Bech32 value is malformed."
        case .invalidPrefix: "The Bech32 value has the wrong prefix."
        case .invalidChecksum: "The Bech32 checksum is invalid."
        case .invalidData: "The Bech32 payload is invalid."
        }
    }
}

public enum Bech32 {
    private static let alphabet = Array("qpzry9x8gf2tvdw0s3jn54khce6mua7l")
    private static let generators: [UInt32] = [
        0x3b6a57b2,
        0x26508e6d,
        0x1ea119fa,
        0x3d4233dd,
        0x2a1462b3,
    ]

    public static func encode(prefix: String, data: Data) throws -> String {
        let lowerPrefix = prefix.lowercased()
        guard !lowerPrefix.isEmpty,
              lowerPrefix.unicodeScalars.allSatisfy({ 33...126 ~= $0.value }) else {
            throw Bech32Error.invalidPrefix
        }

        let words = try convertBits(Array(data), from: 8, to: 5, pad: true)
        let checksum = createChecksum(prefix: lowerPrefix, words: words)
        return lowerPrefix + "1" + (words + checksum).map { String(alphabet[Int($0)]) }.joined()
    }

    public static func decode(_ value: String, expectedPrefix: String) throws -> Data {
        guard value == value.lowercased() || value == value.uppercased() else {
            throw Bech32Error.invalidEncoding
        }
        let lower = value.lowercased()
        guard let separator = lower.lastIndex(of: "1"),
              separator != lower.startIndex else {
            throw Bech32Error.invalidEncoding
        }
        let prefix = String(lower[..<separator])
        guard prefix == expectedPrefix.lowercased() else { throw Bech32Error.invalidPrefix }
        let payload = lower[lower.index(after: separator)...]
        guard payload.count >= 6 else { throw Bech32Error.invalidEncoding }

        let words = try payload.map { character -> UInt8 in
            guard let index = alphabet.firstIndex(of: character) else {
                throw Bech32Error.invalidEncoding
            }
            return UInt8(index)
        }
        guard polymod(expand(prefix) + words) == 1 else { throw Bech32Error.invalidChecksum }
        return Data(try convertBits(Array(words.dropLast(6)), from: 5, to: 8, pad: false))
    }

    private static func expand(_ prefix: String) -> [UInt8] {
        prefix.utf8.map { $0 >> 5 } + [0] + prefix.utf8.map { $0 & 31 }
    }

    private static func polymod(_ values: [UInt8]) -> UInt32 {
        var checksum: UInt32 = 1
        for value in values {
            let top = checksum >> 25
            checksum = (checksum & 0x1ffffff) << 5 ^ UInt32(value)
            for index in 0..<5 where ((top >> index) & 1) != 0 {
                checksum ^= generators[index]
            }
        }
        return checksum
    }

    private static func createChecksum(prefix: String, words: [UInt8]) -> [UInt8] {
        let value = polymod(expand(prefix) + words + Array(repeating: 0, count: 6)) ^ 1
        return (0..<6).map { UInt8((value >> (5 * (5 - $0))) & 31) }
    }

    private static func convertBits(
        _ input: [UInt8],
        from: Int,
        to: Int,
        pad: Bool
    ) throws -> [UInt8] {
        var accumulator = 0
        var bits = 0
        var output: [UInt8] = []
        let maxValue = (1 << to) - 1
        let maxAccumulator = (1 << (from + to - 1)) - 1

        for value in input {
            guard Int(value) >> from == 0 else { throw Bech32Error.invalidData }
            accumulator = ((accumulator << from) | Int(value)) & maxAccumulator
            bits += from
            while bits >= to {
                bits -= to
                output.append(UInt8((accumulator >> bits) & maxValue))
            }
        }

        if pad {
            if bits > 0 { output.append(UInt8((accumulator << (to - bits)) & maxValue)) }
        } else if bits >= from || ((accumulator << (to - bits)) & maxValue) != 0 {
            throw Bech32Error.invalidData
        }
        return output
    }
}
