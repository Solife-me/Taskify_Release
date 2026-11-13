import Foundation

/// Sizing policy for the Mac chat composer's editor.
///
/// The editor grows with its draft and then scrolls, so the height it reports to the layout
/// system changes on almost every keystroke of a long message. That height must be a whole number
/// of points: a fractional height can leave the hosting view and the text view trading sub-point
/// layout passes, and AppKit aborts the window when the resulting invalidation never settles.
public enum MacChatComposerMetrics {
    /// One line at minimum; the draft scrolls inside the editor beyond this many lines.
    public static let maximumLines: CGFloat = 8

    /// The editor's height for a measured draft: at least one line, never more than the cap, and
    /// always integral so measuring the result again yields the same value.
    public static func height(contentHeight: CGFloat, lineHeight: CGFloat) -> CGFloat {
        let singleLine = max(1, ceil(lineHeight))
        let content = max(1, ceil(contentHeight))
        return min(max(content, singleLine), singleLine * maximumLines)
    }
}
