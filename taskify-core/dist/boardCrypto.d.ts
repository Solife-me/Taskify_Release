export declare function boardTagHash(boardId: string): Promise<string>;
export declare function encryptToBoard(boardId: string, plaintext: string): Promise<string>;
export declare function decryptFromBoard(boardId: string, data: string): Promise<{
    plaintext: string;
    usedLegacyKey: boolean;
}>;
