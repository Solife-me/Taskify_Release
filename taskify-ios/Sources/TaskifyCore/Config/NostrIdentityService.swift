import Foundation

public struct NostrIdentity {
    public let nsecHex: String
    public let npub: String
}

public enum NostrIdentityService {
    public enum IdentityError: Error {
        case invalidSecretKey
        case invalidNsec
        case invalidPrivateKey
    }

    public static func normalizeSecretKeyInput(_ raw: String) throws -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw IdentityError.invalidSecretKey }

        var candidate = trimmed
        if trimmed.lowercased().hasPrefix("nsec") {
            let (hrp, data5) = try Bech32.decode(trimmed.lowercased())
            guard hrp == "nsec" else { throw IdentityError.invalidNsec }
            let bytes = try Bech32.convertBits(data5, from: 5, to: 8, pad: false)
            guard bytes.count == 32 else { throw IdentityError.invalidNsec }
            candidate = Data(bytes).map { String(format: "%02x", $0) }.joined()
        }

        let lower = candidate.lowercased()
        guard lower.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
            throw IdentityError.invalidSecretKey
        }
        return lower
    }

    public static func deriveNpub(fromSecretKeyHex secretKeyHex: String) throws -> String {
        guard let sk = Data(hex: secretKeyHex), sk.count == 32 else { throw IdentityError.invalidSecretKey }
        let xonly = try Secp256k1Helpers.xOnlyPublicKey(from: sk)
        let data5 = try Bech32.convertBits([UInt8](xonly), from: 8, to: 5, pad: true)
        return try Bech32.encode(hrp: "npub", data: data5)
    }

    public static func importIdentity(secretKeyInput: String) throws -> NostrIdentity {
        let nsecHex = try normalizeSecretKeyInput(secretKeyInput)
        let npub = try deriveNpub(fromSecretKeyHex: nsecHex)
        return NostrIdentity(nsecHex: nsecHex, npub: npub)
    }
}

private enum Bech32 {
    private static let charset = Array("qpzry9x8gf2tvdw0s3jn54khce6mua7l")
    private static let charsetMap: [Character: UInt8] = {
        var map: [Character: UInt8] = [:]
        for (i, c) in charset.enumerated() { map[c] = UInt8(i) }
        return map
    }()

    static func encode(hrp: String, data: [UInt8]) throws -> String {
        let checksum = createChecksum(hrp: hrp, data: data)
        let combined = data + checksum
        let payload = combined.map { String(charset[Int($0)]) }.joined()
        return hrp + "1" + payload
    }

    static func decode(_ bech: String) throws -> (String, [UInt8]) {
        guard let pos = bech.lastIndex(of: "1") else { throw NostrIdentityService.IdentityError.invalidNsec }
        let hrp = String(bech[..<pos])
        let dataPart = bech[bech.index(after: pos)...]
        guard !hrp.isEmpty, dataPart.count >= 6 else { throw NostrIdentityService.IdentityError.invalidNsec }

        var data: [UInt8] = []
        for ch in dataPart {
            guard let v = charsetMap[ch] else { throw NostrIdentityService.IdentityError.invalidNsec }
            data.append(v)
        }

        guard verifyChecksum(hrp: hrp, data: data) else { throw NostrIdentityService.IdentityError.invalidNsec }
        return (hrp, Array(data.dropLast(6)))
    }

    static func convertBits(_ data: [UInt8], from: Int, to: Int, pad: Bool) throws -> [UInt8] {
        var acc = 0
        var bits = 0
        let maxv = (1 << to) - 1
        let maxAcc = (1 << (from + to - 1)) - 1
        var ret: [UInt8] = []

        for value in data {
            let v = Int(value)
            guard (v >> from) == 0 else { throw NostrIdentityService.IdentityError.invalidNsec }
            acc = ((acc << from) | v) & maxAcc
            bits += from
            while bits >= to {
                bits -= to
                ret.append(UInt8((acc >> bits) & maxv))
            }
        }

        if pad {
            if bits > 0 {
                ret.append(UInt8((acc << (to - bits)) & maxv))
            }
        } else {
            if bits >= from || ((acc << (to - bits)) & maxv) != 0 {
                throw NostrIdentityService.IdentityError.invalidNsec
            }
        }

        return ret
    }

    private static let generator: [UInt32] = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

    private static func polymod(_ values: [UInt8]) -> UInt32 {
        var chk: UInt32 = 1
        for v in values {
            let b = chk >> 25
            chk = ((chk & 0x1ffffff) << 5) ^ UInt32(v)
            for i in 0..<5 where ((b >> i) & 1) != 0 {
                chk ^= generator[Int(i)]
            }
        }
        return chk
    }

    private static func hrpExpand(_ hrp: String) -> [UInt8] {
        let bytes = Array(hrp.utf8)
        let high = bytes.map { $0 >> 5 }
        let low = bytes.map { $0 & 31 }
        return high + [0] + low
    }

    private static func createChecksum(hrp: String, data: [UInt8]) -> [UInt8] {
        let values = hrpExpand(hrp) + data + Array(repeating: UInt8(0), count: 6)
        let mod = polymod(values) ^ 1
        return (0..<6).map { i in UInt8((mod >> UInt32(5 * (5 - i))) & 31) }
    }

    private static func verifyChecksum(hrp: String, data: [UInt8]) -> Bool {
        polymod(hrpExpand(hrp) + data) == 1
    }
}

private extension Data {
    init?(hex: String) {
        guard hex.count % 2 == 0 else { return nil }
        var bytes = [UInt8]()
        bytes.reserveCapacity(hex.count / 2)

        var i = hex.startIndex
        while i < hex.endIndex {
            let j = hex.index(i, offsetBy: 2)
            let chunk = hex[i..<j]
            guard let byte = UInt8(chunk, radix: 16) else { return nil }
            bytes.append(byte)
            i = j
        }
        self.init(bytes)
    }
}
