// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { WheelTimePicker } from "./WheelTimePicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
});

async function render(value: string, onChange = vi.fn(), fallback?: string) {
  const host = document.createElement("div");
  root = createRoot(host);
  await act(async () => root!.render(<WheelTimePicker value={value} fallback={fallback} onChange={onChange} />));
  const column = (label: string) => host.querySelector(`[aria-label="${label}"]`)!;
  const active = (label: string) => column(label).querySelector(".is-active")?.textContent;
  const pick = async (label: string, text: string) => {
    const option = [...column(label).querySelectorAll('[role="option"]')].find((node) => node.textContent === text) as HTMLElement;
    await act(async () => option.click());
  };
  return { active, pick, onChange };
}

test("shows the value on the wheels, in 12-hour time", async () => {
  const picker = await render("14:30");
  expect(picker.active("Select hour")).toBe("02");
  expect(picker.active("Select minute")).toBe("30");
  expect(picker.active("Select AM or PM")).toBe("PM");
});

test("an empty value shows the fallback", async () => {
  const picker = await render("", vi.fn(), "10:00");
  expect(picker.active("Select hour")).toBe("10");
  expect(picker.active("Select AM or PM")).toBe("AM");
});

test("tapping an option commits the whole time", async () => {
  const picker = await render("14:30");
  await picker.pick("Select hour", "05");
  expect(picker.onChange).toHaveBeenLastCalledWith("17:30");
  await picker.pick("Select AM or PM", "AM");
  expect(picker.onChange).toHaveBeenLastCalledWith("05:30");
});

test("picking the current option does not report a change", async () => {
  const picker = await render("14:30");
  await picker.pick("Select minute", "30");
  expect(picker.onChange).not.toHaveBeenCalled();
});
