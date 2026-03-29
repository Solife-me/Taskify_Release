import SwiftUI
import WebKit

#if os(iOS)
struct TaskifyWebWrapperView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        makeWebView(context: context)
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }
}

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

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(.allow)
        }

        @available(iOS 15.0, *)
        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
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
