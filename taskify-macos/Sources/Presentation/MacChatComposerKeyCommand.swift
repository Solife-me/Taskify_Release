/// Keyboard behavior for the multi-line Mac chat composer.
public enum MacChatComposerKeyCommand: Equatable, Sendable {
    case send
    case newline
    case passThrough

    public static func command(keyCode: UInt16, shift: Bool) -> Self {
        let isReturn = keyCode == 36 || keyCode == 76 // Return and keypad Enter.
        guard isReturn else { return .passThrough }
        return shift ? .newline : .send
    }
}
