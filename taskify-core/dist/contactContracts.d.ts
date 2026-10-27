export type Nip05CheckState = {
    status: "pending" | "valid" | "invalid";
    nip05: string;
    npub: string;
    checkedAt: number;
    contactUpdatedAt?: number | null;
};
export type ContactLike = {
    id?: string;
    npub?: string;
    nip05?: string;
};
export declare function normalizeNip05(value?: string | null): string | null;
export declare function compressedToRawHex(value: string): string;
export declare function normalizeNostrPubkeyHex(value: string | null | undefined): string | null;
export declare function contactVerifiedNip05(contact: ContactLike, cache: Record<string, Nip05CheckState>): string | null;
/** Avatar initials: a leading emoji on its own, else first and last initials (or two letters of one word). */
export declare function contactInitials(value: string): string;
