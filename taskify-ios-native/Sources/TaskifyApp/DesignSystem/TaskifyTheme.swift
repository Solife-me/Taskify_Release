import SwiftUI
import TaskifyCore
import TaskifyWatchShared
import UIKit

enum TaskifyAccentChoice: String, CaseIterable {
    case blue
    case green
    case background

    static let presetChoices: [TaskifyAccentChoice] = [.blue, .green]

    var label: String {
        switch self {
        case .blue: "Blue"
        case .green: "Green"
        case .background: "Photo"
        }
    }
}

enum TaskifyInterfaceScale: String, CaseIterable {
    case system
    case small
    case large
    case extraLarge

    var label: String {
        switch self {
        case .system: "System"
        case .small: "Small"
        case .large: "Large"
        case .extraLarge: "X-Large"
        }
    }

    var dynamicTypeSize: DynamicTypeSize {
        switch self {
        case .system: .large
        case .small: .medium
        case .large: .xLarge
        case .extraLarge: .xxxLarge
        }
    }
}

enum TaskifyAppearanceSettings {
    static let accentKey = "taskify.appearance.accent"
    static let scaleKey = "taskify.appearance.scale"
    static let backgroundEnabledKey = "taskify.appearance.backgroundEnabled"
    static let backgroundBlurKey = "taskify.appearance.backgroundBlur"
    static let backgroundAccentsKey = "taskify.appearance.backgroundAccents"
    static let backgroundAccentIndexKey = "taskify.appearance.backgroundAccentIndex"
    static let revisionKey = "taskify.appearance.revision"

    static var accentChoice: TaskifyAccentChoice {
        UserDefaults.standard.string(forKey: accentKey).flatMap(TaskifyAccentChoice.init(rawValue:)) ?? .blue
    }

    static var interfaceScale: TaskifyInterfaceScale {
        UserDefaults.standard.string(forKey: scaleKey).flatMap(TaskifyInterfaceScale.init(rawValue:)) ?? .system
    }

    static var hasBackgroundImage: Bool {
        UserDefaults.standard.bool(forKey: backgroundEnabledKey)
    }

    static var backgroundIsBlurred: Bool {
        (UserDefaults.standard.object(forKey: backgroundBlurKey) as? Bool) ?? false
    }

    static var backgroundAccents: [TaskifyRGBColor] {
        guard hasBackgroundImage,
              let data = UserDefaults.standard.data(forKey: backgroundAccentsKey),
              let decoded = try? JSONDecoder().decode([TaskifyRGBColor].self, from: data)
        else { return [] }
        return Array(decoded.prefix(3))
    }

    static var selectedBackgroundAccentIndex: Int? {
        let accents = backgroundAccents
        guard !accents.isEmpty else { return nil }
        let stored = UserDefaults.standard.integer(forKey: backgroundAccentIndexKey)
        return accents.indices.contains(stored) ? stored : 0
    }

    static var selectedBackgroundAccent: TaskifyRGBColor? {
        guard let index = selectedBackgroundAccentIndex else { return nil }
        return backgroundAccents[index]
    }

    static var backgroundImageURL: URL {
        let base = (try? FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )) ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("taskify-background.jpg")
    }

    static var backgroundImage: UIImage? {
        guard hasBackgroundImage else { return nil }
        return UIImage(contentsOfFile: backgroundImageURL.path)
    }

    static func saveBackgroundImage(data: Data) throws {
        guard let source = UIImage(data: data) else { throw AppearanceError.invalidImage }
        let sourceWidth = CGFloat(source.cgImage?.width ?? Int(source.size.width * source.scale))
        let sourceHeight = CGFloat(source.cgImage?.height ?? Int(source.size.height * source.scale))
        guard sourceWidth > 0, sourceHeight > 0 else { throw AppearanceError.invalidImage }

        let maxDimension: CGFloat = 2_048
        let scale = min(1, maxDimension / max(sourceWidth, sourceHeight))
        let targetSize = CGSize(width: sourceWidth * scale, height: sourceHeight * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: targetSize, format: format)
        let normalized = renderer.image { _ in
            source.draw(in: CGRect(origin: .zero, size: targetSize))
        }
        guard let encoded = normalized.jpegData(compressionQuality: 0.86) else {
            throw AppearanceError.invalidImage
        }

        let accents = TaskifyBackgroundImageSampler.suggestedAccents(from: normalized)
        try encoded.write(to: backgroundImageURL, options: [.atomic, .completeFileProtection])
        let defaults = UserDefaults.standard
        defaults.set(true, forKey: backgroundEnabledKey)
        persistBackgroundAccents(accents)
        defaults.set(0, forKey: backgroundAccentIndexKey)
        defaults.set(TaskifyAccentChoice.background.rawValue, forKey: accentKey)
        if defaults.object(forKey: backgroundBlurKey) == nil {
            defaults.set(false, forKey: backgroundBlurKey)
        }
        bumpRevision()
    }

    /// Upgrades backgrounds saved by the early native implementation without adding work to
    /// app launch. Settings calls this only when the Appearance card is presented.
    @discardableResult
    static func ensureBackgroundAccents() -> Bool {
        guard hasBackgroundImage, backgroundAccents.isEmpty, let image = backgroundImage else {
            return false
        }
        persistBackgroundAccents(TaskifyBackgroundImageSampler.suggestedAccents(from: image))
        UserDefaults.standard.set(0, forKey: backgroundAccentIndexKey)
        bumpRevision()
        return true
    }

    static func selectBackgroundAccent(at index: Int) {
        guard backgroundAccents.indices.contains(index) else { return }
        let defaults = UserDefaults.standard
        defaults.set(index, forKey: backgroundAccentIndexKey)
        defaults.set(TaskifyAccentChoice.background.rawValue, forKey: accentKey)
        bumpRevision()
    }

    static func selectAccent(_ choice: TaskifyAccentChoice) {
        guard choice != .background || selectedBackgroundAccent != nil else { return }
        UserDefaults.standard.set(choice.rawValue, forKey: accentKey)
        bumpRevision()
    }

    static func removeBackgroundImage() {
        try? FileManager.default.removeItem(at: backgroundImageURL)
        let defaults = UserDefaults.standard
        defaults.set(false, forKey: backgroundEnabledKey)
        defaults.removeObject(forKey: backgroundAccentsKey)
        defaults.removeObject(forKey: backgroundAccentIndexKey)
        if accentChoice == .background {
            defaults.set(TaskifyAccentChoice.blue.rawValue, forKey: accentKey)
        }
        bumpRevision()
    }

    private static func persistBackgroundAccents(_ accents: [TaskifyRGBColor]) {
        let normalized = Array(accents.prefix(3))
        guard !normalized.isEmpty, let data = try? JSONEncoder().encode(normalized) else {
            UserDefaults.standard.removeObject(forKey: backgroundAccentsKey)
            return
        }
        UserDefaults.standard.set(data, forKey: backgroundAccentsKey)
    }

    static func bumpRevision() {
        UserDefaults.standard.set(UUID().uuidString, forKey: revisionKey)
    }

    enum AppearanceError: LocalizedError {
        case invalidImage
        var errorDescription: String? { "That photo couldn't be used as a background." }
    }
}

extension TaskifyRGBColor {
    var taskifyColor: Color {
        Color(
            red: Double(red) / 255,
            green: Double(green) / 255,
            blue: Double(blue) / 255
        )
    }
}

private enum TaskifyBackgroundImageSampler {
    static func suggestedAccents(from image: UIImage) -> [TaskifyRGBColor] {
        let pixels = samplePixels(from: image)
        return TaskifyBackgroundPaletteExtractor.suggestedAccents(from: pixels)
    }

    private static func samplePixels(from image: UIImage) -> [TaskifyRGBColor] {
        guard let source = image.cgImage else { return [] }
        let sourceArea = max(1, source.width * source.height)
        let scale = min(1, sqrt(2_200 / Double(sourceArea)))
        let width = max(16, Int((Double(source.width) * scale).rounded()))
        let height = max(16, Int((Double(source.height) * scale).rounded()))
        let bytesPerRow = width * 4
        var rgba = [UInt8](repeating: 0, count: bytesPerRow * height)
        let colorSpace = CGColorSpaceCreateDeviceRGB()

        let rendered = rgba.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: bytesPerRow,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                    | CGBitmapInfo.byteOrder32Big.rawValue
            ) else { return false }
            context.interpolationQuality = .high
            context.draw(source, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard rendered else { return [] }

        var pixels: [TaskifyRGBColor] = []
        pixels.reserveCapacity(width * height)
        for offset in stride(from: 0, to: rgba.count, by: 4) where rgba[offset + 3] >= 180 {
            pixels.append(TaskifyRGBColor(
                red: rgba[offset],
                green: rgba[offset + 1],
                blue: rgba[offset + 2]
            ))
        }
        return pixels
    }
}

enum TaskifyTheme {
    static var accent: Color {
        color(for: TaskifyAppearanceSettings.accentChoice)
    }

    static func color(for choice: TaskifyAccentChoice) -> Color {
        switch choice {
        case .blue:
            Color(red: TaskifyBrand.accentRed, green: TaskifyBrand.accentGreen, blue: TaskifyBrand.accentBlue)
        case .green:
            Color(red: 52.0 / 255, green: 199.0 / 255, blue: 89.0 / 255)
        case .background:
            TaskifyAppearanceSettings.selectedBackgroundAccent?.taskifyColor
                ?? Color(red: TaskifyBrand.accentRed, green: TaskifyBrand.accentGreen, blue: TaskifyBrand.accentBlue)
        }
    }
    /// Foreground used on top of a filled `accent` surface — the PWA's `--accent-on` (#061428).
    static var accentOn: Color {
        if TaskifyAppearanceSettings.accentChoice == .background,
           let accent = TaskifyAppearanceSettings.selectedBackgroundAccent,
           !accent.prefersDarkForeground {
            return Color(red: 0.96, green: 0.98, blue: 1)
        }
        return Color(
            red: TaskifyBrand.accentOnRed,
            green: TaskifyBrand.accentOnGreen,
            blue: TaskifyBrand.accentOnBlue
        )
    }
    /// Translucent accent wash for rings and halos — the PWA's `--accent-soft`.
    static var accentSoft: Color { accent.opacity(0.2) }
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
        let hasImage = TaskifyAppearanceSettings.hasBackgroundImage
        if TaskifyAppearanceSettings.accentChoice == .background,
           TaskifyAppearanceSettings.selectedBackgroundAccent != nil {
            let baseOpacity = hasImage ? 0.65 : 0.95
            return LinearGradient(
                colors: [
                    accent.opacity(hasImage ? 0.24 : 0.34),
                    backgroundMid.opacity(baseOpacity),
                    backgroundBottom.opacity(baseOpacity),
                ],
                startPoint: .topLeading,
                endPoint: .bottom
            )
        }

        let opacity = hasImage ? 0.54 : 1
        return LinearGradient(
            colors: [backgroundTop.opacity(opacity), backgroundMid.opacity(opacity), backgroundBottom.opacity(opacity)],
            startPoint: .topLeading,
            endPoint: .bottom
        )
    }
}

struct TaskifyAppBackground: View {
    @AppStorage(TaskifyAppearanceSettings.revisionKey) private var revision = ""

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                Color.black

                if let image = TaskifyAppearanceSettings.backgroundImage {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .frame(width: proxy.size.width, height: proxy.size.height)
                        .clipped()
                        .blur(radius: TaskifyAppearanceSettings.backgroundIsBlurred ? 18 : 0)
                        .scaleEffect(TaskifyAppearanceSettings.backgroundIsBlurred ? 1.08 : 1.02)

                    // Preserve the photo's brightness. The old image scrim was followed by the
                    // normal 54–65% app gradient, so a sharp photo could retain less than half of
                    // its original luminance. Glass controls provide their own contrast surface;
                    // this light scrim is only enough to steady uncontained labels and status text.
                    Color.black.opacity(TaskifyAppearanceSettings.backgroundIsBlurred ? 0.10 : 0.04)
                } else {
                    TaskifyTheme.background
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
            .clipped()
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .id(revision)
    }
}

/// A fallback surface for tab content. The containing tab already supplies
/// `TaskifyAppBackground`; drawing the normal app gradient again inside Wallet or a nested board
/// both hid the photo and multiplied its darkening. Screens remain transparent over a photo while
/// retaining the original gradient when no custom background is selected.
struct TaskifyContentBackground: View {
    @AppStorage(TaskifyAppearanceSettings.revisionKey) private var revision = ""

    var body: some View {
        Group {
            if TaskifyAppearanceSettings.hasBackgroundImage {
                Color.clear
            } else {
                TaskifyTheme.background
            }
        }
        .id(revision)
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

// MARK: - Photo background legibility

/// Whether a user-selected photo is currently behind the app's content.
///
/// The default gradient guarantees a dark backdrop, so text and card surfaces can rely on it for
/// contrast. A photo guarantees nothing: a bright sky can land exactly where a caption or a task
/// card does. Rather than dimming the whole app to cover that case, the few surfaces that actually
/// sit on the wallpaper read this and add local contrast only for themselves.
///
/// Injected once by `RootTabView`; the `false` default keeps the standard theme untouched.
private struct TaskifyOverPhotoKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var taskifyOverPhoto: Bool {
        get { self[TaskifyOverPhotoKey.self] }
        set { self[TaskifyOverPhotoKey.self] = newValue }
    }
}

extension View {
    /// A soft dark halo behind small or dim text that has no guaranteed backdrop.
    ///
    /// Applied to leaves rather than to a composed row: a shadow forces its subtree into an
    /// offscreen buffer, and that cost is what kept the card's drop shadow on the background shape
    /// instead of the finished card. When `enabled` is false this returns the view untouched, so
    /// the default theme pays nothing and looks identical.
    @ViewBuilder
    func taskifyLegibilityShadow(_ enabled: Bool) -> some View {
        if enabled {
            shadow(color: .black.opacity(0.55), radius: 3, y: 1)
        } else {
            self
        }
    }
}
