import { useEffect, useState } from "react";

function readMediaQuery(query: string, defaultValue: boolean): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return defaultValue;
  }
  return window.matchMedia(query).matches;
}

export function useWalletMediaQuery(query: string, defaultValue = false): boolean {
  const [matches, setMatches] = useState(() => readMediaQuery(query, defaultValue));

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mediaQuery = window.matchMedia(query);
    const handleChange = (event: MediaQueryListEvent) => {
      setMatches(event.matches);
    };
    setMatches(mediaQuery.matches);
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }
    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, [query]);

  return matches;
}
