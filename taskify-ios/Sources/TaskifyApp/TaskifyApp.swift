//
//  TaskifyApp.swift
//
//  @main entry point for the WKWebView shell.
//  Imports TaskifyCore for native secure key handling, storage,
//  crypto, cache, and relay operations.
//

import SwiftUI

// MARK: - Config

private enum TaskAppConfig {
    // The deployed PWA URL to use as the web view source.
    static let appURLString: String = "https://taskify.solife.me"
}

// MARK: - App

@main
struct TaskifyApp: App {
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
        }
    }
}
