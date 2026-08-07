import SwiftUI

struct MigrationPlaceholderView: View {
    let title: String
    let icon: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.system(size: 22, weight: .bold))
                .padding(.horizontal, 18)
                .padding(.top, 14)

            Spacer()

            VStack(spacing: 16) {
                Image(systemName: icon)
                    .font(.system(size: 42, weight: .medium))
                    .foregroundStyle(TaskifyTheme.accent)
                Text("Native migration in progress")
                    .font(.title3.bold())
                Text(detail)
                    .font(.body)
                    .foregroundStyle(TaskifyTheme.secondaryText)
                    .multilineTextAlignment(.center)
            }
            .padding(28)
            .taskifyGlass(cornerRadius: 26)
            .padding(.horizontal, 22)

            Spacer()
        }
        .foregroundStyle(TaskifyTheme.primaryText)
    }
}
