/**
 * What to tell someone whose push setup failed. A push service refusal is the browser's own
 * service declining, before Taskify's servers are asked, so the advice depends on the browser.
 */
export type PushBrowser = "brave" | "chromium" | "safari" | "other";

/** Brave reports Chrome's user agent; it is told apart by `navigator.brave`. */
export function detectPushBrowser(nav: { userAgent?: string; brave?: unknown } | undefined): PushBrowser {
  if (!nav) return "other";
  if (nav.brave) return "brave";
  const ua = typeof nav.userAgent === "string" ? nav.userAgent.toLowerCase() : "";
  if (/chrome\/|chromium\/|crios\/|edg\//.test(ua)) return "chromium";
  if (/safari\//.test(ua) && /version\//.test(ua)) return "safari";
  return "other";
}

function pushServiceRefusal(browser: PushBrowser): string {
  switch (browser) {
    case "brave":
      return "Brave has its push service turned off. Turn on “Use Google services for push messaging” in brave://settings/privacy, relaunch Brave if it asks, and try again.";
    case "chromium":
      return "This browser couldn't reach its push service. Some Chromium browsers don't include one, and a VPN or firewall can block it. Try again, or use Chrome or Safari.";
    case "safari":
      return "The browser's push service rejected the registration. Check that notifications are allowed for this site (Safari → Settings → Websites → Notifications on macOS) and try again.";
    case "other":
      return "The browser's push service rejected the registration. Check that notifications are allowed for this site and try again.";
  }
}

export function describePushError(err: unknown, browser: PushBrowser): string {
  if (!(err instanceof Error)) return "Failed to enable push notifications.";
  const message = err.message || "Failed to enable push notifications.";
  const lower = message.toLowerCase();
  if (lower.includes("push service error")) return pushServiceRefusal(browser);
  if (lower.includes("not allowed")) {
    return "The browser blocked the subscription request. Grant notification permission and try again.";
  }
  if (lower.includes("secure context")) {
    return "Push notifications require HTTPS (or localhost during development). Reload the app over a secure origin and try again.";
  }
  if (lower.includes("invalid vapid public key")) {
    return "The configured VAPID public key appears to be invalid. Update both the Worker and the app with matching VAPID keys.";
  }
  return message;
}
