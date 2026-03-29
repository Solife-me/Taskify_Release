/// ThemeColors.swift
/// Centralized color definitions matching the PWA CSS variables.
/// Provides accent-aware colors for the entire iOS app.

import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

public enum ThemeColors {

    // MARK: - Accent colors (match PWA ACCENT_CHOICES)

    /// iMessage blue — #0a84ff
    public static let accentBlue = Color(red: 10/255, green: 132/255, blue: 255/255)
    /// Mint green — #34c759
    public static let accentGreen = Color(red: 52/255, green: 199/255, blue: 89/255)

    /// Returns the SwiftUI Color for a given accent choice.
    public static func accent(for choice: AccentChoice) -> Color {
        switch choice {
        case .blue: return accentBlue
        case .green: return accentGreen
        case .background: return accentBlue
        }
    }

    /// Returns the resolved accent color for the active settings payload,
    /// including imported photo-derived background accents from the PWA.
    public static func accent(for settings: UserSettings) -> Color {
        if let fill = settings.activeAccentFillHex,
           let color = color(fromHex: fill) {
            return color
        }
        return accent(for: settings.accent)
    }

    // MARK: - Semantic colors (matching PWA CSS variables)

    /// Surface background — adapts to light/dark
    public static let surfaceBase: Color = {
        #if canImport(UIKit)
        Color(uiColor: .systemBackground)
        #elseif canImport(AppKit)
        Color(nsColor: .windowBackgroundColor)
        #else
        .white
        #endif
    }()
    /// Slightly raised surface (cards, sheets)
    public static let surfaceRaised: Color = {
        #if canImport(UIKit)
        Color(uiColor: .secondarySystemBackground)
        #elseif canImport(AppKit)
        Color(nsColor: .controlBackgroundColor)
        #else
        Color(red: 0.96, green: 0.96, blue: 0.97)
        #endif
    }()
    /// Grouped background
    public static let surfaceGrouped: Color = {
        #if canImport(UIKit)
        Color(uiColor: .systemGroupedBackground)
        #elseif canImport(AppKit)
        Color(nsColor: .underPageBackgroundColor)
        #else
        Color(red: 0.94, green: 0.94, blue: 0.96)
        #endif
    }()
    /// Border/separator
    public static let surfaceBorder: Color = {
        #if canImport(UIKit)
        Color(uiColor: .separator)
        #elseif canImport(AppKit)
        Color(nsColor: .separatorColor)
        #else
        Color.black.opacity(0.12)
        #endif
    }()

    // MARK: - Text colors

    public static let textPrimary: Color = {
        #if canImport(UIKit)
        Color(uiColor: .label)
        #elseif canImport(AppKit)
        Color(nsColor: .labelColor)
        #else
        .primary
        #endif
    }()
    public static let textSecondary: Color = {
        #if canImport(UIKit)
        Color(uiColor: .secondaryLabel)
        #elseif canImport(AppKit)
        Color(nsColor: .secondaryLabelColor)
        #else
        .secondary
        #endif
    }()
    public static let textTertiary: Color = {
        #if canImport(UIKit)
        Color(uiColor: .tertiaryLabel)
        #elseif canImport(AppKit)
        Color(nsColor: .tertiaryLabelColor)
        #else
        Color.primary.opacity(0.6)
        #endif
    }()

    // MARK: - Status colors

    public static let success = Color.green
    public static let warning = Color.orange
    public static let danger = Color.red
    public static let overdue = Color.red

    // MARK: - Priority colors (matching PWA)

    public static func priorityColor(_ level: Int?) -> Color {
        switch level {
        case 1: return accentBlue          // low
        case 2: return .orange              // medium
        case 3: return .red                 // high
        default: return .clear
        }
    }
}

// MARK: - Environment Key for Accent

private struct AccentColorKey: EnvironmentKey {
    static let defaultValue: AccentChoice = .blue
}

public extension EnvironmentValues {
    var appAccent: AccentChoice {
        get { self[AccentColorKey.self] }
        set { self[AccentColorKey.self] = newValue }
    }
}

public extension View {
    func appAccent(_ accent: AccentChoice) -> some View {
        environment(\.appAccent, accent)
            .tint(ThemeColors.accent(for: accent))
    }

    func appAccent(_ settings: UserSettings) -> some View {
        environment(\.appAccent, settings.accent)
            .tint(ThemeColors.accent(for: settings))
    }
}

private extension ThemeColors {
    static func color(fromHex value: String) -> Color? {
        var hex = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !hex.isEmpty else { return nil }
        if hex.hasPrefix("#") {
            hex.removeFirst()
        }

        if hex.count == 3 {
            hex = hex.reduce(into: "") { partial, character in
                partial.append(character)
                partial.append(character)
            }
        }

        guard hex.count == 6, let intValue = UInt64(hex, radix: 16) else {
            return nil
        }

        let red = Double((intValue & 0xFF0000) >> 16) / 255
        let green = Double((intValue & 0x00FF00) >> 8) / 255
        let blue = Double(intValue & 0x0000FF) / 255
        return Color(red: red, green: green, blue: blue)
    }
}
