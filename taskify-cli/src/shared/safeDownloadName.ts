/**
 * A file name for saving an attachment when the user gave no `--out`.
 *
 * The attachment's name is chosen by whoever attached it, so it is reduced to a bare file name in
 * the current directory: no directories, no `.`/`..`, no control characters, no leading dot that
 * would hide the file. Anything left empty falls back to `fallback`.
 */
export function safeDownloadName(rawName: unknown, fallback: string): string {
  const raw = typeof rawName === "string" ? rawName : "";
  // Last path component, whichever separator was used.
  const lastComponent = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = lastComponent
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 200);
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned;
}
