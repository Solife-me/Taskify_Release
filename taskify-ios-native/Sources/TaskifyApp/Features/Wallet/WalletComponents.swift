import SwiftUI
import TaskifyCore
#if canImport(UIKit)
import UIKit
#endif

struct WalletActionButton: View {
    let title: String
    let icon: String
    let accent: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(.headline)
                .frame(maxWidth: .infinity)
                .frame(height: 52)
                .foregroundStyle(TaskifyTheme.primaryText)
                .taskifyGlassControl(
                    in: Capsule(),
                    tint: accent ? TaskifyTheme.accent.opacity(0.72) : nil
                )
        }
        .buttonStyle(.plain)
    }
}
struct WalletUtilityButton: View {
    let title: String
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TaskifyTheme.primaryText)
                .padding(.horizontal, 15)
                .frame(height: 40)
                .taskifyGlassControl(in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
    }
}

/// The header every PWA result page opens with: a back affordance on the left ("← New token",
/// "← New invoice", "← New request") and a quiet status/mode label on the right.
struct WalletResultHeaderRow: View {
    let backTitle: String
    var status: String?
    let onBack: () -> Void

    var body: some View {
        HStack {
            Button(action: onBack) {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.left")
                        .font(.subheadline.weight(.semibold))
                    Text(backTitle)
                        .font(.subheadline)
                }
                .foregroundStyle(TaskifyTheme.secondaryText)
            }
            .buttonStyle(.plain)

            Spacer(minLength: 8)

            if let status {
                Text(status)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }
        }
    }
}

/// The two-up row of quiet glass buttons the PWA uses for a page's secondary choices
/// (Contacts | Paste, Single-use | Multi-use).
struct WalletSecondaryActionGrid<Leading: View, Trailing: View>: View {
    @ViewBuilder var leading: Leading
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 10) {
            leading
            trailing
        }
    }
}

/// One cell of `WalletSecondaryActionGrid`. `isSelected` renders the PWA's accent-outlined state
/// used by the single-use/multi-use toggle; plain cells leave it false.
struct WalletSecondaryActionButton: View {
    let title: String
    var systemImage: String?
    var isSelected: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let systemImage { Image(systemName: systemImage) }
                Text(title)
            }
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity)
            .frame(height: 44)
            .foregroundStyle(isSelected ? TaskifyTheme.accent : TaskifyTheme.primaryText)
            .taskifyGlassControl(in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(isSelected ? TaskifyTheme.accent : .clear, lineWidth: 1.5)
            )
        }
        .buttonStyle(.plain)
    }
}

/// The uppercase micro-label the PWA puts above every field group in the wallet sheets
/// (`text-[11px] uppercase tracking-wide`).
@ViewBuilder
func walletFieldLabel(_ text: String) -> some View {
    Text(text)
        .font(.system(size: 11, weight: .semibold))
        .tracking(1.1)
        .foregroundStyle(TaskifyTheme.secondaryText)
        .frame(maxWidth: .infinity, alignment: .leading)
}

struct WalletMintSelectorCard: View {
    let label: String
    let mints: [CashuMintSummary]
    @Binding var selectedMintURL: String

    private var selectedMint: CashuMintSummary? {
        mints.first { $0.url == selectedMintURL }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
                .font(.system(size: 11, weight: .semibold))
                .tracking(1.1)
                .foregroundStyle(TaskifyTheme.secondaryText)

            Menu {
                ForEach(mints) { mint in
                    Button {
                        selectedMintURL = mint.url
                    } label: {
                        if mint.url == selectedMintURL {
                            Label(mint.name, systemImage: "checkmark")
                        } else {
                            Text(mint.name)
                        }
                    }
                }
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(selectedMint?.name ?? "Select mint")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(TaskifyTheme.primaryText)
                        Text(selectedMint.map { "\(WalletAmountFormat.formatSats($0.available, display: WalletCurrencySettings.denominationDisplay)) available" } ?? "No mint selected")
                            .font(.caption)
                            .foregroundStyle(TaskifyTheme.secondaryText)
                    }
                    Spacer()
                    if mints.count > 1 {
                        Image(systemName: "chevron.down")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(TaskifyTheme.secondaryText)
                    }
                }
                .padding(.horizontal, 16)
                .frame(height: 52)
                .taskifyGlass(cornerRadius: 20)
            }
            .buttonStyle(.plain)
            .disabled(mints.count <= 1)
        }
    }
}

struct WalletAmountDisplayCard: View {
    /// The figure as the user is entering it, already denominated by the caller -- sats or
    /// dollars depending on which way the display is currently flipped.
    let primary: String
    var caption: String = "Enter amount"
    /// The same amount in the other currency. Matches the PWA amount display's secondary line
    /// (`lightning-amount-display__secondary`), which sits directly under the figure rather than
    /// being folded into the caption.
    var secondary: String?
    /// Tapping the display swaps which currency you're typing in, as it does in the PWA. Omitted
    /// where there is no conversion to swap to, which also leaves the card non-interactive.
    var onToggleCurrency: (() -> Void)?

    var body: some View {
        let content = VStack(spacing: 4) {
            Text(primary)
                .font(.system(size: 44, weight: .bold, design: .rounded))
                .foregroundStyle(TaskifyTheme.primaryText)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
            if let secondary {
                Text(secondary)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(TaskifyTheme.secondaryText)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            Text(caption)
                .font(.footnote)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 22)
        .taskifyGlass(cornerRadius: 24)

        if let onToggleCurrency {
            Button {
                onToggleCurrency()
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            } label: {
                content
            }
            .buttonStyle(.plain)
            .accessibilityHint("Double-tap to switch which currency is shown first")
        } else {
            content
        }
    }
}

/// The single full-width primary action every wallet sheet ends with, matching the PWA's
/// `accent-button accent-button--tall w-full` -- previously each sheet hand-rolled its own,
/// so heights and label weights drifted between them.
struct WalletPrimaryActionButton: View {
    let title: String
    var busyTitle: String?
    var isBusy: Bool = false
    var systemImage: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if isBusy {
                    ProgressView().controlSize(.small).tint(.white)
                } else if let systemImage {
                    Image(systemName: systemImage)
                }
                Text(isBusy ? (busyTitle ?? title) : title)
            }
            .font(.headline)
            .frame(maxWidth: .infinity)
            .frame(height: 54)
            .foregroundStyle(.white)
            .taskifyGlassControl(in: Capsule(), tint: TaskifyTheme.accent.opacity(0.78))
        }
        .buttonStyle(.plain)
    }
}

/// A label/value row for the review and result screens. The PWA lists these as
/// `secondary label on the left, semibold value on the right` rows; keeping one implementation
/// stops each sheet inventing its own spacing.
struct WalletDetailRow: View {
    let title: String
    let value: String
    var emphasized: Bool = false
    var valueColor: Color?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(title)
                .font(.subheadline)
                .foregroundStyle(TaskifyTheme.secondaryText)
            Spacer(minLength: 8)
            Text(value)
                .font(emphasized ? .subheadline.weight(.bold) : .subheadline.weight(.semibold))
                .foregroundStyle(valueColor ?? TaskifyTheme.primaryText)
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
        }
    }
}

/// The amount hero used at the top of review/result screens: an uppercase micro-label, the figure,
/// and its conversion -- the same block the PWA shows above a Lightning invoice's details.
struct WalletAmountHero: View {
    let label: String
    let amount: String
    var secondary: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.system(size: 11, weight: .semibold))
                .tracking(1.1)
                .foregroundStyle(TaskifyTheme.secondaryText)
            Text(amount)
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .foregroundStyle(TaskifyTheme.primaryText)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
            if let secondary {
                Text(secondary)
                    .font(.subheadline)
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 22)
    }
}

struct WalletAmountKeypad: View {
    @Binding var amountText: String
    var maxDigits: Int = 12
    /// Dollar entry needs a decimal point; sat entry has no fractional part and keeps Clear in
    /// that slot instead. Same swap the PWA makes on its keypad.
    var allowsDecimal: Bool = false

    private var keys: [String] {
        ["1", "2", "3", "4", "5", "6", "7", "8", "9", allowsDecimal ? "decimal" : "clear", "0", "backspace"]
    }

    var body: some View {
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 3),
            spacing: 12
        ) {
            ForEach(keys, id: \.self) { key in
                Button {
                    handle(key)
                } label: {
                    Group {
                        if key == "clear" {
                            Text("Clear")
                                .font(.subheadline.weight(.semibold))
                        } else if key == "decimal" {
                            Text(".")
                                .font(.title3.weight(.semibold))
                        } else if key == "backspace" {
                            Image(systemName: "delete.left")
                                .font(.system(size: 17, weight: .semibold))
                        } else {
                            Text(key)
                                .font(.title3.weight(.semibold))
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 56)
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .taskifyGlassControl(in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func handle(_ key: String) {
        let keypadKey: WalletAmountKeypadKey
        switch key {
        case "clear": keypadKey = .clear
        case "backspace": keypadKey = .backspace
        case "decimal": keypadKey = .decimalPoint
        default: keypadKey = .digit(Character(key))
        }
        amountText = WalletAmountEntry.apply(
            keypadKey,
            to: amountText,
            allowsDecimal: allowsDecimal,
            maxDigits: maxDigits
        )
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
}
