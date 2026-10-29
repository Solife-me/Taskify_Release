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
    order?: number;
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
    /** Only when the device has a wallet seed; a backup never creates one. */
    walletSeed?: WalletSeedBackupPayload | null;
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
    /** Only when the device has a wallet seed; a backup never creates one. */
    walletSeed?: WalletSeedBackupPayload | null;
}): NostrBackupSnapshot<TSettings>;
export declare function mergeBackupBoards<TBoard extends BackupBoardLike>(options: {
    currentBoards: TBoard[];
    incomingBoards: NostrAppBackupBoard[];
    baseRelays: string[];
    normalizeRelayList: RelayNormalizer;
    createId: () => string;
}): TBoard[];
/** A backup as it is published and read. */
export type NostrBackupContent = {
    boards: NostrAppBackupBoard[];
    settings: Record<string, unknown>;
    walletSeed?: WalletSeedBackupPayload | null;
    defaultRelays?: string[];
    printJobs?: NostrPrintJobManifest[];
};
/** A portable, encrypted print manifest shared by the PWA and native clients. */
export type NostrPrintJobManifest = {
    version: 1;
    layoutVersion: string;
    id: string;
    ownerId: string;
    title: string;
    createdAt: number;
    paper: "letter" | "a4" | "a6";
    format: "taskList" | "bibleChapters";
    items: Array<{
        id: string;
        title: string;
        section?: string;
        filled?: boolean;
    }>;
};
/** Newest manifest wins per stable board/tracker owner; cap history to keep the event bounded. */
export declare function mergeNostrPrintJobs(remote: NostrPrintJobManifest[] | null | undefined, local: NostrPrintJobManifest[] | null | undefined): NostrPrintJobManifest[];
/**
 * The backup to publish: the latest one on the relays, updated with this device's snapshot. The
 * same rule as iOS (`updatingNativeBoards`), and the only safe one for a backup several devices
 * write:
 *
 * - never build a backup without having read the remote one (`remote` null only when the relays
 *   confirmed there is none);
 * - boards another device put there stay; the boards this device manages (has published) are
 *   replaced by its current ones, or dropped when it no longer has them;
 * - settings keys only other clients write are kept;
 * - the wallet seed stays when this device has none.
 *
 * Without metadata (boards and settings not backed up from this device), only the seed changes.
 */
export declare function updateRemoteNostrBackup(remote: NostrBackupContent | null, local: {
    boards: NostrAppBackupBoard[];
    settings: Record<string, unknown>;
    walletSeed?: WalletSeedBackupPayload | null;
    defaultRelays: string[];
    printJobs?: NostrPrintJobManifest[];
}, options: {
    managedNostrIds: Iterable<string>;
    includeMetadata: boolean;
}): NostrBackupContent & {
    managedNostrIds: string[];
};
export {};
