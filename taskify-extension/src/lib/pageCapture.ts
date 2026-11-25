/**
 * Getting the page the user is reading into the chat.
 *
 * The panel asks the content script in the active tab for the page's text or the user's
 * selection, and asks the background worker for a screenshot. Both go through the extension's
 * messaging, so the panel never touches the page directly.
 */
import type { PageCapture } from "./capture";

/** The tab the panel is acting on: the one the user is looking at. */
export async function activeTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

/** Runs the content script in a tab and asks it for a capture. */
async function captureFromTab(tabId: number, kind: "text" | "selection"): Promise<PageCapture | null> {
  try {
    const response = (await chrome.tabs.sendMessage(tabId, { type: "taskify:capture", kind })) as
      | { ok: true; capture: PageCapture }
      | { ok: false; error: string }
      | undefined;
    if (!response) return null;
    if (!response.ok) throw new Error(response.error);
    return response.capture;
  } catch (err) {
    // The content script is not in that tab (a page the browser forbids scripting in, or one that
    // has not finished loading). Inject it and try once more.
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      const response = (await chrome.tabs.sendMessage(tabId, { type: "taskify:capture", kind })) as
        | { ok: true; capture: PageCapture }
        | { ok: false; error: string }
        | undefined;
      if (!response) return null;
      if (!response.ok) throw new Error(response.error);
      return response.capture;
    } catch (inner) {
      console.warn("[taskify] could not capture the page", inner);
      return null;
    }
  }
}

/** The page's readable text. */
export async function capturePageText(): Promise<PageCapture | null> {
  const tab = await activeTab();
  if (!tab?.id) return null;
  return captureFromTab(tab.id, "text");
}

/** The user's selection, falling back to the page's text when nothing is selected. */
export async function captureSelection(): Promise<PageCapture | null> {
  const tab = await activeTab();
  if (!tab?.id) return null;
  return captureFromTab(tab.id, "selection");
}

/** A picture of the visible page. */
export async function captureScreenshot(): Promise<{ dataUrl: string; title: string; url: string } | null> {
  const tab = await activeTab();
  if (!tab?.id) return null;
  const response = (await chrome.runtime.sendMessage({ type: "taskify:screenshot", tabId: tab.id })) as
    | { ok: true; dataUrl: string }
    | { ok: false; error: string }
    | undefined;
  if (!response || !response.ok) {
    console.warn("[taskify] the screenshot failed", response);
    return null;
  }
  return {
    dataUrl: response.dataUrl,
    title: tab.title ?? "Page",
    url: tab.url ?? "",
  };
}

/** A data URL as the bytes that will be encrypted and uploaded. */
export function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mimeType: string } {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) throw new Error("That is not a data URL.");
  const mimeType = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || "";
  if (isBase64) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return { bytes, mimeType };
  }
  return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), mimeType };
}
