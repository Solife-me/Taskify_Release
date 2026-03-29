import SwiftUI

enum TaskifyFontScaling {
    static func dynamicTypeSize(for baseFontSize: Double?) -> DynamicTypeSize? {
        guard let baseFontSize else { return nil }

        switch baseFontSize {
        case ..<15:
            return .small
        case ..<18:
            return .medium
        case ..<21:
            return .xLarge
        default:
            return .xxLarge
        }
    }
}

extension View {
    @ViewBuilder
    func taskifyBaseFontSize(_ baseFontSize: Double?) -> some View {
        if let dynamicTypeSize = TaskifyFontScaling.dynamicTypeSize(for: baseFontSize) {
            self.dynamicTypeSize(dynamicTypeSize)
        } else {
            self
        }
    }
}
