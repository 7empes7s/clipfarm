// Light, dark, or whatever the phone is set to. The choice is kept on this device.

export const THEMES = ["auto", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_LABELS: Record<Theme, string> = { auto: "Same as this device", light: "Light", dark: "Dark" };

const KEY = "clipfarm-theme";

export function savedTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return THEMES.find((x) => x === t) ?? "auto";
  } catch {
    return "auto";
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "auto") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

export function saveTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    if (theme === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Private windows may refuse storage: the look still changes until the app is closed.
  }
}
