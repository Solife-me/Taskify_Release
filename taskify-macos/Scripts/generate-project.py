#!/usr/bin/env python3
"""Generate or verify the native Mac project without third-party tooling."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SHARED_ROOT = ROOT.parent / "taskify-ios-native/Sources/TaskifyApp"
PROJECT = ROOT / "TaskifyMac.xcodeproj"
PROJECT_FILE = PROJECT / "project.pbxproj"
SCHEME_FILE = PROJECT / "xcshareddata/xcschemes/TaskifyMac.xcscheme"

# Mac sources are discovered automatically. Shared iOS-app sources are deliberately explicit:
# this is the reviewable boundary between the two app targets.
SHARED_SOURCES = (
    "App/AppModel.swift",
    "App/AppModelAppStateSync.swift",
    "App/AppModelDirectMessages.swift",
    "App/AppModelPerfProbe.swift",
    "App/AppModelSupport.swift",
    "App/FastingRemindersSettings.swift",
    "App/ScriptureMemorySettings.swift",
    "App/TaskStreakSettings.swift",
    "App/TaskOrderingSettings.swift",
    "App/TaskifyAddTaskIntent.swift",
    "App/TaskifyShortcuts.swift",
    "App/TaskifySpotlightIndexer.swift",
    "App/StartupViewSettings.swift",
    "App/OnboardingSettings.swift",
    "App/NpubCashSettings.swift",
    "DesignSystem/ScaledFont.swift",
    "Security/KeychainIdentityStore.swift",
    "Features/Wallet/WalletKeychainStores.swift",
    "Features/Wallet/WalletView.swift",
    "Features/Wallet/WalletRecoveryView.swift",
    "Features/Wallet/WalletViewModel+NWC.swift",
    "Features/Boards/BibleTrackerStore.swift",
    "Features/Upcoming/DeviceCalendarStore.swift",
    "Features/Tasks/TaskAttachmentUploadService.swift",
    "Features/Tasks/TaskNoteViews.swift",
    "Features/Tasks/TaskNoteRichText.swift",
    "Notifications/TaskNotificationCoordinator.swift",
    "Notifications/DMPushNotificationCoordinator.swift",
)
PACKAGE_PRODUCTS = ("TaskifyCore", "TaskifyWallet", "TaskifyWatchShared")
RESOURCES = (
    ("Taskify.icns", "image.icns"),
    ("PrivacyInfo.xcprivacy", "text.xml"),
    ("../taskify-ios-native/Sources/TaskifyApp/Resources/ThirdPartyNotices.txt", "text"),
)


def ident(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:24].upper()


def quote(value: object) -> str:
    return json.dumps(str(value))


def source_paths() -> list[Path]:
    shared_paths = [SHARED_ROOT / relative_path for relative_path in SHARED_SOURCES]
    missing = [path for path in shared_paths if not path.is_file()]
    if missing:
        formatted = "\n".join(f"  {path}" for path in missing)
        raise SystemExit(f"Shared Mac source manifest contains missing files:\n{formatted}")
    return sorted((ROOT / "Sources").rglob("*.swift")) + shared_paths


def ui_test_source_paths() -> list[Path]:
    return sorted((ROOT / "UITests").rglob("*.swift"))


def render_project() -> str:
    objects: list[str] = []

    def obj(key: str, value: str) -> str:
        object_id = ident(key)
        objects.append(f"{object_id} = {{ {value} }};")
        return object_id

    files: list[str] = []
    builds: list[str] = []
    for path in source_paths():
        relative_path = os.path.relpath(path, ROOT)
        files.append(
            obj(
                relative_path,
                "isa = PBXFileReference; lastKnownFileType = sourcecode.swift; "
                f"path = {quote(relative_path)}; sourceTree = SOURCE_ROOT;",
            )
        )
        builds.append(
            obj(
                relative_path + "build",
                f"isa = PBXBuildFile; fileRef = {ident(relative_path)};",
            )
        )

    product = obj(
        "product",
        "isa = PBXFileReference; explicitFileType = wrapper.application; "
        "path = Taskify.app; sourceTree = BUILT_PRODUCTS_DIR;",
    )
    ui_test_files: list[str] = []
    ui_test_builds: list[str] = []
    for path in ui_test_source_paths():
        relative_path = os.path.relpath(path, ROOT)
        ui_test_files.append(
            obj(
                relative_path,
                "isa = PBXFileReference; lastKnownFileType = sourcecode.swift; "
                f"path = {quote(relative_path)}; sourceTree = SOURCE_ROOT;",
            )
        )
        ui_test_builds.append(
            obj(
                relative_path + "build",
                f"isa = PBXBuildFile; fileRef = {ident(relative_path)};",
            )
        )
    ui_test_product = obj(
        "ui-test-product",
        "isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; "
        "path = TaskifyMacUITests.xctest; sourceTree = BUILT_PRODUCTS_DIR;",
    )
    resource_builds: list[str] = []
    for relative_path, file_type in RESOURCES:
        files.append(
            obj(
                relative_path,
                f"isa = PBXFileReference; lastKnownFileType = {file_type}; "
                f"path = {quote(relative_path)}; sourceTree = SOURCE_ROOT;",
            )
        )
        resource_builds.append(
            obj(
                relative_path + "build",
                f"isa = PBXBuildFile; fileRef = {ident(relative_path)};",
            )
        )

    obj(
        "group",
        f'isa = PBXGroup; children = ({",".join(files + ui_test_files + [product, ui_test_product])}); '
        'sourceTree = "<group>";',
    )
    obj(
        "sources",
        "isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; "
        f'files = ({",".join(builds)}); runOnlyForDeploymentPostprocessing = 0;',
    )
    obj(
        "ui-test-sources",
        "isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; "
        f'files = ({",".join(ui_test_builds)}); runOnlyForDeploymentPostprocessing = 0;',
    )
    obj(
        "ui-test-frameworks",
        "isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; "
        "files = (); runOnlyForDeploymentPostprocessing = 0;",
    )
    obj(
        "ui-test-resources",
        "isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; "
        "files = (); runOnlyForDeploymentPostprocessing = 0;",
    )
    package = obj(
        "package",
        'isa = XCLocalSwiftPackageReference; relativePath = "../taskify-ios-native";',
    )
    products: list[str] = []
    frameworks: list[str] = []
    for name in PACKAGE_PRODUCTS:
        products.append(
            obj(name, f"isa = XCSwiftPackageProductDependency; productName = {name};")
        )
        frameworks.append(
            obj(name + "link", f"isa = PBXBuildFile; productRef = {ident(name)};")
        )
    obj(
        "frameworks",
        "isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; "
        f'files = ({",".join(frameworks)}); runOnlyForDeploymentPostprocessing = 0;',
    )
    obj(
        "resources",
        "isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; "
        f'files = ({",".join(resource_builds)}); runOnlyForDeploymentPostprocessing = 0;',
    )

    for scope in ("project", "target"):
        configurations: list[str] = []
        for name in ("Debug", "Local", "UITest", "Release"):
            settings = {
                "SWIFT_VERSION": "5.0",
                "MACOSX_DEPLOYMENT_TARGET": "14.0",
                "SDKROOT": "macosx",
                "CLANG_ENABLE_MODULES": "YES",
                "ONLY_ACTIVE_ARCH": "YES" if name != "Release" else "NO",
            }
            if scope == "target":
                settings.update(
                    {
                        "TASKIFY_PRODUCT_NAME": "Taskify",
                        "PRODUCT_NAME": "$(TASKIFY_PRODUCT_NAME)",
                        "PRODUCT_BUNDLE_IDENTIFIER": "solife.me.Taskify.Mac",
                        "INFOPLIST_FILE": "Info.plist",
                        "CODE_SIGN_ENTITLEMENTS": "TaskifyMac.entitlements",
                        "CODE_SIGN_STYLE": "Automatic",
                        "ENABLE_HARDENED_RUNTIME": "YES",
                        "SUPPORTED_PLATFORMS": "macosx",
                        "SWIFT_EMIT_LOC_STRINGS": "YES",
                        "LD_RUNPATH_SEARCH_PATHS": "$(inherited) @executable_path/../Frameworks",
                        "COMBINE_HIDPI_IMAGES": "YES",
                    }
                )
                if name == "UITest":
                    settings.update(
                        {
                            "PRODUCT_BUNDLE_IDENTIFIER": "solife.me.Taskify.Mac.UITests",
                            "CODE_SIGN_ENTITLEMENTS": "TaskifyMacUITests.entitlements",
                        }
                    )
                else:
                    settings["APS_ENVIRONMENT"] = (
                        "production" if name == "Release" else "development"
                    )
            settings.update(
                {
                    "SWIFT_OPTIMIZATION_LEVEL": "-Onone" if name != "Release" else "-O",
                    "SWIFT_ACTIVE_COMPILATION_CONDITIONS": (
                        "DEBUG TASKIFY_MAC_UI_TEST TASKIFY_MAC_SHORTCUTS" if name == "UITest"
                        else "DEBUG" if name != "Release"
                        else ""
                    ),
                }
            )
            build_settings = " ".join(
                f"{key} = {quote(value)};" for key, value in settings.items()
            )
            configurations.append(
                obj(
                    scope + name,
                    f"isa = XCBuildConfiguration; buildSettings = {{{build_settings}}}; name = {name};",
                )
            )
        obj(
            scope + "configs",
            "isa = XCConfigurationList; "
            f'buildConfigurations = ({",".join(configurations)}); '
            "defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;",
        )

    ui_test_configurations: list[str] = []
    for name in ("Debug", "Local", "UITest", "Release"):
        settings = {
            "CLANG_ENABLE_OBJC_WEAK": "NO",
            "CODE_SIGN_STYLE": "Automatic",
            "GENERATE_INFOPLIST_FILE": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "14.0",
            "PRODUCT_BUNDLE_IDENTIFIER": "solife.me.Taskify.Mac.UITestsRunner",
            "PRODUCT_NAME": "$(TARGET_NAME)",
            "SDKROOT": "macosx",
            "SUPPORTED_PLATFORMS": "macosx",
            "SWIFT_VERSION": "5.0",
            "TEST_TARGET_NAME": "TaskifyMac",
        }
        build_settings = " ".join(
            f"{key} = {quote(value)};" for key, value in settings.items()
        )
        ui_test_configurations.append(
            obj(
                "ui-test-" + name,
                f"isa = XCBuildConfiguration; buildSettings = {{{build_settings}}}; name = {name};",
            )
        )
    obj(
        "ui-test-configs",
        "isa = XCConfigurationList; "
        f'buildConfigurations = ({",".join(ui_test_configurations)}); '
        "defaultConfigurationIsVisible = 0; defaultConfigurationName = UITest;",
    )

    obj(
        "ui-test-app-proxy",
        f"isa = PBXContainerItemProxy; containerPortal = {ident('project')}; proxyType = 1; "
        f"remoteGlobalIDString = {ident('target')}; remoteInfo = TaskifyMac;",
    )
    ui_test_dependency = obj(
        "ui-test-app-dependency",
        f"isa = PBXTargetDependency; target = {ident('target')}; "
        f"targetProxy = {ident('ui-test-app-proxy')};",
    )

    obj(
        "target",
        f'isa = PBXNativeTarget; buildConfigurationList = {ident("targetconfigs")}; '
        f'buildPhases = ({ident("sources")},{ident("frameworks")},{ident("resources")}); '
        "buildRules = (); dependencies = (); name = TaskifyMac; productName = Taskify; "
        f"productReference = {product}; productType = \"com.apple.product-type.application\"; "
        f'packageProductDependencies = ({",".join(products)});',
    )
    obj(
        "ui-test-target",
        f'isa = PBXNativeTarget; buildConfigurationList = {ident("ui-test-configs")}; '
        f'buildPhases = ({ident("ui-test-sources")},{ident("ui-test-frameworks")},'
        f'{ident("ui-test-resources")}); buildRules = (); dependencies = ({ui_test_dependency}); '
        "name = TaskifyMacUITests; productName = TaskifyMacUITests; "
        f"productReference = {ui_test_product}; "
        'productType = "com.apple.product-type.bundle.ui-testing"; packageProductDependencies = ();',
    )
    obj(
        "project",
        "isa = PBXProject; attributes = { LastUpgradeCheck = 2700; }; "
        f'buildConfigurationList = {ident("projectconfigs")}; compatibilityVersion = "Xcode 14.0"; '
        f"developmentRegion = en; knownRegions = (en,Base); mainGroup = {ident('group')}; "
        f'packageReferences = ({package}); projectDirPath = ""; projectRoot = ""; '
        f'targets = ({ident("target")},{ident("ui-test-target")});',
    )
    return (
        "// !$*UTF8*$!\n"
        "{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {\n"
        + "\n".join(objects)
        + f'\n}}; rootObject = {ident("project")}; }}\n'
    )


def render_scheme() -> str:
    reference = (
        '<BuildableReference BuildableIdentifier="primary" '
        f'BlueprintIdentifier="{ident("target")}" BuildableName="Taskify.app" '
        'BlueprintName="TaskifyMac" ReferencedContainer="container:TaskifyMac.xcodeproj"/>'
    )
    ui_test_reference = (
        '<BuildableReference BuildableIdentifier="primary" '
        f'BlueprintIdentifier="{ident("ui-test-target")}" '
        'BuildableName="TaskifyMacUITests.xctest" BlueprintName="TaskifyMacUITests" '
        'ReferencedContainer="container:TaskifyMac.xcodeproj"/>'
    )
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2700" version="1.3">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{reference}</BuildActionEntry><BuildActionEntry buildForTesting="YES" buildForRunning="NO" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="NO">{ui_test_reference}</BuildActionEntry></BuildActionEntries></BuildAction>
<TestAction buildConfiguration="UITest" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">{ui_test_reference}</TestableReference></Testables></TestAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{reference}</BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release"><BuildableProductRunnable runnableDebuggingMode="0">{reference}</BuildableProductRunnable></ProfileAction>
<AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
'''


def check_file(path: Path, expected: str) -> bool:
    if not path.is_file():
        print(f"Stale generated project: missing {path.relative_to(ROOT)}")
        return False
    if path.read_text() != expected:
        print(f"Stale generated project: {path.relative_to(ROOT)} differs")
        return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail without writing if the committed project does not match the manifest",
    )
    arguments = parser.parse_args()
    project_text = render_project()
    scheme_text = render_scheme()

    if arguments.check:
        matches = check_file(PROJECT_FILE, project_text)
        matches = check_file(SCHEME_FILE, scheme_text) and matches
        if matches:
            print("TaskifyMac.xcodeproj matches generate-project.py")
            return 0
        print("Run taskify-macos/Scripts/generate-project.py and commit the result.")
        return 1

    PROJECT_FILE.parent.mkdir(parents=True, exist_ok=True)
    SCHEME_FILE.parent.mkdir(parents=True, exist_ok=True)
    PROJECT_FILE.write_text(project_text)
    SCHEME_FILE.write_text(scheme_text)
    print("Generated TaskifyMac.xcodeproj")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
