const FIXED_UPLOAD_ROUTES = {
    originless: { method: "POST", path: "/up" },
    blossom: { method: "PUT", path: "/upload" },
};
export const TASKIFY_IPFS_GATEWAY_BASE = "https://dweb.link";
/** Fixed upload routes shared by the PWA, CLI and native clients. NIP-96 discovers its route. */
export function fixedFileUploadRoute(type) {
    return FIXED_UPLOAD_ROUTES[type];
}
export function fixedFileUploadURL(serverURL, type) {
    return `${serverURL.replace(/\/+$/, "")}${fixedFileUploadRoute(type).path}`;
}
export const OPAQUE_UPLOAD_FILENAME_SUFFIX = ".bin";
/**
 * A content-addressed name for encrypted upload bytes. It deliberately contains no original
 * filename, extension, MIME type, or account metadata; only ciphertext is reachable at this name.
 */
export function opaqueUploadFilename(ciphertextSha256) {
    const hash = ciphertextSha256.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) {
        throw new Error("Ciphertext SHA-256 must be 64 hexadecimal characters.");
    }
    return `${hash}${OPAQUE_UPLOAD_FILENAME_SUFFIX}`;
}
/** Deliberately shallow: enough to distinguish a CID from a path or sentence. */
function isPlausibleCID(value) {
    return (value.length >= 46 || value.startsWith("b")) && /^[A-Za-z0-9]+$/.test(value);
}
/** Resolves the URL shapes returned by Originless, including its CID-only response. */
export function resolveOriginlessUploadURL(serverURL, payload) {
    const data = payload && typeof payload === "object" ? payload : {};
    for (const key of ["url", "cidUrl", "gatewayUrl", "fileUrl", "ipfs"]) {
        const value = data[key];
        if (typeof value === "string" && value.trim())
            return value.trim();
    }
    const cid = typeof data.cid === "string" ? data.cid.trim() : "";
    if (cid && isPlausibleCID(cid))
        return `${TASKIFY_IPFS_GATEWAY_BASE}/ipfs/${cid}`;
    const path = typeof data.path === "string" ? data.path.trim() : "";
    if (!path)
        return "";
    if (path.startsWith("http"))
        return path;
    const base = serverURL.replace(/\/+$/, "");
    return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}
