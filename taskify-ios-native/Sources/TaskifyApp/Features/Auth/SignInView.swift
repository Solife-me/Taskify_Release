import SwiftUI
import TaskifyCore

struct SignInView: View {
    @EnvironmentObject private var authVM: AppAuthViewModel
    let errorMessage: String?

    var body: some View {
        let signInVM = authVM.signInViewModel

        ZStack {
            LinearGradient(
                colors: [
                    ThemeColors.surfaceGrouped,
                    ThemeColors.surfaceRaised,
                    ThemeColors.surfaceBase,
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            VStack(spacing: 20) {
                VStack(spacing: 8) {
                    Text("Sign in to Taskify")
                        .font(.system(size: 28, weight: .bold, design: .rounded))
                    Text("Use the same nsec private key as the Taskify PWA.")
                        .font(.subheadline)
                        .foregroundStyle(ThemeColors.textSecondary)
                }

                VStack(alignment: .leading, spacing: 14) {
                    Text("Nostr Private Key")
                        .font(.headline)

                    TextField(
                        "nsec1... or 64-character key",
                        text: Binding(
                            get: { signInVM.secretKeyInput },
                            set: { signInVM.secretKeyInput = $0 }
                        )
                    )
                    .textFieldStyle(.plain)
                    .platformNoAutoCaps()
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
                    .background(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(ThemeColors.surfaceRaised)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .stroke(ThemeColors.surfaceBorder.opacity(0.35), lineWidth: 1)
                    )

                    HStack(spacing: 12) {
                        Button("Paste Key") {
                            guard let value = PlatformServices.readPasteboardString() else { return }
                            signInVM.secretKeyInput = value
                        }
                        .buttonStyle(.bordered)

                        Button(signInVM.isSubmitting ? "Signing in..." : "Continue") {
                            _ = signInVM.submit()
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(!signInVM.canSubmit)
                    }

                    if let message = signInVM.errorMessage, !message.isEmpty {
                        Text(message)
                            .font(.footnote)
                            .foregroundStyle(ThemeColors.danger)
                    }
                }
                .padding(22)
                .frame(maxWidth: 520)
                .background(
                    RoundedRectangle(cornerRadius: 28, style: .continuous)
                        .fill(ThemeColors.surfaceBase)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 28, style: .continuous)
                        .stroke(ThemeColors.surfaceBorder.opacity(0.28), lineWidth: 1)
                )
                .shadow(color: Color.black.opacity(0.08), radius: 24, y: 12)
            }
            .padding(24)
        }
        .onAppear { signInVM.applyExternalError(errorMessage) }
        .onChange(of: errorMessage) { _, newValue in
            signInVM.applyExternalError(newValue)
        }
    }
}
