import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// Point sizes that follow Dynamic Type (C8-3). Each size scales with the text style nearest to
/// it, so at the default text size every screen looks exactly as designed, and at larger or
/// smaller sizes it grows and shrinks with the rest of iOS.
enum ScaledSize {
    static func textStyle(for size: CGFloat) -> Font.TextStyle {
        switch size {
        case ..<11.5: .caption2
        case ..<12.5: .caption
        case ..<13.5: .footnote
        case ..<15.5: .subheadline
        case ..<16.5: .callout
        case ..<19: .body
        case ..<21: .title3
        case ..<25: .title2
        case ..<31: .title
        default: .largeTitle
        }
    }

#if canImport(UIKit)
    private static func uiTextStyle(_ style: Font.TextStyle) -> UIFont.TextStyle {
        switch style {
        case .caption2: .caption2
        case .caption: .caption1
        case .footnote: .footnote
        case .subheadline: .subheadline
        case .callout: .callout
        case .title3: .title3
        case .title2: .title2
        case .title: .title1
        case .largeTitle: .largeTitle
        case .headline: .headline
        default: .body
        }
    }
#endif

    /// `size` at the given Dynamic Type size, scaled like `style` (by default its nearest text
    /// style). Pass the style of the text a control sits beside to keep the two in proportion.
    static func scaled(_ size: CGFloat, relativeTo style: Font.TextStyle? = nil, for dynamicTypeSize: DynamicTypeSize) -> CGFloat {
#if canImport(UIKit)
        let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(dynamicTypeSize))
        return UIFontMetrics(forTextStyle: uiTextStyle(style ?? textStyle(for: size)))
            .scaledValue(for: size, compatibleWith: traits)
#else
        // UIKit supplies the explicit point-size metrics used on iOS. macOS applies its own
        // accessibility display scaling, so preserve the design point size there.
        return size
#endif
    }
}

private struct ScaledFontModifier: ViewModifier {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let size: CGFloat
    let weight: Font.Weight
    let design: Font.Design

    func body(content: Content) -> some View {
        content.font(.system(size: ScaledSize.scaled(size, for: dynamicTypeSize), weight: weight, design: design))
    }
}

extension View {
    /// A system font of `size` points at the default text size that follows Dynamic Type.
    func scaledFont(size: CGFloat, weight: Font.Weight = .regular, design: Font.Design = .default) -> some View {
        modifier(ScaledFontModifier(size: size, weight: weight, design: design))
    }
}
