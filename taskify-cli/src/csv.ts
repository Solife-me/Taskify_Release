// ---- CSV helpers ----

// Spreadsheets treat a cell starting with = + - @ (or a tab or carriage return) as a formula, which
// can fetch URLs carrying other cells' contents. Task text is written by other board members, so
// such cells get a leading apostrophe; parseCSV removes it again on import.
const FORMULA_START = /^[=+\-@\t\r]/;
const ESCAPED_FORMULA_START = /^'[=+\-@\t\r]/;

export function csvEscape(val: string): string {
  if (!val) return "";
  const safe = FORMULA_START.test(val) ? `'${val}` : val;
  if (/[",\n\r]/.test(safe)) {
    return '"' + safe.replace(/"/g, '""') + '"';
  }
  return safe;
}

function unescapeFormula(value: string): string {
  return ESCAPED_FORMULA_START.test(value) ? value.slice(1) : value;
}

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) { fields.push(""); break; }
    if (line[i] === '"') {
      let field = "";
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { field += '"'; i += 2; }
        else if (line[i] === '"') { i++; break; }
        else { field += line[i++]; }
      }
      fields.push(field);
      if (line[i] === ",") i++;
    } else {
      const end = line.indexOf(",", i);
      if (end === -1) { fields.push(line.slice(i)); break; }
      else { fields.push(line.slice(i, end)); i = end + 1; }
    }
  }
  return fields;
}

export function parseCSV(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCSVLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h.trim()] = unescapeFormula((values[idx] ?? "").trim()); });
    return row;
  });
}
