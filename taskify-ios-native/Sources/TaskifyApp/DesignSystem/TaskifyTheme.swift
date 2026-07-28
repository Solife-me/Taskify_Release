import SwiftUI

enum TaskifyTheme {
    static let accent = Color(red: 0.04, green: 0.52, blue: 1.0)
    /// Foreground used on top of a filled `accent` surface — the PWA's `--accent-on` (#061428).
    static let accentOn = Color(red: 0.024, green: 0.078, blue: 0.157)
    /// Translucent accent wash for rings and halos — the PWA's `--accent-soft`.
    static let accentSoft = Color(red: 0.251, green: 0.612, blue: 1.0).opacity(0.2)
    static let backgroundTop = Color(red: 0.10, green: 0.20, blue: 0.33)
    static let backgroundMid = Color(red: 0.035, green: 0.075, blue: 0.12)
    static let backgroundBottom = Color.black
    static let primaryText = Color(red: 0.97, green: 0.97, blue: 0.99)
    static let secondaryText = Color(red: 0.78, green: 0.81, blue: 0.88)
    static let tertiaryText = Color(red: 0.62, green: 0.65, blue: 0.72)
    static let panelFill = Color.white.opacity(0.075)
    static let raisedFill = Color.white.opacity(0.11)
    static let border = Color.white.opacity(0.12)

    static let glassSheen = LinearGradient(
        colors: [Color.white.opacity(0.10), Color.white.opacity(0.03), Color.black.opacity(0.05)],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )
    static let glassStroke = LinearGradient(
        colors: [Color.white.opacity(0.24), border],
        startPoint: .top,
        endPoint: .bottom
    )

    static var background: LinearGradient {
        LinearGradient(
            colors: [backgroundTop, backgroundMid, backgroundBottom],
            startPoint: .topLeading,
            endPoint: .bottom
        )
    }
}

struct GlassPanel: ViewModifier {
    var cornerRadius: CGFloat = 24

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
    }

    func body(content: Content) -> some View {
        content
            .background(
                shape
                    .fill(TaskifyTheme.panelFill)
                    .background(.ultraThinMaterial, in: shape)
                    .overlay(shape.fill(TaskifyTheme.glassSheen))
            )
            .overlay(shape.stroke(TaskifyTheme.glassStroke, lineWidth: 1))
    }
}

extension View {
    func taskifyGlass(cornerRadius: CGFloat = 24) -> some View {
        modifier(GlassPanel(cornerRadius: cornerRadius))
    }

    func taskifyScreenTitle() -> some View {
        font(.system(size: 22, weight: .bold))
            .foregroundStyle(TaskifyTheme.primaryText)
    }

    func taskifyGlassControl<ControlShape: Shape>(
        in shape: ControlShape,
        tint: Color? = nil,
        fallbackFill: Color = TaskifyTheme.raisedFill
    ) -> some View {
        modifier(TaskifyGlassControlModifier(
            shape: shape,
            tint: tint,
            fallbackFill: fallbackFill
        ))
    }
}

private struct TaskifyGlassControlModifier<ControlShape: Shape>: ViewModifier {
    let shape: ControlShape
    let tint: Color?
    let fallbackFill: Color

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            if let tint {
                content
                    .glassEffect(.regular.tint(tint).interactive(), in: shape)
            } else {
                content
                    .glassEffect(.regular.interactive(), in: shape)
            }
        } else {
            content
                .background(fallbackFill, in: shape)
                .overlay(shape.stroke(TaskifyTheme.border, lineWidth: 1))
        }
    }
}

struct TaskifyGlassControlGroup<Content: View>: View {
    let spacing: CGFloat
    let content: Content

    init(spacing: CGFloat = 8, @ViewBuilder content: () -> Content) {
        self.spacing = spacing
        self.content = content()
    }

    @ViewBuilder
    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) {
                content
            }
        } else {
            content
        }
    }
}

struct HeaderIconButton: View {
    let systemName: String
    var accent = false
    var accessibilityLabel: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 16, weight: .semibold))
                .frame(width: 42, height: 42)
                .foregroundStyle(accent ? .white : TaskifyTheme.primaryText)
                .taskifyGlassControl(
                    in: Circle(),
                    tint: accent ? TaskifyTheme.accent.opacity(0.72) : nil,
                    fallbackFill: accent ? TaskifyTheme.accent : TaskifyTheme.raisedFill
                )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
    }
}
