export declare const DEFAULT_NOSTR_RELAYS: readonly ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.solife.me"];
export type DefaultRelay = typeof DEFAULT_NOSTR_RELAYS[number];
export declare function sha256(data: Uint8Array): Promise<Uint8Array>;
export declare function bytesHexToBytes(hex: string): Uint8Array;
export declare function bytesToHexString(b: Uint8Array): string;
export declare function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer>;
export declare function b64encode(buf: ArrayBuffer | Uint8Array): string;
export declare function b64decode(s: string): Uint8Array;
export declare const CLOUD_BACKUP_KEY_LABEL: Uint8Array<ArrayBuffer>;
export declare function deriveBackupAesKey(skHex: string): Promise<CryptoKey>;
export declare function encryptBackupWithSecretKey(skHex: string, plain: string): Promise<{
    iv: string;
    ciphertext: string;
}>;
export declare function decryptBackupWithSecretKey(skHex: string, payload: {
    iv: string;
    ciphertext: string;
}): Promise<string>;
