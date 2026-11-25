/**
 * The background service worker: the extension's switchboard.
 *
 * It owns the two things a content script cannot do for itself:
 *   - opening the side panel (the action button, and the keyboard command)
 *   - taking a screenshot of a tab (`chrome.tabs.captureVisibleTab` is not available to content
 *     scripts, and it is the only way to picture a page without asking the user to crop it)
 *
 * Everything else lives in the panel.
 */

/** Opens the side panel for a window, focusing it if it is already open. */
async function openSidePanel(windowId: number) {
  try {
    await chrome.sidePanel.open({ windowId });
  } catch {
    // `sidePanel.open` needs a user gesture. The toolbar click is one, so this normally works;
    // if it does not, the panel is still reachable from the browser's side-panel menu.
  }
}

chrome.action.onClicked.addListener((tab) => {
  if (typeof tab.windowId === "number") {
    void openSidePanel(tab.windowId);
  }
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
      // Older Brave builds may not support the behaviour; the action handler covers it instead.
    });
  }
});

/**
 * Pictures the visible part of a tab. `captureVisibleTab` only works on the active tab of a
 * window, so the tab is brought to the front first and the previous one is restored afterwards.
 */
async function captureTabScreenshot(tabId: number): Promise<{ dataUrl: string } | { error: string }> {
  let previousTabId: number | null = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId === undefined) return { error: "That tab has no window." };
    const active = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    previousTabId = active[0]?.id ?? null;

    if (tab.active !== true) {
      await chrome.tabs.update(tabId, { active: true });
      // Give the page a moment to paint before it is photographed.
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    return { dataUrl };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (previousTabId !== null && previousTabId !== tabId) {
      await chrome.tabs.update(previousTabId, { active: true }).catch(() => {});
    }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  if ((message as { type?: string }).type === "taskify:open-panel") {
    chrome.windows.getCurrent().then((win) => {
      if (typeof win.id === "number") void openSidePanel(win.id);
    });
    return true;
  }
  if ((message as { type?: string }).type === "taskify:screenshot") {
    const tabId = (message as { tabId?: number }).tabId;
    if (typeof tabId !== "number") {
      sendResponse({ ok: false, error: "No tab to capture." });
      return true;
    }
    captureTabScreenshot(tabId).then((result) => {
      if ("dataUrl" in result) sendResponse({ ok: true, dataUrl: result.dataUrl });
      else sendResponse({ ok: false, error: result.error });
    });
    return true;
  }
  return false;
});

export {};
