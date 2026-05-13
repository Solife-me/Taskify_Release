export type NostrAppBackupBoard = {
    id: string;
    nostrId?: string;
    relays?: string[];
    name?: string;
    kind?: "week" | "lists" | "compound" | "bible";
    archived?: boolean;
    hidden?: boolean;
    order?: number;
    columns?: {
        id: string;
        name: string;
    }[];
    children?: string[];
    clearCompletedDisabled?: boolean;
    indexCardEnabled?: boolean;
    hideChildBoardNames?: boolean;
};
export type WalletSeedBackupPayload = {
    type: "nut13-wallet-backup";
    version: 1;
    mnemonic: string;
    createdAt?: string;
    counters: Record<string, Record<string, number>>;
};
type RelayNormalizer = (relays: string[] | null | undefined) => string[];
export type BackupBoardLike = {
    id: string;
    name: string;
    kind: "week" | "lists" | "compound" | "bible";
    nostr?: {
        boardId: string;
        relays: string[];
    };
    archived?: boolean;
    hidden?: boolean;
    clearCompletedDisabled?: boolean;
    indexCardEnabled?: boolean;
    hideChildBoardNames?: boolean;
    columns?: {
        id: string;
        name: string;
    }[];
    children?: string[];
};
export type NostrBackupSnapshot<TSettings> = {
    boards: NostrAppBackupBoard[];
    settings: Partial<TSettings>;
    walletSeed: WalletSeedBackupPayload;
    defaultRelays: string[];
};
export declare function sanitizeSettingsForNostrBackup<TSettings extends Record<string, unknown>>(raw: TSettings | Record<string, unknown>, defaultPushPreferences: Record<string, unknown>): Partial<TSettings>;
export declare function buildNostrBackupSnapshot<TBoard extends BackupBoardLike, TSettings extends Record<string, unknown>>(options: {
    boards: TBoard[];
    settings: TSettings;
    includeMetadata: boolean;
    defaultRelays: string[];
    fallbackRelays: string[];
    normalizeRelayList: RelayNormalizer;
    sanitizeSettingsForBackup: (raw: TSettings | Record<string, unknown>) => Partial<TSettings>;
    walletSeed: WalletSeedBackupPayload;
}): NostrBackupSnapshot<TSettings>;
export declare function mergeBackupBoards<TBoard extends BackupBoardLike>(options: {
    currentBoards: TBoard[];
    incomingBoards: NostrAppBackupBoard[];
    baseRelays: string[];
    normalizeRelayList: RelayNormalizer;
    createId: () => string;
}): TBoard[];
export {};
