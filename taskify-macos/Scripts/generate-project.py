#!/usr/bin/env python3
"""Generate the native Mac project using shared sources without third-party tooling."""
from pathlib import Path
import hashlib
import json
root = Path(__file__).resolve().parents[1]
shared = root.parent / 'taskify-ios-native/Sources/TaskifyApp'
paths = sorted((root / 'Sources').rglob('*.swift'))
paths += [shared / p for p in [
    'App/AppModel.swift', 'App/FastingRemindersSettings.swift',
    'App/ScriptureMemorySettings.swift', 'App/TaskStreakSettings.swift',
    'App/TaskOrderingSettings.swift', 'App/StartupViewSettings.swift',
    'App/OnboardingSettings.swift', 'App/NpubCashSettings.swift',
    'Security/KeychainIdentityStore.swift', 'Features/Wallet/WalletView.swift',
    'Features/Wallet/WalletViewModel+NWC.swift',
    'Features/Boards/BibleTrackerStore.swift',
    'Features/Upcoming/DeviceCalendarStore.swift',
    'Features/Tasks/TaskAttachmentUploadService.swift',
    'Notifications/TaskNotificationCoordinator.swift',
    'Notifications/DMPushNotificationCoordinator.swift',
]]
def ident(s): return hashlib.sha256(s.encode()).hexdigest()[:24].upper()
def q(s): return json.dumps(str(s))
objects=[]
def obj(key, value):
    objects.append(f'{ident(key)} = {{ {value} }};')
    return ident(key)
files=[]; builds=[]
import os
for path in paths:
    rel=os.path.relpath(path,root)
    files.append(obj(rel, f'isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = {q(rel)}; sourceTree = SOURCE_ROOT;'))
    builds.append(obj(rel+'build', f'isa = PBXBuildFile; fileRef = {ident(rel)};'))
product=obj('product','isa = PBXFileReference; explicitFileType = wrapper.application; path = Taskify.app; sourceTree = BUILT_PRODUCTS_DIR;')
resource_builds=[]
for rel, file_type in [('Taskify.icns', 'image.icns'), ('../taskify-ios-native/Sources/TaskifyApp/Resources/ThirdPartyNotices.txt', 'text')]:
    files.append(obj(rel, f'isa = PBXFileReference; lastKnownFileType = {file_type}; path = {q(rel)}; sourceTree = SOURCE_ROOT;'))
    resource_builds.append(obj(rel+'build',f'isa = PBXBuildFile; fileRef = {ident(rel)};'))
obj('group',f'isa = PBXGroup; children = ({",".join(files+[product])}); sourceTree = "<group>";')
obj('sources',f'isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = ({",".join(builds)}); runOnlyForDeploymentPostprocessing = 0;')
package=obj('package','isa = XCLocalSwiftPackageReference; relativePath = "../taskify-ios-native";')
products=[]; frameworks=[]
for name in ['TaskifyCore','TaskifyWatchShared']:
    products.append(obj(name,f'isa = XCSwiftPackageProductDependency; productName = {name};'))
    frameworks.append(obj(name+'link',f'isa = PBXBuildFile; productRef = {ident(name)};'))
obj('frameworks',f'isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = ({",".join(frameworks)}); runOnlyForDeploymentPostprocessing = 0;')
obj('resources',f'isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = ({",".join(resource_builds)}); runOnlyForDeploymentPostprocessing = 0;')
for scope in ['project','target']:
    configs=[]
    for name in ['Debug','Local','Release']:
        settings={'SWIFT_VERSION':'5.0','MACOSX_DEPLOYMENT_TARGET':'14.0','SDKROOT':'macosx','CLANG_ENABLE_MODULES':'YES','ONLY_ACTIVE_ARCH':'YES' if name!='Release' else 'NO'}
        if scope=='target':settings.update({'TASKIFY_PRODUCT_NAME':'Taskify','PRODUCT_NAME':'$(TASKIFY_PRODUCT_NAME)','PRODUCT_BUNDLE_IDENTIFIER':'solife.me.Taskify.Mac','INFOPLIST_FILE':'Info.plist','CODE_SIGN_ENTITLEMENTS':'TaskifyMac.entitlements','CODE_SIGN_STYLE':'Automatic','ENABLE_HARDENED_RUNTIME':'YES','SUPPORTED_PLATFORMS':'macosx','SWIFT_EMIT_LOC_STRINGS':'YES','LD_RUNPATH_SEARCH_PATHS':'$(inherited) @executable_path/../Frameworks','COMBINE_HIDPI_IMAGES':'YES'})
        settings.update({'SWIFT_OPTIMIZATION_LEVEL':'-Onone' if name!='Release' else '-O','SWIFT_ACTIVE_COMPILATION_CONDITIONS':'DEBUG' if name!='Release' else ''})
        configs.append(obj(scope+name,'isa = XCBuildConfiguration; buildSettings = {'+' '.join(f'{k} = {q(v)};' for k,v in settings.items())+f'}}; name = {name};'))
    obj(scope+'configs',f'isa = XCConfigurationList; buildConfigurations = ({",".join(configs)}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;')
obj('target',f'isa = PBXNativeTarget; buildConfigurationList = {ident("targetconfigs")}; buildPhases = ({ident("sources")},{ident("frameworks")},{ident("resources")}); buildRules = (); dependencies = (); name = TaskifyMac; productName = Taskify; productReference = {product}; productType = "com.apple.product-type.application"; packageProductDependencies = ({",".join(products)});')
obj('project',f'isa = PBXProject; attributes = {{ LastUpgradeCheck = 2700; }}; buildConfigurationList = {ident("projectconfigs")}; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; knownRegions = (en,Base); mainGroup = {ident("group")}; packageReferences = ({package}); projectDirPath = ""; projectRoot = ""; targets = ({ident("target")});')
project=root/'TaskifyMac.xcodeproj';project.mkdir(exist_ok=True)
(project/'project.pbxproj').write_text('// !$*UTF8*$!\n{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {\n'+'\n'.join(objects)+f'\n}}; rootObject = {ident("project")}; }}\n')
scheme=project/'xcshareddata/xcschemes';scheme.mkdir(parents=True,exist_ok=True)
ref=f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{ident("target")}" BuildableName="Taskify.app" BlueprintName="TaskifyMac" ReferencedContainer="container:TaskifyMac.xcodeproj"/>'
(scheme/'TaskifyMac.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2700" version="1.3">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{ref}</BuildActionEntry></BuildActionEntries></BuildAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref}</BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release"><BuildableProductRunnable runnableDebuggingMode="0">{ref}</BuildableProductRunnable></ProfileAction>
<AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
''')
print('Generated TaskifyMac.xcodeproj')
