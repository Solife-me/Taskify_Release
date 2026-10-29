/**
 * Shared physical board-print contract. The PWA and native clients render the same page
 * geometry, page number bits, and print-job validation code so a sheet printed by one client can
 * be scanned by another without depending on display order or client-local state.
 */
export declare const BOARD_PRINT_CONTRACT_VERSION = "v3";
export declare const BOARD_PRINT_MAX_PAGES: number;
export declare const BOARD_PRINT_PAPER_MM: {
    readonly letter: {
        readonly widthMm: 215.9;
        readonly heightMm: 279.4;
    };
    readonly a4: {
        readonly widthMm: 210;
        readonly heightMm: 297;
    };
    readonly a6: {
        readonly widthMm: 105;
        readonly heightMm: 148;
    };
};
export type BoardPrintPaper = keyof typeof BOARD_PRINT_PAPER_MM;
export declare const BOARD_PRINT_LAYOUT_MM: {
    readonly baseMarginMm: 10;
    readonly a6BindingMarginMm: 4;
    readonly markerSizeMm: 6;
    readonly markerGapMm: 2;
    readonly headerHeightMm: 11;
    readonly headerGapMm: 3.5;
    readonly rowHeightMm: 7;
    readonly circleSizeMm: 4.2;
    readonly circleTextGapMm: 2.4;
    readonly pageIdMarkerSizeMm: 2.4;
    readonly pageIdMarkerGapMm: 1.2;
    readonly pageIdBits: 6;
    readonly jobCodeMarkerSizeMm: 2;
    readonly jobCodeMarkerGapMm: 1;
    readonly jobCodeBits: 10;
};
/** 32-bit FNV-1a over UTF-8, mirrored by the Swift contract. */
export declare function boardPrintHash32(value: string): number;
/** A nonzero ten-bit code identifying a print job rather than only its page number. */
export declare function boardPrintJobCode(jobId: string): number;
export declare function boardPrintJobCodePattern(jobId: string): number[];
export declare function boardPrintPagePattern(pageIndex: number): number[];
export declare function isSupportedBoardPrintVersion(version: unknown): version is string;
