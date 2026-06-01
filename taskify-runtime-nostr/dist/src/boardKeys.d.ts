import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
export type BoardKeyPair = {
    sk: Uint8Array;
    skHex: string;
    pk: string;
    npub: string;
    nsec: string;
    signer: NDKPrivateKeySigner;
};
export declare function boardTagHash(boardId: string): string;
export declare function deriveBoardKeyPair(boardId: string): BoardKeyPair;
export declare class BoardKeyManager {
    private cache;
    getBoardKeys(boardId: string): Promise<BoardKeyPair>;
    getBoardSigner(boardId: string): Promise<NDKPrivateKeySigner>;
    getBoardPubkey(boardId: string): Promise<string>;
}
