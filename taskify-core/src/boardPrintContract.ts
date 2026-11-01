/**
 * Shared physical board-print contract. The PWA and native clients render the same page
 * geometry, page number bits, and print-job validation code so a sheet printed by one client can
 * be scanned by another without depending on display order or client-local state.
 */
export const BOARD_PRINT_CONTRACT_VERSION = "v3";
export const BOARD_PRINT_MAX_PAGES = (1 << 6) - 1;

export const BOARD_PRINT_PAPER_MM = {
  letter: { widthMm: 215.9, heightMm: 279.4 },
  a4: { widthMm: 210, heightMm: 297 },
  a6: { widthMm: 105, heightMm: 148 },
} as const;

export type BoardPrintPaper = keyof typeof BOARD_PRINT_PAPER_MM;

export const BOARD_PRINT_LAYOUT_MM = {
  baseMarginMm: 10,
  a6BindingMarginMm: 4,
  markerSizeMm: 6,
  markerGapMm: 2,
  headerHeightMm: 11,
  headerGapMm: 3.5,
  rowHeightMm: 7,
  circleSizeMm: 4.2,
  circleTextGapMm: 2.4,
  pageIdMarkerSizeMm: 2.4,
  pageIdMarkerGapMm: 1.2,
  pageIdBits: 6,
  jobCodeMarkerSizeMm: 2,
  jobCodeMarkerGapMm: 1,
  jobCodeBits: 10,
} as const;

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** 32-bit FNV-1a over UTF-8, mirrored by the Swift contract. */
export function boardPrintHash32(value: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/** A nonzero ten-bit code identifying a print job rather than only its page number. */
export function boardPrintJobCode(jobId: string): number {
  const code = boardPrintHash32(`taskify-board-print:${BOARD_PRINT_CONTRACT_VERSION}:${jobId}`) &
    ((1 << BOARD_PRINT_LAYOUT_MM.jobCodeBits) - 1);
  return code || 1;
}

export function boardPrintJobCodePattern(jobId: string): number[] {
  const code = boardPrintJobCode(jobId);
  return Array.from(
    { length: BOARD_PRINT_LAYOUT_MM.jobCodeBits },
    (_, bit) => (code >> bit) & 1,
  );
}

export function boardPrintPagePattern(pageIndex: number): number[] {
  const value = Math.max(0, Math.floor(pageIndex)) + 1;
  return Array.from(
    { length: BOARD_PRINT_LAYOUT_MM.pageIdBits },
    (_, bit) => (value >> bit) & 1,
  );
}

export function isSupportedBoardPrintVersion(version: unknown): version is string {
  return version === BOARD_PRINT_CONTRACT_VERSION || version === "v1" || version === "v2";
}
