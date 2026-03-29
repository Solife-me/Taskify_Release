import SwiftUI
import WebKit
import TaskifyCore

// MARK: - App

@main
struct TaskifyApp: App {
    @StateObject private var authVM = AppAuthViewModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(authVM)
                .task { await authVM.bootstrap() }
        }
    }
}

private struct RootView: View {
    @EnvironmentObject private var authVM: AppAuthViewModel

    var body: some View {
        switch authVM.state {
        case .signedIn(let profile):
            NativeAppShellView(profile: profile)
        case .importing:
            ProgressView("Signing in…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black.opacity(0.02))
        case .error(let message):
            SignInView(errorMessage: message)
        case .signedOut:
            SignInView(errorMessage: nil)
        }
    }
}

private struct NativeAppShellView: View {
    @StateObject private var shellVM: AppShellViewModel

    init(profile: TaskifyProfile) {
        _shellVM = StateObject(wrappedValue: AppShellViewModel(profile: profile))
    }

    var body: some View {
        TabView(selection: Binding(
            get: { shellVM.selectedTab },
            set: { shellVM.select(tab: $0) }
        )) {
            BoardsShellScreen(shellVM: shellVM)
                .tabItem { Label("Boards", systemImage: "square.grid.2x2") }
                .tag(AppShellViewModel.Tab.boards)

            UpcomingShellScreen()
                .tabItem { Label("Upcoming", systemImage: "calendar") }
                .tag(AppShellViewModel.Tab.upcoming)

            SettingsShellScreen(profileName: shellVM.profile.name)
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(AppShellViewModel.Tab.settings)
        }
    }
}

private struct BoardsShellScreen: View {
    @ObservedObject var shellVM: AppShellViewModel
    @StateObject private var boardListVM = BoardListViewModel()
    @StateObject private var boardDetailVM = BoardDetailViewModel()
    @StateObject private var boardModeVM = BoardModeViewModel()

    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                switch boardListVM.state {
                case .loading:
                    ProgressView("Loading boards…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .empty:
                    VStack(spacing: 12) {
                        Image(systemName: "tray")
                            .font(.title2)
                            .foregroundStyle(.secondary)
                        Text(shellVM.boardsEmptyMessage)
                            .font(.subheadline)
                            .multilineTextAlignment(.center)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(24)
                case .error(let message):
                    VStack(spacing: 12) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.title2)
                            .foregroundStyle(.orange)
                        Text(message)
                            .font(.subheadline)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(24)
                case .ready:
                    Picker("Boards", selection: Binding(
                        get: { boardListVM.selectedBoardId ?? "" },
                        set: { boardListVM.selectBoard(id: $0) }
                    )) {
                        ForEach(boardListVM.visibleBoards, id: \.id) { board in
                            Text(board.name).tag(board.id)
                        }
                    }
                    .pickerStyle(.menu)

                    Picker("Board Mode", selection: Binding(
                        get: { boardModeVM.mode },
                        set: { boardModeVM.setMode($0) }
                    )) {
                        Text("Board").tag(BoardPageMode.board)
                        Text("Upcoming").tag(BoardPageMode.boardUpcoming)
                        Text("Completed").tag(BoardPageMode.completed)
                    }
                    .pickerStyle(.segmented)

                    BoardModePane(modeVM: boardModeVM, detailVM: boardDetailVM)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .navigationTitle("Boards")
            .onAppear {
                boardListVM.setBoards(shellVM.profile.boards)
                boardDetailVM.setSelectedBoard(id: boardListVM.selectedBoardId)
                seedBoardModeState()
            }
            .onChange(of: boardListVM.selectedBoardId) { _, newValue in
                boardDetailVM.setSelectedBoard(id: newValue)
                seedBoardModeState()
            }
        }
    }

    private func seedBoardModeState() {
        boardModeVM.setBoardItems(boardDetailVM.visibleTasks.map(\.id))
        boardModeVM.setUpcomingItems([])
        boardModeVM.setCompletedItems(boardDetailVM.visibleTasks.filter(\.completed).map(\.id))
    }
}

private struct BoardModePane: View {
    @ObservedObject var modeVM: BoardModeViewModel
    @ObservedObject var detailVM: BoardDetailViewModel

    var body: some View {
        Group {
            switch modeVM.currentState {
            case .loading(let text):
                ProgressView(text)
            case .error(let message):
                VStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.title2)
                        .foregroundStyle(.orange)
                    Text(message)
                        .font(.subheadline)
                }
            case .empty(let message):
                VStack(spacing: 10) {
                    Image(systemName: "checklist")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                    Text(message)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            case .ready:
                switch modeVM.mode {
                case .board:
                    BoardDetailPane(viewModel: detailVM)
                case .boardUpcoming:
                    Text("Board upcoming list scaffold")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                case .completed:
                    List(detailVM.visibleTasks.filter(\.completed)) { task in
                        HStack(spacing: 10) {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                            Text(task.title)
                            Spacer()
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct BoardDetailPane: View {
    @ObservedObject var viewModel: BoardDetailViewModel

    var body: some View {
        Group {
            switch viewModel.state {
            case .loading:
                ProgressView("Loading tasks…")
            case .empty:
                VStack(spacing: 10) {
                    Image(systemName: "checklist")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                    Text(viewModel.emptyMessage)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            case .error(let message):
                VStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.title2)
                        .foregroundStyle(.orange)
                    Text(message)
                        .font(.subheadline)
                }
            case .ready:
                List(viewModel.visibleTasks) { task in
                    HStack(spacing: 10) {
                        Image(systemName: task.completed ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(task.completed ? .green : .secondary)
                        Text(task.title)
                        Spacer()
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct UpcomingShellScreen: View {
    var body: some View {
        NavigationStack {
            VStack(spacing: 10) {
                Image(systemName: "calendar")
                    .font(.title2)
                    .foregroundStyle(.secondary)
                Text("Upcoming")
                    .font(.title3.bold())
                Text("Native upcoming scaffold — parity slices in progress.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(24)
            .navigationTitle("Upcoming")
        }
    }
}

private struct SettingsShellScreen: View {
    let profileName: String

    var body: some View {
        NavigationStack {
            VStack(spacing: 10) {
                Image(systemName: "gearshape")
                    .font(.title2)
                    .foregroundStyle(.secondary)
                Text("Signed in as \(profileName)")
                    .font(.title3.bold())
                Text("Native settings scaffold — parity slices in progress.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(24)
            .navigationTitle("Settings")
        }
    }
}

private struct SignInView: View {
    @EnvironmentObject private var authVM: AppAuthViewModel
    let errorMessage: String?

    var body: some View {
        let signInVM = authVM.signInViewModel
        VStack(spacing: 16) {
            Text("Taskify")
                .font(.largeTitle.bold())
            Text("Sign in with nsec or 64-hex private key")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            TextField("Profile name", text: Binding(
                get: { signInVM.profileName },
                set: { signInVM.profileName = $0 }
            ))
            .textFieldStyle(.roundedBorder)

            TextField("nsec1... or 64-hex", text: Binding(
                get: { signInVM.secretKeyInput },
                set: { signInVM.secretKeyInput = $0 }
            ))
            .textFieldStyle(.roundedBorder)

            if let msg = signInVM.errorMessage, !msg.isEmpty {
                Text(msg)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }

            Button("Sign In") {
                _ = signInVM.submit()
            }
            .buttonStyle(.borderedProminent)
            .disabled(!signInVM.canSubmit)
        }
        .onAppear { signInVM.applyExternalError(errorMessage) }
        .onChange(of: errorMessage) { _, newValue in signInVM.applyExternalError(newValue) }
        .padding(24)
        .frame(maxWidth: 460)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.opacity(0.02))
    }
}

@MainActor
private final class AppAuthViewModel: ObservableObject {
    @Published var state: AuthState = .signedOut

    private let manager = AuthSessionManager(
        loadActiveProfile: { try KeychainStore.loadActiveProfile() },
        saveProfile: { profile in try KeychainStore.saveProfile(profile) },
        importIdentity: { input in try NostrIdentityService.importIdentity(secretKeyInput: input) }
    )

    lazy var signInViewModel: SignInViewModel = {
        SignInViewModel { [weak self] secretKeyInput, profileName in
            guard let self else { return .error("Unable to sign in. Please check your private key.") }
            self.manager.signIn(secretKeyInput: secretKeyInput, profileName: profileName, relays: AuthSessionManager.defaultRelayPreset)
            self.state = self.manager.state
            return self.manager.state
        }
    }()

    func bootstrap() async {
        manager.bootstrap()
        state = manager.state
    }
}

// MARK: - WebView (iOS)

#if os(iOS)
struct TaskifyWebWrapperView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        makeWebView(context: context)
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }
}

// MARK: - WebView (macOS)

#elseif os(macOS)
import AppKit

struct TaskifyWebWrapperView: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> WKWebView {
        makeWebView(context: context)
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        guard webView.url?.absoluteString != url.absoluteString else { return }
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData))
    }

    func makeCoordinator() -> Coordinator { Coordinator() }
}
#endif

// MARK: - Shared setup

extension TaskifyWebWrapperView {
    fileprivate func makeWebView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        #if os(iOS)
        config.allowsInlineMediaPlayback = true
        #endif

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true

        #if os(iOS)
        webView.isOpaque = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        #endif

        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData))
        return webView
    }

    // MARK: - Coordinator

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            #if os(iOS)
            if let url = navigationAction.request.url, shouldOpenExternallyForOAuth(url: url) {
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
                decisionHandler(.cancel)
                return
            }
            #endif
            decisionHandler(.allow)
        }

        #if os(iOS)
        private func shouldOpenExternallyForOAuth(url: URL) -> Bool {
            guard let host = url.host?.lowercased() else { return false }
            let path = url.path.lowercased()
            if host == "accounts.google.com" && path.contains("/oauth") { return true }
            if host == "accounts.google.com" && path.contains("/o/oauth2") { return true }
            if host == "oauth2.googleapis.com" { return true }
            return false
        }
        #endif

        @available(iOS 15.0, *)
        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            // For our first-party Taskify web app, grant capture so iOS can present/resolve mic permission.
            // Do not grant for arbitrary origins.
            if origin.host.contains("taskify.solife.me") {
                decisionHandler(.grant)
            } else {
                decisionHandler(.deny)
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            showError(in: webView, error: error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            showError(in: webView, error: error)
        }

        private func showError(in webView: WKWebView, error: Error) {
            let e = error as NSError
            guard !(e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled) else { return }
            webView.loadHTMLString("""
            <html><head><meta name='viewport' content='width=device-width,initial-scale=1'/></head>
            <body style='font-family:-apple-system;padding:24px;background:#0b1424;color:#fff;'>
              <h2 style='margin:0 0 12px 0;'>Unable to load Taskify</h2>
              <p style='opacity:.85;line-height:1.4;'>The configured web URL could not be reached.</p>
              <p style='opacity:.7;line-height:1.4;word-break:break-word;'><strong>Error:</strong> \(e.localizedDescription)</p>
            </body></html>
            """, baseURL: nil)
        }
    }
}
