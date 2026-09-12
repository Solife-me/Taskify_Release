import CoreImage.CIFilterBuiltins
import PhotosUI
import SwiftUI
import TaskifyCore
import UIKit
import VisionKit

// Profile ("My Card") and contact-QR affordances for the contacts directory, ported from the
// PWA's contacts sheet (`taskify-pwa/src/ui/wallet/WalletContactsSheet.tsx`): a profile detail
// card with your npub QR, an editor that publishes NIP-01 kind:0, and camera scanning.

struct ContactQRCodeView: View {
    let value: String

    private static let context = CIContext()

    var body: some View {
        if let image = Self.image(for: value) {
            Image(decorative: image, scale: 1)
                .interpolation(.none)
                .resizable()
                .accessibilityLabel("QR code")
        } else {
            Image(systemName: "qrcode")
                .resizable()
                .scaledToFit()
                .foregroundStyle(TaskifyTheme.primaryText)
                .padding(30)
        }
    }

    private static func image(for value: String) -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(value.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)) else {
            return nil
        }
        return context.createCGImage(output, from: output.extent)
    }
}

/// QR-first profile card with copyable identity fields and direct contact sharing.
struct NostrProfileDetailView: View {
    @Environment(AppModel.self) private var model
    @State private var showingEditor = false
    @State private var showingSharePicker = false
    @State private var feedback: String?

    private var contact: NostrContact? { model.ownContactRepresentation }

    var body: some View {
        ScrollView {
            if let contact {
                VStack(spacing: 12) {
                    VStack(spacing: 0) {
                        Button {
                            copy(contact.npub, label: "Nostr pubkey")
                        } label: {
                            ContactQRCodeView(value: contact.npub)
                                .aspectRatio(1, contentMode: .fit)
                                .padding(16)
                                .background(Color.white)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Copy Nostr pubkey from QR code")
                        .padding(16)

                        HStack(spacing: 14) {
                            NostrContactAvatar(contact: contact, size: 72)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(contact.displayName)
                                    .font(.title2.bold())
                                    .foregroundStyle(TaskifyTheme.primaryText)
                                Text(profileSubtitle(contact))
                                    .font(.subheadline)
                                    .foregroundStyle(TaskifyTheme.secondaryText)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            Button {
                                showingSharePicker = true
                            } label: {
                                Image(systemName: "square.and.arrow.up")
                                    .frame(width: 44, height: 44)
                                    .taskifyGlass(cornerRadius: 22)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Send my contact card to a contact")
                        }
                        .padding(.horizontal, 18)
                        .padding(.bottom, 22)
                    }
                    .taskifyGlass(cornerRadius: 28)

                    if let lightning = contact.profile?.lud16, !lightning.isEmpty {
                        copyField("Lightning", value: lightning)
                    }
                    copyField("Nostr pubkey", value: contact.npub)
                    if let nip05 = contact.profile?.nip05, !nip05.isEmpty {
                        copyField("NIP-05", value: nip05)
                    }
                    if let about = contact.profile?.about, !about.isEmpty {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("ABOUT").font(.caption).foregroundStyle(TaskifyTheme.secondaryText)
                            Text(about).font(.subheadline).textSelection(.enabled)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(18)
                        .taskifyGlass(cornerRadius: 20)
                    }
                }
                .padding(18)
            } else {
                ContentUnavailableView(
                    "Profile unavailable",
                    systemImage: "person.crop.circle.badge.exclamationmark",
                    description: Text("Your Nostr identity is not available.")
                )
                .padding(.top, 80)
            }
        }
        .background(TaskifyTheme.background.ignoresSafeArea())
        .navigationTitle("My Card")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showingEditor = true } label: {
                    Image(systemName: "pencil")
                        .frame(width: 44, height: 44)
                        .foregroundStyle(.white)
                        .background(TaskifyTheme.accent, in: Circle())
                }
                .accessibilityLabel("Edit My Card")
                .disabled(contact == nil)
            }
        }
        .onAppear { model.loadOwnProfileIfNeeded() }
        .sheet(isPresented: $showingEditor) {
            NostrProfileEditorSheet().environment(model)
        }
        .sheet(isPresented: $showingSharePicker) {
            MyCardRecipientSheet { recipient in
                feedback = "Contact card sent to \(recipient.displayName)"
            }
            .environment(model)
        }
        .overlay(alignment: .bottom) {
            if let feedback {
                Text(feedback)
                    .font(.subheadline)
                    .padding(12)
                    .background(.regularMaterial, in: Capsule())
                    .padding()
                    .allowsHitTesting(false)
            }
        }
        .task(id: feedback) {
            guard feedback != nil else { return }
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
            feedback = nil
        }
    }

    private func profileSubtitle(_ contact: NostrContact) -> String {
        if let username = contact.profile?.username ?? contact.profile?.name, !username.isEmpty {
            return "@" + username.trimmingCharacters(in: CharacterSet(charactersIn: "@"))
        }
        return contact.subtitle
    }

    private func copyField(_ label: String, value: String) -> some View {
        Button { copy(value, label: label) } label: {
            VStack(alignment: .leading, spacing: 5) {
                Text(label.uppercased())
                    .font(.caption)
                    .tracking(1)
                    .foregroundStyle(TaskifyTheme.secondaryText)
                Text(value)
                    .font(.body)
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
            .taskifyGlass(cornerRadius: 20)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Copy \(label): \(value)")
    }

    private func copy(_ value: String, label: String) {
        UIPasteboard.general.string = value
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        feedback = "\(label) copied"
        UIAccessibility.post(notification: .announcement, argument: feedback)
    }
}

private struct MyCardRecipientSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var searchText = ""
    @State private var sendingID: String?
    @State private var errorMessage: String?
    let onSent: (NostrContact) -> Void

    private var recipients: [NostrContact] {
        model.nostrContacts.filter { $0.publicKey != model.identityPublicKey }
    }

    private var filteredRecipients: [NostrContact] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return recipients.filter {
            query.isEmpty || $0.displayName.localizedCaseInsensitiveContains(query) ||
                $0.subtitle.localizedCaseInsensitiveContains(query) ||
                $0.npub.localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        NavigationStack {
            List(filteredRecipients) { recipient in
                Button {
                    guard sendingID == nil else { return }
                    sendingID = recipient.id
                    Task { await send(to: recipient) }
                } label: {
                    HStack(spacing: 12) {
                        NostrContactAvatar(contact: recipient, size: 42)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(recipient.displayName).foregroundStyle(TaskifyTheme.primaryText)
                            Text(recipient.subtitle).font(.caption).foregroundStyle(TaskifyTheme.secondaryText)
                        }
                        Spacer()
                        if sendingID == recipient.id {
                            ProgressView()
                        } else {
                            Image(systemName: "paperplane").foregroundStyle(TaskifyTheme.accent)
                        }
                    }
                    .padding(.vertical, 4)
                }
                .disabled(sendingID != nil)
                .listRowBackground(Color.clear)
                .accessibilityLabel("Send my card to \(recipient.displayName)")
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(TaskifyTheme.background)
            .overlay {
                if recipients.isEmpty {
                    ContentUnavailableView("No Contacts", systemImage: "person.crop.circle.badge.plus",
                                           description: Text("Add or sync contacts to send your card."))
                } else if filteredRecipients.isEmpty {
                    ContentUnavailableView.search(text: searchText)
                }
            }
            .navigationTitle("Send My Card")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $searchText, prompt: "Search contacts")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(sendingID != nil)
                }
            }
            .alert("Couldn’t Send Card", isPresented: Binding(
                get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } }
            )) {
                Button("OK", role: .cancel) { errorMessage = nil }
            } message: {
                Text(errorMessage ?? "Please try again.")
            }
        }
        .interactiveDismissDisabled(sendingID != nil)
        .preferredColorScheme(.dark)
        .tint(TaskifyTheme.accent)
    }

    @MainActor
    private func send(to recipient: NostrContact) async {
        defer { sendingID = nil }
        do {
            try await model.sendSharedContact(contactPublicKey: model.identityPublicKey, to: recipient.publicKey)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onSent(recipient)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }
}

/// "Edit My Card" editor. Publishes a NIP-01 kind:0 profile on save; a chosen photo is
/// downscaled to the PWA's limits (400px, ≤512 KB JPEG) and uploaded to the configured file
/// server so the published picture is a hosted URL.
struct NostrProfileEditorSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var username = ""
    @State private var displayName = ""
    @State private var lud16 = ""
    @State private var nip05 = ""
    @State private var about = ""
    @State private var pictureURL: String?
    @State private var pendingPhotoItem: PhotosPickerItem?
    @State private var pendingPhotoImage: UIImage?
    @State private var isSaving = false
    @State private var statusMessage: String?
    @State private var errorMessage: String?
    @State private var didLoadDraft = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Photo") {
                    HStack(spacing: 16) {
                        profilePhotoPreview
                        VStack(alignment: .leading, spacing: 8) {
                            PhotosPicker(selection: $pendingPhotoItem, matching: .images) {
                                Label(pictureURL == nil && pendingPhotoImage == nil ? "Choose Photo" : "Replace Photo", systemImage: "photo")
                            }
                            if pictureURL != nil || pendingPhotoImage != nil {
                                Button(role: .destructive) {
                                    pendingPhotoItem = nil
                                    pendingPhotoImage = nil
                                    pictureURL = nil
                                } label: {
                                    Label("Remove Photo", systemImage: "trash")
                                }
                            }
                        }
                    }
                }

                Section("Profile") {
                    TextField("Display name", text: $displayName)
                    TextField("Username", text: $username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Lightning address (optional)", text: $lud16)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.emailAddress)
                    TextField("NIP-05 address (optional)", text: $nip05)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.emailAddress)
                    TextField("About (optional)", text: $about, axis: .vertical)
                        .lineLimit(3...6)
                }

                Section {
                    LabeledContent("Your npub") {
                        Text(model.identityNpub)
                            .font(.system(.caption, design: .monospaced))
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .foregroundStyle(TaskifyTheme.secondaryText)
                    }
                    Text("Publishing signs a public profile event that other Nostr apps can read, and removes the previous version.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if let statusMessage {
                    Section {
                        Label(statusMessage, systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    }
                }
                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                }
            }
            .disabled(!didLoadDraft || isSaving)
            .overlay {
                if !didLoadDraft { ProgressView("Loading profile…") }
            }
            .navigationTitle("Edit My Card")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await save() }
                    } label: {
                        if isSaving { ProgressView() } else { Text("Save & Publish") }
                    }
                    .disabled(isSaving || !didLoadDraft)
                }
            }
            .task {
                guard !didLoadDraft else { return }
                await model.loadOwnProfile()
                guard !Task.isCancelled else { return }
                let draft = NostrProfileDraft(profile: model.ownProfile)
                username = draft.username ?? ""
                displayName = draft.displayName ?? ""
                lud16 = draft.lud16 ?? ""
                nip05 = draft.nip05 ?? ""
                about = draft.about ?? ""
                pictureURL = draft.picture
                didLoadDraft = true
            }
            .onChange(of: pendingPhotoItem) { _, item in
                guard let item else { return }
                Task { await loadPendingPhoto(item) }
            }
        }
        .preferredColorScheme(.dark)
        .tint(TaskifyTheme.accent)
        .interactiveDismissDisabled(isSaving)
    }

    @ViewBuilder
    private var profilePhotoPreview: some View {
        if let pendingPhotoImage {
            Image(uiImage: pendingPhotoImage)
                .resizable()
                .scaledToFill()
                .frame(width: 72, height: 72)
                .clipShape(Circle())
                .overlay(Circle().stroke(TaskifyTheme.border, lineWidth: 1))
        } else if let contact = model.ownContactRepresentation, pictureURL != nil {
            NostrContactAvatar(contact: contact, size: 72)
        } else {
            ZStack {
                Circle().fill(TaskifyTheme.accent.opacity(0.22))
                Image(systemName: "person.crop.circle")
                    .font(.system(size: 30))
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }
            .frame(width: 72, height: 72)
        }
    }

    private func loadPendingPhoto(_ item: PhotosPickerItem) async {
        errorMessage = nil
        guard let data = try? await item.loadTransferable(type: Data.self),
              let image = UIImage(data: data) else {
            errorMessage = "That photo could not be loaded."
            return
        }
        guard pendingPhotoItem == item else { return }
        pendingPhotoImage = image
    }

    @MainActor
    private func save() async {
        guard !isSaving else { return }
        isSaving = true
        errorMessage = nil
        statusMessage = nil
        defer { isSaving = false }

        do {
            var picture = pictureURL
            if let image = pendingPhotoImage {
                statusMessage = "Uploading photo…"
                let data = try processedProfilePhotoData(from: image)
                let filename = "profile-\(Int(Date().timeIntervalSince1970)).jpg"
                picture = try await model.uploadProfilePicture(data, filename: filename)
                pictureURL = picture
            }
            statusMessage = "Publishing profile…"
            let draft = NostrProfileDraft(
                username: username,
                displayName: displayName,
                about: about,
                picture: picture,
                lud16: lud16,
                nip05: nip05
            )
            try await model.publishOwnProfile(draft)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    /// Matches the PWA's `processProfilePhotoFile`: longest edge ≤400px, JPEG recompressed until
    /// it fits in 512 KB so the profile event stays small.
    private func processedProfilePhotoData(from image: UIImage) throws -> Data {
        let maximumEdge: CGFloat = 400
        var resized = image
        let longestEdge = max(image.size.width, image.size.height)
        if longestEdge > maximumEdge {
            let scale = maximumEdge / longestEdge
            let newSize = CGSize(width: image.size.width * scale, height: image.size.height * scale)
            let renderer = UIGraphicsImageRenderer(size: newSize)
            resized = renderer.image { _ in
                image.draw(in: CGRect(origin: .zero, size: newSize))
            }
        }
        var quality: CGFloat = 0.85
        while quality >= 0.4 {
            if let data = resized.jpegData(compressionQuality: quality), data.count <= 512 * 1024 {
                return data
            }
            quality -= 0.15
        }
        guard let fallback = resized.jpegData(compressionQuality: 0.4) else {
            throw ProfilePictureUploadError.invalidServer
        }
        return fallback
    }
}

/// Camera scanner for contact payloads, following the board scanner pattern
/// (`TaskifyBoardCodeScanner` in SettingsView.swift).
struct ContactCodeScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onError: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onCode: onCode, onError: onError)
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
        let onCode: (String) -> Void
        let onError: (String) -> Void
        weak var scanner: DataScannerViewController?

        init(onCode: @escaping (String) -> Void, onError: @escaping (String) -> Void) {
            self.onCode = onCode
            self.onError = onError
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            for item in addedItems {
                guard case let .barcode(barcode) = item,
                      let value = barcode.payloadStringValue else {
                    continue
                }
                onCode(value)
                return
            }
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable
        ) {
            onError("Camera scanning became unavailable. You can still paste the npub manually.")
        }
    }
}

/// Full-screen camera sheet for scanning contact QRs. `onCode` returns `nil` when the code was
/// accepted (the sheet then closes) or an error message to show over the live camera.
struct ContactScannerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var errorMessage: String?
    let onCode: (String) -> String?

    var body: some View {
        ZStack {
            ContactCodeScanner(
                onCode: { code in
                    if let message = onCode(code) {
                        errorMessage = message
                    } else {
                        dismiss()
                    }
                },
                onError: { message in
                    errorMessage = message
                }
            )
            VStack {
                HStack {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.title2)
                            .foregroundStyle(.white)
                            .shadow(radius: 2)
                    }
                    .accessibilityLabel("Close scanner")
                    Spacer()
                }
                .padding(20)
                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(Color.black.opacity(0.75), in: Capsule())
                        .padding(.bottom, 30)
                }
                Spacer()
            }
        }
        .background(Color.black)
    }
}