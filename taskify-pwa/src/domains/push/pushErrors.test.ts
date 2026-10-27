import { expect, test } from "vitest";
import { describePushError, detectPushBrowser } from "./pushErrors";

const chromeUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const safariUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const firefoxUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15.0; rv:140.0) Gecko/20100101 Firefox/140.0";

// What Chromium's pushManager.subscribe() rejects with when its push service refuses.
const pushServiceError = Object.assign(new Error("Registration failed - push service error"), { name: "AbortError" });

test("Brave is told to turn on its push messaging setting, not sent to Safari's settings", () => {
  // Brave reports a Chrome user agent; it is told apart by navigator.brave.
  const browser = detectPushBrowser({ userAgent: chromeUA, brave: {} });
  expect(browser).toBe("brave");
  const message = describePushError(pushServiceError, browser);
  expect(message).toContain("Use Google services for push messaging");
  expect(message).toContain("brave://settings/privacy");
  expect(message).not.toContain("Safari");
});

test("other Chromium browsers hear that their push service could not be reached", () => {
  const browser = detectPushBrowser({ userAgent: chromeUA });
  expect(browser).toBe("chromium");
  const message = describePushError(pushServiceError, browser);
  expect(message).toMatch(/push service/i);
  expect(message).not.toContain("Safari →");
});

test("Safari keeps its own settings path", () => {
  const browser = detectPushBrowser({ userAgent: safariUA });
  expect(browser).toBe("safari");
  expect(describePushError(pushServiceError, browser)).toContain("Safari → Settings → Websites → Notifications");
});

test("a browser it cannot place gets advice that names no browser", () => {
  const browser = detectPushBrowser({ userAgent: firefoxUA });
  expect(browser).toBe("other");
  const message = describePushError(pushServiceError, browser);
  expect(message).toMatch(/notifications are allowed for this site/);
  expect(message).not.toMatch(/Safari|Brave|Chrome/);
});

test("errors other than a push service refusal keep their meaning", () => {
  expect(describePushError(new Error("The request is not allowed by the user agent or the platform in the current context."), "chromium"))
    .toBe("The browser blocked the subscription request. Grant notification permission and try again.");
  expect(describePushError(new Error("Invalid VAPID public key: Decoded key is too short"), "brave"))
    .toBe("The configured VAPID public key appears to be invalid. Update both the Worker and the app with matching VAPID keys.");
  expect(describePushError(new Error("Failed to register device (503)"), "safari")).toBe("Failed to register device (503)");
  expect(describePushError("not an error", "other")).toBe("Failed to enable push notifications.");
});
