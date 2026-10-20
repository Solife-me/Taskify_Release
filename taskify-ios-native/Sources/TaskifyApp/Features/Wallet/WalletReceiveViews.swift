import LocalAuthentication
import SwiftUI
import TaskifyCore
import TaskifyWallet
#if canImport(UIKit)
import UIKit
#endif
import UniformTypeIdentifiers
#if canImport(VisionKit) && os(iOS)
import VisionKit
#endif

#if os(iOS)
struct CashuTokenScannerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let guidanceTitle: String
    let guidanceText: String
    let unavailableText: String
    let acceptedPrefixes: [String]
    let invalidCodeMessage: String
    let acceptsAnimatedCashu: Bool
    let onToken: (String) -> Void
    @State private var scanError: String?
    @State private var scanStatus: String?

    init(onToken: @escaping (String) -> Void) {
        title = "Scan ecash"
        guidanceTitle = "Scan a Cashu token"
        guidanceText = "Point the camera at a Cashu QR code. Keep it steady while animated frames are captured."
        unavailableText = "You can still paste the Cashu token from the Receive screen."
        acceptedPrefixes = ["cashua", "cashub", "ur:"]
        invalidCodeMessage = "That QR code is not a Cashu token."
        acceptsAnimatedCashu = true
        self.onToken = onToken
    }

    init(lightningInvoice onInvoice: @escaping (String) -> Void) {
        title = "Scan invoice"
        guidanceTitle = "Scan a Lightning invoice"
        guidanceText = "Point the camera at a BOLT11 Lightning invoice."
        unavailableText = "You can still paste the invoice from the Lightning payment screen."
        acceptedPrefixes = ["lightning:ln", "lnbc", "lntb", "lnbcrt", "lnsb"]
        invalidCodeMessage = "That QR code is not a Lightning invoice."
        acceptsAnimatedCashu = false
        onToken = onInvoice
    }

    init(paymentRequest onRequest: @escaping (String) -> Void) {
        title = "Scan request"
        guidanceTitle = "Scan a Cashu request"
        guidanceText = "Point the camera at a creqA, creqB, or unified Bitcoin payment QR code."
        unavailableText = "You can still paste the Cashu request from the payment screen."
        acceptedPrefixes = ["creqa", "creqb1", "bitcoin:", "cashu:creq"]
        invalidCodeMessage = "That QR code is not a Cashu payment request."
        acceptsAnimatedCashu = false
        onToken = onRequest
    }

    private var scannerAvailable: Bool {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }

    var body: some View {
        NavigationStack {
            Group {
                if scannerAvailable {
                    ZStack(alignment: .bottom) {
                        CashuTokenCodeScanner(
                            acceptedPrefixes: acceptedPrefixes,
                            invalidCodeMessage: invalidCodeMessage,
                            acceptsAnimatedCashu: acceptsAnimatedCashu,
                            onCode: onToken,
                            onProgress: {
                                scanError = nil
                                scanStatus = $0
                            },
                            onError: { scanError = $0 }
                        )
                        .ignoresSafeArea(edges: .bottom)

                        VStack(spacing: 8) {
                            Label(guidanceTitle, systemImage: "viewfinder")
                                .font(.subheadline.weight(.semibold))
                            Text(scanError ?? scanStatus ?? guidanceText)
                                .font(.caption)
                                .foregroundStyle(scanError == nil ? TaskifyTheme.secondaryText : Color.orange)
                                .multilineTextAlignment(.center)
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity)
                        .taskifyGlass(cornerRadius: 22)
                        .padding(16)
                    }
                } else {
                    ContentUnavailableView {
                        Label("Camera scanning unavailable", systemImage: "qrcode.viewfinder")
                    } description: {
                        Text(unavailableText)
                    } actions: {
                        Button("Use paste instead") { dismiss() }
                            .buttonStyle(.borderedProminent)
                    }
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .background(TaskifyTheme.background.ignoresSafeArea())
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}

struct CashuTokenCodeScanner: UIViewControllerRepresentable {
    let acceptedPrefixes: [String]
    let invalidCodeMessage: String
    let acceptsAnimatedCashu: Bool
    let onCode: (String) -> Void
    let onProgress: (String) -> Void
    let onError: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(
            acceptedPrefixes: acceptedPrefixes,
            invalidCodeMessage: invalidCodeMessage,
            acceptsAnimatedCashu: acceptsAnimatedCashu,
            onCode: onCode,
            onProgress: onProgress,
            onError: onError
        )
    }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: true,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        context.coordinator.scanner = scanner
        DispatchQueue.main.async {
            do {
                try scanner.startScanning()
            } catch {
                context.coordinator.onError("The camera scanner could not start. Check camera access in iOS Settings.")
            }
        }
        return scanner
    }

    func updateUIViewController(_ uiViewController: DataScannerViewController, context: Context) {}

    static func dismantleUIViewController(_ uiViewController: DataScannerViewController, coordinator: Coordinator) {
        uiViewController.stopScanning()
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let acceptedPrefixes: [String]
        let invalidCodeMessage: String
        let acceptsAnimatedCashu: Bool
        let onCode: (String) -> Void
        let onProgress: (String) -> Void
        let onError: (String) -> Void
        weak var scanner: DataScannerViewController?
        private var deliveredCode = false
        private let animatedCollector = CashuAnimatedQRCollector()
        private let haptic = UISelectionFeedbackGenerator()

        init(
            acceptedPrefixes: [String],
            invalidCodeMessage: String,
            acceptsAnimatedCashu: Bool,
            onCode: @escaping (String) -> Void,
            onProgress: @escaping (String) -> Void,
            onError: @escaping (String) -> Void
        ) {
            self.acceptedPrefixes = acceptedPrefixes
            self.invalidCodeMessage = invalidCodeMessage
            self.acceptsAnimatedCashu = acceptsAnimatedCashu
            self.onCode = onCode
            self.onProgress = onProgress
            self.onError = onError
            haptic.prepare()
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            process(addedItems, with: dataScanner)
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didUpdate updatedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            process(updatedItems, with: dataScanner)
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable
        ) {
            onError("Camera scanning became unavailable. You can still paste the token manually.")
        }

        private func process(
            _ items: [RecognizedItem],
            with dataScanner: DataScannerViewController
        ) {
            guard !deliveredCode else { return }
            var sawBarcode = false
            for item in items {
                guard case let .barcode(barcode) = item,
                      let value = barcode.payloadStringValue else {
                    continue
                }
                sawBarcode = true
                let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
                guard acceptedPrefixes.contains(where: normalized.lowercased().hasPrefix) else {
                    continue
                }

                if acceptsAnimatedCashu {
                    switch animatedCollector.add(normalized) {
                    case .progress(let received, let expected, let duplicate):
                        if !duplicate {
                            haptic.selectionChanged()
                            haptic.prepare()
                        }
                        let progress = expected.map { "\(min(received, $0))/\($0)" } ?? "\(received)"
                        onProgress(duplicate
                            ? "Frame already captured · \(progress)"
                            : "Captured frame \(progress) · Keep scanning")
                        return
                    case .complete(let token):
                        deliver(token, with: dataScanner)
                        return
                    case .invalid(let message):
                        onError(message)
                        return
                    case .notAnimated:
                        break
                    }
                }

                deliver(normalized, with: dataScanner)
                return
            }
            if sawBarcode {
                onError(invalidCodeMessage)
            }
        }

        private func deliver(_ value: String, with dataScanner: DataScannerViewController) {
            deliveredCode = true
            dataScanner.stopScanning()
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onCode(value)
        }
    }
}

/// Picks a Nostr contact to pay. Shared by both send sheets so the two payment rails present the
/// same contact list, which is the point of the PWA's Contacts button: who you're paying is one
/// decision, and how the money travels is another.
struct WalletContactPickerSheet: View {
    let title: String
    /// Contacts that can't be paid on this rail are still listed but not selectable, so someone
    /// looking for a name finds it and learns why rather than wondering where it went.
    let isSelectable: (NostrContact) -> Bool
    let unavailableNote: String
    let onSelect: (NostrContact) -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""

    private var contacts: [NostrContact] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let all = model.nostrContacts.sorted {
            $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }
        guard !query.isEmpty else { return all }
        return all.filter {
            $0.displayName.lowercased().contains(query)
                || $0.subtitle.lowercased().contains(query)
                || $0.npub.lowercased().contains(query)
        }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                TaskifyTheme.background.ignoresSafeArea()
                Group {
                    if model.nostrContacts.isEmpty {
                        VStack(spacing: 10) {
                            Image(systemName: "person.crop.circle.badge.questionmark")
                                .font(.system(size: 42))
                                .foregroundStyle(TaskifyTheme.tertiaryText)
                            Text("No contacts yet")
                                .font(.headline)
                                .foregroundStyle(TaskifyTheme.primaryText)
                            Text("Add someone in the Chat tab and they'll show up here.")
                                .font(.subheadline)
                                .multilineTextAlignment(.center)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                        }
                        .padding(32)
                    } else {
                        ScrollView {
                            VStack(spacing: 10) {
                                ForEach(contacts) { contact in
                                    row(contact)
                                }
                            }
                            .padding(20)
                        }
                    }
                }
            }
            .searchable(text: $search, prompt: "Search contacts")
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private func row(_ contact: NostrContact) -> some View {
        let selectable = isSelectable(contact)
        return Button {
            onSelect(contact)
            dismiss()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "person.crop.circle.fill")
                    .font(.title2)
                    .foregroundStyle(TaskifyTheme.accent)
                VStack(alignment: .leading, spacing: 3) {
                    Text(contact.displayName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                    Text(selectable ? contact.subtitle : unavailableNote)
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                if selectable {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .taskifyGlass(cornerRadius: 20)
        }
        .buttonStyle(.plain)
        .disabled(!selectable)
        .opacity(selectable ? 1 : 0.45)
    }
}

#endif
