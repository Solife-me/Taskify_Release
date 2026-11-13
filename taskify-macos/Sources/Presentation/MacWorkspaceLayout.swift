import Foundation

/// Shared width policy for the Mac workspace. A pane in Taskify Split View is a complete
/// destination, so it must be able to become compact independently of the app window.
enum MacWorkspaceLayout {
    enum PanePresentation: Equatable {
        case compact
        case regular
    }

    /// Keeps two destinations usable inside the app's 850-point minimum window width.
    static let minimumPaneWidth: CGFloat = 300
    static let idealPaneWidth: CGFloat = 560
    static let inspectorMinimumWidth: CGFloat = 240

    /// Below this width, fixed secondary columns are replaced by compact navigation.
    static let regularPaneBreakpoint: CGFloat = 640

    static func panePresentation(for width: CGFloat) -> PanePresentation {
        width >= regularPaneBreakpoint ? .regular : .compact
    }
}
