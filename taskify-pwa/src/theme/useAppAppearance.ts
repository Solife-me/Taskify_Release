import { useEffect } from "react";
import type { AccentPalette } from "./palette";
import type { Settings } from "../domains/tasks/settingsTypes";

const CUSTOM_ACCENT_VARIABLES: ReadonlyArray<[string, keyof AccentPalette]> = [
  ["--accent", "fill"],
  ["--accent-hover", "hover"],
  ["--accent-active", "active"],
  ["--accent-soft", "soft"],
  ["--accent-border", "border"],
  ["--accent-on", "on"],
  ["--accent-glow", "glow"],
];

function gradientFromPalette(palette: AccentPalette, hasImage: boolean): string {
  const primary = hexToRgba(palette.fill, 0.24);
  const secondary = hexToRgba(palette.fill, 0.14);
  const baseAlpha = hasImage ? 0.65 : 0.95;
  return `radial-gradient(circle at 18% -10%, ${primary}, transparent 60%),` +
    `radial-gradient(circle at 82% -12%, ${secondary}, transparent 65%),` +
    `rgba(6, 9, 18, ${baseAlpha})`;
}

function hexToRgba(hex: string, alpha: number): string {
  let value = hex.replace(/^#/, "");
  if (value.length === 3) {
    value = value.split("").map(ch => ch + ch).join("");
  }
  const int = parseInt(value.slice(0, 6), 16);
  if (Number.isNaN(int)) {
    return `rgba(52, 199, 89, ${Math.min(1, Math.max(0, alpha))})`;
  }
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  const clampedAlpha = Math.min(1, Math.max(0, alpha));
  return `rgba(${r}, ${g}, ${b}, ${clampedAlpha})`;
}


type AppearanceSettings = Pick<Settings, "baseFontSize" | "accent" | "backgroundAccent" | "backgroundImage" | "backgroundBlur">;

export function useAppAppearance(settings: AppearanceSettings): void {
  // Apply font size setting to root; fall back to default size
  useEffect(() => {
    try {
      const base = settings.baseFontSize;
      if (typeof base === "number" && base >= 12) {
        const px = Math.min(22, base);
        document.documentElement.style.fontSize = `${px}px`;
      } else {
        document.documentElement.style.fontSize = "";
      }
    } catch {}
  }, [settings.baseFontSize]);

  // Ensure the app always renders with the dark theme
  useEffect(() => {
    try {
      const root = document.documentElement;
      root.classList.remove("light");
      if (!root.classList.contains("dark")) root.classList.add("dark");
    } catch {}
  }, []);

  useEffect(() => {
    try {
      const root = document.documentElement;
      const rootStyle = getComputedStyle(root);
      let color = rootStyle.getPropertyValue("--surface-base").trim() || "#050508";
      if (settings.backgroundImage && settings.backgroundAccent) {
        color = settings.backgroundAccent.fill || settings.backgroundAccent.active || color;
      } else if (settings.accent === "background" && settings.backgroundAccent) {
        color = settings.backgroundAccent.fill || settings.backgroundAccent.active || color;
      }
      root.style.setProperty("--status-bar-color", color);
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", color);
    } catch {}
  }, [settings.accent, settings.backgroundAccent, settings.backgroundImage]);

  useEffect(() => {
    try {
      const root = document.documentElement;
      const style = root.style;
      if (settings.accent === "green") root.setAttribute("data-accent", "green");
      else root.removeAttribute("data-accent");

      const palette = settings.accent === "background" ? settings.backgroundAccent ?? null : null;
      const hasBackgroundImage = Boolean(settings.backgroundImage);
      for (const [cssVar, key] of CUSTOM_ACCENT_VARIABLES) {
        if (palette) style.setProperty(cssVar, palette[key]);
        else style.removeProperty(cssVar);
      }
      if (palette) {
        style.setProperty("--background-gradient", gradientFromPalette(palette, hasBackgroundImage));
      } else {
        style.removeProperty("--background-gradient");
      }
    } catch (err) {
      console.error('Failed to apply accent palette', err);
    }
  }, [settings.accent, settings.backgroundAccent, settings.backgroundImage]);

  useEffect(() => {
    let blobUrl: string | null = null;
    try {
      const root = document.documentElement;
      const style = root.style;
      if (settings.backgroundImage) {
        root.setAttribute("data-background-image", "true");

        // Convert base64 data URL → blob URL so the browser can memory-map the
        // image once and all CSS pseudo-elements share the same decoded bitmap
        // instead of each independently decoding the base64.
        try {
          const dataUrl = settings.backgroundImage;
          const commaIdx = dataUrl.indexOf(",");
          if (commaIdx === -1) throw new Error("Invalid data URL");
          const header = dataUrl.slice(0, commaIdx);
          const b64 = dataUrl.slice(commaIdx + 1);
          const mimeMatch = header.match(/data:([^;]+)/);
          const mime = mimeMatch?.[1] ?? "image/jpeg";
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const blob = new Blob([bytes], { type: mime });
          blobUrl = URL.createObjectURL(blob);
          style.setProperty("--background-image", `url("${blobUrl}")`);
        } catch {
          // Fallback to raw base64 if blob conversion fails
          style.setProperty("--background-image", `url("${settings.backgroundImage}")`);
        }

        style.setProperty("--background-image-opacity", "1");
        const blurMode = settings.backgroundBlur;
        const overlay = blurMode === "sharp" ? "0.1" : "0.18";
        style.setProperty("--background-overlay-opacity", overlay);
        style.setProperty("--background-image-filter", blurMode === "sharp" ? "none" : "blur(36px)");
        style.setProperty("--background-image-scale", blurMode === "sharp" ? "1.02" : "1.08");
      } else {
        root.removeAttribute("data-background-image");
        style.removeProperty("--background-image");
        style.removeProperty("--background-image-opacity");
        style.removeProperty("--background-overlay-opacity");
        style.removeProperty("--background-image-filter");
        style.removeProperty("--background-image-scale");
      }
    } catch (err) {
      console.error('Failed to apply background image', err);
    }
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [settings.backgroundImage, settings.backgroundBlur]);

}
