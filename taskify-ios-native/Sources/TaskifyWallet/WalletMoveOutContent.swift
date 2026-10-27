import Foundation

/// The wallet's only way forward while it is phased out: every route out of the Taskify wallet,
/// and none in. iOS and macOS render this policy rather than keeping separate route lists.
public struct WalletMoveOutRoute: Identifiable, Equatable {
    public enum ID: String, CaseIterable, Identifiable {
        case receive
        case payLightning
        case makeEcashToken
        case moveToNWC
        case claimNpubCash
        case showRecoveryWords

        public var id: String { rawValue }
    }

    public enum Section: String, CaseIterable {
        case lightning
        case ecash
        case npubCash
        case restore
    }

    public let id: ID
    public let title: String
    public let detail: String
    public let systemImage: String
    public let section: Section
    public let isEnabled: Bool

    public init(
        id: ID,
        title: String,
        detail: String,
        systemImage: String,
        section: Section,
        isEnabled: Bool
    ) {
        self.id = id
        self.title = title
        self.detail = detail
        self.systemImage = systemImage
        self.section = section
        self.isEnabled = isEnabled
    }
}

public enum WalletMoveOutContent {
    public static let intro = """
    The wallet no longer takes in new funds, and it closes on \(TaskifyWalletPhaseOut.removalDateText). Move what is left to a wallet you keep.
    """

    public static func balanceText(formattedBalance: String, hasFunds: Bool) -> String {
        hasFunds ? "\(formattedBalance) to move" : "Nothing left to move."
    }

    public static func sectionTitle(for section: WalletMoveOutRoute.Section) -> String {
        switch section {
        case .lightning: "To a Lightning wallet"
        case .ecash: "As ecash, to another Cashu wallet"
        case .npubCash: "npub.cash"
        case .restore: "Restore in another Cashu wallet"
        }
    }

    public static func routes(
        balanceSats: UInt64,
        hasNWCWallet: Bool,
        usesNpubCashProvider: Bool,
        claimMessage: String? = nil,
        isBusy: Bool = false
    ) -> [WalletMoveOutRoute] {
        var routes: [WalletMoveOutRoute] = [
            WalletMoveOutRoute(
                id: .payLightning,
                title: "Pay an invoice or Lightning address",
                detail: "From your own wallet's receive screen.",
                systemImage: "bolt.fill",
                section: .lightning,
                isEnabled: balanceSats > 0
            ),
            WalletMoveOutRoute(
                id: .makeEcashToken,
                title: "Make an ecash token",
                detail: "Redeem it in Minibits, Cashu.me or another Cashu wallet. It stays in History until claimed.",
                systemImage: "banknote",
                section: .ecash,
                isEnabled: balanceSats > 0
            )
        ]

        if hasNWCWallet {
            routes.append(WalletMoveOutRoute(
                id: .moveToNWC,
                title: "Move to your NWC wallet",
                detail: "Pays your connected wallet over Lightning.",
                systemImage: "arrow.right.circle",
                section: .ecash,
                isEnabled: balanceSats > 0
            ))
        }

        if usesNpubCashProvider {
            routes.append(WalletMoveOutRoute(
                id: .claimNpubCash,
                title: "Claim payments waiting at npub.cash",
                detail: claimMessage
                    ?? "Payments to your old address arrive here first; move them out after claiming.",
                systemImage: "tray.and.arrow.down",
                section: .npubCash,
                isEnabled: !isBusy
            ))
        }

        routes.append(WalletMoveOutRoute(
            id: .showRecoveryWords,
            title: "Show the 12 words",
            detail: "A NUT-13 wallet can restore most of these funds from them.",
            systemImage: "key.viewfinder",
            section: .restore,
            isEnabled: true
        ))

        return routes
    }
}
