# Taskify iOS to Web-Wrapped PWA Plan

> **For Hermes:** Execute task-by-task via subagent-driven-development skill.
> Each task is 2-5 minutes of focused work. Verify every step.

**Goal:** Convert `taskify-ios/` from a native SwiftUI app to a thin `WKWebView` shell that loads the deployed Taskify PWA, giving users the exact same experience as the installed web app.

**Architecture:** Delete all native Swift code/framework. Replace with a minimal iOS app that shows a full-screen `WKWebView` loading the PWA URL. All logic lives in the PWA (React + TypeScript), all data syncs through Nostr relays via the PWA's service worker.

**Key decisions:**
- WKWebView configured for PWA: service workers enabled, IndexedDB, localStorage, WebSQL, camera/mic permissions
- Full-screen mode — no browser chrome, safe areas handled via UIKit
- Minimum iOS 15.0 (modern WKWebView with full PWA support)
- App icon & usage descriptions preserved
- No native Swift dependencies (remove swift-secp256k1, etc.)

---

### Task 1: Confirm PWA deployment URL

**Objective:** Determine the exact URL the WKWebView should load.

**Steps:**

1. Search the codebase for PWA deployment URLs:
```bash
cd /home/user/taskify-release && grep -r "taskify.so\|solife.me/taskify\|APP_URL\|PWA_URL" --include="*.ts" --include="*.json" --include="*.md" --include="*.html" src/
```

2. Check `taskify-pwa/public/manifest.webmanifest` for the start_url.

3. Verify the deployed URL is accessible:
```bash
curl -sI https://taskify.so | head -5
```

**Files involved:**
- Read: `taskify-pwa/public/manifest.webmanifest`
- Search: entire `taskify-release/` directory for URLs

**Output:** A confirmed PWA URL string (e.g., `https://taskify.so`)

---

### Task 2: Delete all native Swift code

**Objective:** Remove the entire native SwiftUI codebase.

**Steps:**

Run these commands from `taskify-release/`:

```bash
cd /home/user/taskify-release

# Remove native Swift framework (TaskifyCore)
rm -rf taskify-ios/Sources/TaskifyCore

# Remove native SwiftUI app entry
rm -rf taskify-ios/Sources/TaskifyApp

# Remove Swift tests
rm -rf taskify-ios/Tests

# Remove SPM artifacts
rm -f taskify-ios/Package.swift
rm -f taskify-ios/Package.resolved
rm -rf taskify-ios/.swiftpm

# Remove Xcode project (will recreate)
rm -rf taskify-ios/TaskifyiOSApp.xcodeproj

# Remove native-only documentation
rm -f taskify-ios/README.md
rm -f taskify-ios/IOS_EXPANSION_ROADMAP.md
rm -f taskify-ios/TESTFLIGHT_SIRI_QA_CHECKLIST.md
rm -f taskify-ios/TESTFLIGHT_WHAT_TO_TEST_VOICE_QUICK_ADD.md

# Remove screenshot artifacts
rm -rf taskify-ios/.artifacts
```

**Files removed: ~90+ files**

**Verify no native files remain:**
```bash
find taskify-ios -name "*.swift" | wc -l  # should be 1 (the new file)
ls taskify-ios/  # should show: Sources/, Resources/, .artifacts/, .gitignore
```

---

### Task 3: Create new WKWebView app shell

**Objective:** Create the single-file WKWebView shell with proper PWA configuration.

**Create: `taskify-ios/Sources/TaskifyApp/TaskifyApp.swift`**

- Replace the `@main` struct with a simple `App` entry
- Add `WKWebView` that loads the confirmed PWA URL from `Info.plist`
- Configure `WKWebViewConfiguration` with:
  - JavaScript enabled
  - Full-screen inline media playback
  - Default `websiteDataStore` (preserves cookies, service workers, IndexedDB)
  - Safe area insets respected via UIKit

**Create: `taskify-ios/Sources/TaskifyApp/PwaWKWebView.swift`**

- Custom `UIViewRepresentable` wrapper for `WKWebView`
- `WKUIDelegate` to handle any native overlays (alerts, confirm, prompt)
- `WKNavigationDelegate` with:
  - `decidePolicyFor` to block non-taskify URLs (security)
  - Full-screen mode when loading taskify URLs
  - Handle URL schemes (nostr:, https:)
- WKWebView configuration methods:
  - User-Agent set to simulate iOS Safari (PWA detection & installability)
  - `mediaTypesRequiringUserActionForPlayback` = `.none` (autoplay media)
  - Inject JavaScript for secure fullscreen support
  - Configure for PWA install prompt appearance

**Create: `taskify-ios/Sources/TaskifyApp/MainView.swift`** (optional if 1-file works)

- Or inline into TaskifyApp.swift as a single file

---

### Task 4: Configure Xcode project

**Objective:** Recreate the Xcode project for a WKWebView-based app.

**Steps:**

1. Recreate `TaskifyiOSApp.xcodeproj/` with proper pbxproj:
   - Target: iOS 15.0 minimum
   - Bundle ID: `solife.me.Taskify`
   - Deployment team: `JUH98962T7`
   - Product type: application
   - Sources include new TaskifyApp.swift files
   - Resources include `Assets.xcassets` and `Info.plist`

2. Create/update `Info.plist` (via `XCBuildConfiguration` settings, not a separate file — the project is set to `GENERATE_INFOPLIST_FILE = YES`):
   - `NSCameraUsageDescription` — keep "Taskify needs camera access for capture features."
   - `NSMicrophoneUsageDescription` — keep "Taskify needs microphone access for voice dictation."
   - `NSSpeechRecognitionUsageDescription` — keep as-is
   - `NSPhotoLibraryAddUsageDescription` — PWA file save support
   - `PWA_URL` — the confirmed deployment URL from Task 1
   - `UIAppFonts` — not needed (no native fonts)

3. Verify project structure:
```bash
cd /home/user/teamify-release/taskify-ios && xed . # for manual Xcode verification
```

---

### Task 5: Update .gitignore

**Objective:** Update `.gitignore` for the new simple structure.

**Steps:**

1. Read current `.gitignore`
2. Remove iOS-specific ignores (Pods, DerivedData, etc.)
3. Keep `*.DS_Store`, `.artifacts/`, and any relevant patterns
4. Add any new patterns for WKWebView artifacts if relevant

---

### Task 6: Verify build compiles

**Objective:** Ensure the new Xcode project compiles without errors.

**Steps:**

```bash
cd /home/user/teamify-release/taskify-ios
swift build 2>&1  # if SPM setup still works
# OR verify via Xcode project file structure correctness
```

Since we can't run Xcode, verify:
1. The PBX proj has correct references to the new source files
2. Resources are linked properly
3. The Swift file is syntactically valid (run `swift -parse`)

---

### Task 7: Write README

**Objective:** Update the README to describe the new WKWebView architecture.

**Create: `taskify-ios/README.md`**

Document:
- New architecture (WKWebView shell, PWA-based)
- Deployment URL config
- How PWA installability works
- What was removed (native SwiftUI codebase)
- How to update the PWA URL (change `PWA_URL` in `Info.plist` or `XCBuildConfiguration`)
