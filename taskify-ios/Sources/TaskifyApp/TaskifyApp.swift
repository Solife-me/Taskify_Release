//
//  TaskifyApp.swift
//
//  @main entry point for the WKWebView shell.
//  Imports TaskifyCore for native secure key handling, storage,
//  crypto, cache, and relay operations.
//

import SwiftUI
import WebKit
import TaskifyCore

// MARK: - Config

private enum TaskAppConfig {
    // The deployed PWA URL to use as the web view source.
    static let appURLString: String = "https://taskify.solife.me"
}

// MARK: - App

@main
struct TaskifyApp: App {
    @StateObject private var bridge = NativeBridge()

    var body: some Scene {
        WindowGroup {
            Group {
                if let url = URL(string: TaskAppConfig.appURLString) {
                    PWAWebView(url: url)
                } else {
                    VStack(spacing: 16) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.largeTitle)
                            .foregroundStyle(.red)
                        Text("Invalid PWA URL")
                        Text(TaskAppConfig.appURLString)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .onAppear {
                Task { await bridge.bootstrap() }
            }
        }
    }
}

// MARK: - NativeBridge (bridge to TaskifyCore services)

@MainActor
final class NativeBridge: ObservableObject {
    @Published var secureStorage: SecureStorage = .default

    /// Bootstrap any background services (e.g., relay pool warm-up, profile load).
    func bootstrap() async {
        // Seed the relay pool with default relays so it's ready when the PWA loads.
        for url in RelayPool.defaultRelays {
            await RelayPool.addRelay(url)
        }
        // No-op for now — the app is purely a WKWebView shell; identity operations
        // flow through the crypto layer when the user signs in via the PWA.
    }
}
