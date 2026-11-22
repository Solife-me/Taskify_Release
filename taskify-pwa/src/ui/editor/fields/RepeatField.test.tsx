// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { RepeatField } from "./RepeatField";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

test("a legacy task displays its daily rule and only offers day-or-longer choices", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  const untilISO = "2026-12-31T00:00:00.000Z";
  try {
    await act(async () => root.render(
      <RepeatField
        rule={{ type: "every", n: 1, unit: "hour", untilISO }}
        onChange={onChange}
        anchorDate="2026-11-01"
        timeZone="UTC"
      />,
    ));
    const repeat = container.querySelector("button");
    expect(repeat?.textContent).toContain("Daily");
    await act(async () => repeat?.click());
    const presets = [...document.querySelectorAll<HTMLButtonElement>(".sheet-panel button")];
    expect(presets.some((button) => button.textContent?.includes("Daily"))).toBe(true);
    expect(presets.some((button) => button.textContent?.includes("Hourly"))).toBe(false);
    const advanced = presets.find((button) => button.textContent?.includes("Advanced recurrence"));
    await act(async () => advanced?.click());
    expect([...container.querySelectorAll("select option")].map((option) => option.textContent)).toEqual(["Days", "Weeks"]);
    const apply = [...container.querySelectorAll("button")].find((button) => button.textContent === "Apply");
    await act(async () => apply?.click());
    expect(onChange).toHaveBeenCalledWith({ type: "daily", untilISO });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
