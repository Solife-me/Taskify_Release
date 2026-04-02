export const DEFAULT_NOSTR_RELAYS = [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.solife.me",
];
function toArrayBuffer(bytes) {
    return Uint8Array.from(bytes).buffer;
}
export async function sha256(data) {
    const view = data instanceof Uint8Array ? data : new Uint8Array(data);
    const h = await crypto.subtle.digest("SHA-256", toArrayBuffer(view));
    return new Uint8Array(h);
}
export function bytesHexToBytes(hex) {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++)
        out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
}
export function bytesToHexString(b) {
    return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
export function concatBytes(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
}
export function b64encode(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < b.length; i++)
        s += String.fromCharCode(b[i]);
    return btoa(s);
}
export function b64decode(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++)
        out[i] = bin.charCodeAt(i);
    return out;
}
export const CLOUD_BACKUP_KEY_LABEL = new TextEncoder().encode("taskify-cloud-backup-v1");
export async function deriveBackupAesKey(skHex) {
    const raw = concatBytes(bytesHexToBytes(skHex), CLOUD_BACKUP_KEY_LABEL);
    const digest = await sha256(raw);
    return await crypto.subtle.importKey("raw", toArrayBuffer(digest), "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encryptBackupWithSecretKey(skHex, plain) {
    const key = await deriveBackupAesKey(skHex);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plainBytes = new TextEncoder().encode(plain);
    const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(plainBytes));
    return { iv: b64encode(iv), ciphertext: b64encode(ctBuf) };
}
export async function decryptBackupWithSecretKey(skHex, payload) {
    const key = await deriveBackupAesKey(skHex);
    const iv = b64decode(payload.iv);
    const ct = b64decode(payload.ciphertext);
    const ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(ct));
    return new TextDecoder().decode(new Uint8Array(ptBuf));
}
