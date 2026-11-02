export type FixedFileUploadServerType = "originless" | "blossom";
export type FixedFileUploadRoute = {
    method: "POST" | "PUT";
    path: `/${string}`;
};
/**
 * Originless returns a CID and does not serve blobs itself, so retrieval goes through a public
 * gateway. In order of preference: a CID names the same bytes on every gateway, so an attachment
 * whose gateway has gone away can still be fetched from another. Attachments are encrypted before
 * upload, so a gateway only ever handles ciphertext. Both were verified serving an Originless
 * upload, with CORS open for the PWA, in November 2026.
 */
export declare const TASKIFY_IPFS_GATEWAY_BASES: readonly ["https://ipfs.filebase.io", "https://gateway.pinata.cloud"];
export declare const TASKIFY_IPFS_GATEWAY_BASE: "https://ipfs.filebase.io";
/** Fixed upload routes shared by the PWA, CLI and native clients. NIP-96 discovers its route. */
export declare function fixedFileUploadRoute(type: FixedFileUploadServerType): FixedFileUploadRoute;
export declare function fixedFileUploadURL(serverURL: string, type: FixedFileUploadServerType): string;
export declare const OPAQUE_UPLOAD_FILENAME_SUFFIX = ".bin";
/**
 * A content-addressed name for encrypted upload bytes. It deliberately contains no original
 * filename, extension, MIME type, or account metadata; only ciphertext is reachable at this name.
 */
export declare function opaqueUploadFilename(ciphertextSha256: string): string;
/** Resolves the URL shapes returned by Originless, including its CID-only response. */
export declare function resolveOriginlessUploadURL(serverURL: string, payload: unknown): string;
/** Where to fetch `url` from, in order. A URL that isn't an IPFS gateway URL only has itself. */
export declare function ipfsRetrievalCandidates(url: string): string[];
/**
 * Fetches `url`, falling back across IPFS gateways when it names content-addressed bytes. Resolves
 * with the first successful response, or the last failed one so the caller can report its status.
 */
export declare function fetchWithIPFSGatewayFallback(url: string, init?: RequestInit, fetchImpl?: typeof fetch): Promise<Response>;
