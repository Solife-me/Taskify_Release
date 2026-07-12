//
//  PWAWebView.swift
//
//  WKWebView that loads the deployed PWA URL and bridges secure
//  operations to TaskifyCore (Keychain key storage, crypto, relay).
//

import SwiftUI
import WebKit
import TaskifyCore

// MARK: - PWAWebView

#if os(iOS)
private typealias PlatformWebViewRepresentable = UIViewRepresentable
#else
private typealias PlatformWebViewRepresentable = NSViewRepresentable
#endif

struct PWAWebView: PlatformWebViewRepresentable {
    let url: URL
    @StateObject private var bridge = NativeScriptBridge()

    private func makeWebView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.userContentController.add(bridge, name: "TaskifyNativeBridge")
        #if os(iOS)
        config.allowsInlineMediaPlayback = true
        #endif

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        #if os(iOS)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #else
        webView.wantsLayer = true
        webView.layer?.backgroundColor = NSColor.black.cgColor
        #endif

        webView.load(URLRequest(url: url, cachePolicy: .useProtocolCachePolicy))
        return webView
    }

    #if os(iOS)
    func makeUIView(context: Context) -> WKWebView { makeWebView(context: context) }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if webView.url?.absoluteString != url.absoluteString {
            webView.load(URLRequest(url: url, cachePolicy: .useProtocolCachePolicy))
        }
    }
    #else
    func makeNSView(context: Context) -> WKWebView { makeWebView(context: context) }

    func updateNSView(_ webView: WKWebView, context: Context) {
        if webView.url?.absoluteString != url.absoluteString {
            webView.load(URLRequest(url: url, cachePolicy: .useProtocolCachePolicy))
        }
    }
    #endif

    func makeCoordinator() -> Coordinator { Coordinator() }

    // MARK: - Coordinator

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
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
        func webView(_ webView: WKWebView,
                     requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo,
                     type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            if origin.host.contains("taskify.solife.me") {
                decisionHandler(.grant)
            } else {
                decisionHandler(.deny)
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            showError(in: webView, error: error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                     withError error: Error) {
            showError(in: webView, error: error)
        }

        private func showError(in webView: WKWebView, error: Error) {
            let e = error as NSError
            guard !(e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled) else { return }
            webView.loadHTMLString("""
            <html>
              <head>
                <meta name='viewport' content='width=device-width,initial-scale=1'/>
              </head>
              <body style='font-family:-apple-system;padding:24px;background:#0b1424;color:#fff;'>
                <h2 style='margin:0 0 12px 0;'>Unable to load Taskify</h2>
                <p style='opacity:.85;line-height:1.4;'>The configured PWA URL could not be reached.</p>
                <p style='opacity:.7;line-height:1.4;word-break:break-word;'>
                  <strong>Error:</strong> \(e.localizedDescription)
                </p>
              </body>
            </html>
            """, baseURL: nil)
        }
    }
}

// MARK: - NativeBridge (WKScriptMessageHandler)

final class NativeScriptBridge: NSObject, ObservableObject, WKScriptMessageHandler {
    let secureStorage = SecureStorage()

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let payload = message.body as? [String: Any],
              let action = payload["action"] as? String else { return }

        switch action {
        // MARK: Key management

        case "getStoreKey":
            if let key = try? secureStorage.retrieveKey(.device) {
                sendResponse(["type": "keyResponse", "action": "getStoreKey", "key": key])
            } else {
                sendError("No secure key found")
            }

        // MARK: P2PK crypto

        case "decryptMessage":
            let encrypted = payload["message"] as? [String: Any]
            guard let enc = encrypted else { sendError("Missing message"); return }
            sendResponse(["type": "cryptoResponse", "action": "decrypt", "payload": enc])

        case "encryptMessage":
            let plaintext = payload["message"] as? [String: Any]
            guard let pt = plaintext else { sendError("Missing message"); return }
            sendResponse(["type": "cryptoResponse", "action": "encrypt", "payload": pt])

        // MARK: Relay operations

        case "publish":
            let event = payload["event"] as? [String: Any]
            guard let evt = event else { sendError("Missing event"); return }
            // Wire this to a NostrEvent model when native publishing is enabled.
            sendResponse(["type": "relaysUpdated", "count": evt["kind"] as? Int ?? 0])

        case "relays":
            let relays = payload["relays"] as? [String] ?? []
            Task {
                for url in relays {
                    if let rURL = URL(string: url) {
                        await RelayPool.addRelay(rURL)
                    }
                }
                await MainActor.run {
                    sendResponse(["type": "relaysUpdated", "count": relays.count])
                }
            }

        // MARK: Identity

        case "identity":
            let nsec = payload["nsec"] as? String
            guard let nsecStr = nsec, Data(base64Encoded: nsecStr) != nil else {
                sendError("Invalid nsec"); return
            }
            // TODO: Create identity for UI
            sendResponse(["type": "identityReceived", "npub": "base64npub"])

        default:
            print("[NativeBridge] Unhandled action: \(action)")
        }
    }

    // MARK: Response helpers

    private func sendResponse(_ object: [String: Any]) {
        Task { @MainActor in
            guard let data = try? JSONSerialization.data(withJSONObject: object),
                  let json = String(data: data, encoding: .utf8) else { return }
            print("[NativeBridge] Sending: \(json)")
        }
    }

    private func sendError(_ message: String) {
        sendResponse(["type": "error", "message": message])
    }
}
