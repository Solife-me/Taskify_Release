import { BOARD_PRINT_PAPER_MM } from "taskify-core";

export type PrintPaperSize = keyof typeof BOARD_PRINT_PAPER_MM;

export const PRINT_PAPER_OPTIONS: Array<{
  value: PrintPaperSize;
  label: string;
  shortLabel: string;
  widthMm: number;
  heightMm: number;
}> = [
  {
    value: "letter",
    label: "Letter (8.5 x 11 in)",
    shortLabel: "Letter",
    widthMm: 215.9,
    heightMm: 279.4,
  },
  {
    value: "a4",
    label: "A4 (210 x 297 mm)",
    shortLabel: "A4",
    widthMm: BOARD_PRINT_PAPER_MM.a4.widthMm,
    heightMm: BOARD_PRINT_PAPER_MM.a4.heightMm,
  },
  {
    value: "a6",
    label: "A6 (105 x 148 mm)",
    shortLabel: "A6",
    widthMm: BOARD_PRINT_PAPER_MM.a6.widthMm,
    heightMm: BOARD_PRINT_PAPER_MM.a6.heightMm,
  },
];

const PRINT_PAPER_LOOKUP = PRINT_PAPER_OPTIONS.reduce<Record<PrintPaperSize, typeof PRINT_PAPER_OPTIONS[number]>>(
  (acc, option) => {
    acc[option.value] = option;
    return acc;
  },
  {} as Record<PrintPaperSize, typeof PRINT_PAPER_OPTIONS[number]>,
);

export function getPaperDefinition(paperSize: PrintPaperSize) {
  return PRINT_PAPER_LOOKUP[paperSize];
}

export function isPrintPaperSize(value: unknown): value is PrintPaperSize {
  return value === "letter" || value === "a4" || value === "a6";
}
