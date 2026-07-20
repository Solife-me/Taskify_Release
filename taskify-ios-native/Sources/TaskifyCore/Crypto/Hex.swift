import Foundation

public enum HexError: LocalizedError {
    case invalidLength
    case invalidCharacter

    public var errorDescription: String? {
        switch self {
        case .invalidLength: "A hexadecimal value must contain an even number of characters."
        case .invalidCharacter: "The value contains a character that is not hexadecimal."
        }
    }
}

public extension Data {
    init(hex: String) throws {
        guard hex.count.isMultiple(of: 2) else { throw HexError.invalidLength }
        var result = Data(capacity: hex.count / 2)
        var index = hex.startIndex

        while index < hex.endIndex {
            let nextIndex = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<nextIndex], radix: 16) else {
                throw HexError.invalidCharacter
            }
            result.append(byte)
            index = nextIndex
        }
        self = result
    }

    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
