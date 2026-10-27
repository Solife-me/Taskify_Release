/**
 * Spotting a Cashu ecash token in a chat message, so it can be shown as a token and copied.
 * Chat does nothing else with tokens (it has no wallet), so this only checks the token's shape
 * and never decodes it: version 3 tokens start with `cashuA`, version 4 with `cashuB`, and the
 * rest is base64url.
 */
const TOKEN_PATTERN = /^cashu[AB][A-Za-z0-9_\-+/]{20,}={0,2}$/;
const URI_PARAMS = ["token", "cashu", "t"];
const INVISIBLE = /\u200b|\u200c|\u200d|\ufeff/g;
const TRAILING_PUNCTUATION = /[)\]}>.,!?;:"'‘’“”`]+$/;
const MAX_TOKEN_LENGTH = 16_384;

function normalize(candidate: string): string | null {
  let value = candidate.replace(INVISIBLE, "").trim().replace(/^[("'`<‘’“”]+/, "");
  if (/^cashu:/i.test(value)) {
    const rest = value.slice("cashu:".length);
    if (rest.startsWith("?")) {
      const params = new URLSearchParams(rest.slice(1));
      value = URI_PARAMS.map((key) => params.get(key)).find(Boolean) ?? "";
    } else {
      value = rest.replace(/^\/\//, "");
    }
  }
  value = value.replace(/\s+/g, "").replace(TRAILING_PUNCTUATION, "");
  return value.length <= MAX_TOKEN_LENGTH && TOKEN_PATTERN.test(value) ? value : null;
}

/** The first Cashu token in `text`, including one a client wrapped across lines, or null. */
export function findCashuToken(text: string | null | undefined): string | null {
  const source = text || "";
  if (!/cashu/i.test(source)) return null;
  const parts = source.split(/\s+/).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    if (!/^[("'`<‘’“”]*cashu/i.test(parts[index]!)) continue;
    let combined = parts[index]!;
    let token = normalize(combined);
    // Some clients wrap long tokens; keep appending chunks while they look like base64url.
    for (let next = index + 1; next < parts.length && next < index + 32; next += 1) {
      const chunk = parts[next]!;
      // A wrapped piece is long and looks encoded (has a capital or a digit), unlike a next word.
      if (!/^[A-Za-z0-9_\-+/=]{8,}[)\]}>.,!?;:"'‘’“”`]*$/.test(chunk) || !/[A-Z0-9]/.test(chunk)) break;
      const longer = normalize(combined + chunk);
      if (!longer) break;
      combined += chunk;
      token = longer;
    }
    if (token) return token;
  }
  return null;
}
