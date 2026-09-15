// ---- CSV helpers ----

export function csvEscape(val: string): string {
  if (!val) return "";
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
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
    headers.forEach((h, idx) => { row[h.trim()] = (values[idx] ?? "").trim(); });
    return row;
  });
}
