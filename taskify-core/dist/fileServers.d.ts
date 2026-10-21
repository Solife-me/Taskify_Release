export type FixedFileUploadServerType = "originless" | "blossom";
export type FixedFileUploadRoute = {
    method: "POST" | "PUT";
    path: `/${string}`;
};
export declare const TASKIFY_IPFS_GATEWAY_BASE = "https://dweb.link";
/** Fixed upload routes shared by the PWA, CLI and native clients. NIP-96 discovers its route. */
export declare function fixedFileUploadRoute(type: FixedFileUploadServerType): FixedFileUploadRoute;
export declare function fixedFileUploadURL(serverURL: string, type: FixedFileUploadServerType): string;
/** Resolves the URL shapes returned by Originless, including its CID-only response. */
export declare function resolveOriginlessUploadURL(serverURL: string, payload: unknown): string;
