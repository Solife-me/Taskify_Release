#!/bin/sh

set -eu

# Swift Package Manager embeds CashuDevKitFFI as a generated framework stub. The
# upstream XCFramework is static, so it cannot contain the dSYM for that final
# embedded binary. Generate the matching companion dSYM after Xcode creates the
# framework and place it alongside the app dSYM for archive collection.
if [ "${PLATFORM_NAME:-}" != "iphoneos" ]; then
    exit 0
fi

framework="${TARGET_BUILD_DIR}/${FRAMEWORKS_FOLDER_PATH}/CashuDevKitFFI.framework"
binary="${framework}/CashuDevKitFFI"
dsym_root="${DWARF_DSYM_FOLDER_PATH:-}"

if [ ! -f "${binary}" ]; then
    echo "error: Embedded CashuDevKitFFI binary was not found at ${binary}" >&2
    exit 1
fi

if [ -z "${dsym_root}" ]; then
    echo "error: DWARF_DSYM_FOLDER_PATH is unavailable for the CashuDevKitFFI archive dSYM" >&2
    exit 1
fi

dsym="${dsym_root}/CashuDevKitFFI.framework.dSYM"
case "${dsym}" in
    "${dsym_root}/CashuDevKitFFI.framework.dSYM") ;;
    *)
        echo "error: Refusing to replace an unexpected dSYM path: ${dsym}" >&2
        exit 1
        ;;
esac

if [ -e "${dsym}" ]; then
    /bin/rm -rf "${dsym}"
fi

toolchain="${DEVELOPER_DIR}/Toolchains/XcodeDefault.xctoolchain/usr/bin"
dsymutil="${toolchain}/dsymutil"
dwarfdump="${toolchain}/dwarfdump"

"${dsymutil}" "${binary}" -o "${dsym}"

binary_uuid=$("${dwarfdump}" --uuid "${binary}" | /usr/bin/awk 'NR == 1 { print $2 }')
dsym_uuid=$("${dwarfdump}" --uuid "${dsym}" | /usr/bin/awk 'NR == 1 { print $2 }')

if [ -z "${binary_uuid}" ] || [ "${binary_uuid}" != "${dsym_uuid}" ]; then
    echo "error: CashuDevKitFFI dSYM UUID ${dsym_uuid:-missing} does not match framework UUID ${binary_uuid:-missing}" >&2
    exit 1
fi

echo "Generated CashuDevKitFFI dSYM with matching UUID ${dsym_uuid}"
