/// Which mints to offer when paying a Cashu payment request: prefer the request's own suggested
/// mints filtered down to ones this wallet actually has, so a request naming an unknown or
/// unreachable mint never silently blocks payment.
public enum MacPaymentRequestMintSelection {
    public static func candidates(requestedMintURLs: [String], walletMintURLs: [String]) -> [String] {
        guard !requestedMintURLs.isEmpty else { return walletMintURLs }
        let wallet = Set(walletMintURLs)
        let matching = requestedMintURLs.filter { wallet.contains($0) }
        return matching.isEmpty ? walletMintURLs : matching
    }
}
