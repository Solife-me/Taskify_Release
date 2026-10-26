/**
 * Runs `callback` once the page has loaded: at once if it already has, else on `load`.
 * Code that runs after an asynchronous start (dynamic imports, storage setup) usually comes after
 * `load` has fired, and a listener added then never runs.
 */
export function whenWindowLoaded(
  callback: () => void,
  doc: Pick<Document, "readyState"> = document,
  win: Pick<Window, "addEventListener"> = window,
): void {
  if (doc.readyState === "complete") {
    callback();
    return;
  }
  win.addEventListener("load", () => callback(), { once: true });
}
