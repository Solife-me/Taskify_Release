const NUT_EMOJI = "🥜";
const VS1_START = 0xfe00;
const VS1_END = 0xfe0f;
const VS17_START = 0xe0100;

function toVariationSelector(charCode: number): string {
  if (charCode >= 0 && charCode <= 15) {
    return String.fromCodePoint(VS1_START + charCode);
  }
  if (charCode >= 16 && charCode <= 255) {
    return String.fromCodePoint(VS17_START + (charCode - 16));
  }
  return "";
}

function fromVariationSelector(codePoint: number): string | null {
  if (codePoint >= VS1_START && codePoint <= VS1_END) {
    return String.fromCharCode(codePoint - VS1_START);
  }
  if (codePoint >= VS17_START && codePoint <= 0xe01ef) {
    return String.fromCharCode(codePoint - VS17_START + 16);
  }
  return null;
}

export function encodePeanut(token: string): string {
  const encoded = Array.from(token || "")
    .map((char) => toVariationSelector(char.charCodeAt(0)))
    .filter(Boolean)
    .join("");
  if (!encoded) {
    throw new Error("Cannot encode empty token");
  }
  return `${NUT_EMOJI}${encoded}`;
}

export function decodePeanut(text: string): string | null {
  if (!text || !text.includes(NUT_EMOJI)) return null;
  const decoded: string[] = [];
  for (const char of Array.from(text)) {
    const mapped = fromVariationSelector(char.codePointAt(0) ?? 0);
    if (mapped === null) {
      if (decoded.length > 0) break;
      continue;
    }
    decoded.push(mapped);
  }
  if (!decoded.length) return null;
  return decoded.join("");
}

export function extractPeanutToken(text: string): string | null {
  const decoded = decodePeanut(text);
  if (!decoded) return null;
  const trimmed = decoded.trim();
  return trimmed || null;
}
