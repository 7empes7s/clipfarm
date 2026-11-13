import { NOT_AVAILABLE } from "../../shared/growth";

/** A number for a tile or a cell; a number the platform did not give reads "not available", never 0. */
export function shown(value: number | null, format: (n: number) => string = (n) => n.toLocaleString("en")): string {
  return value === null ? NOT_AVAILABLE : format(value);
}

/** 12.4 → "12", 3.25 → "3.3": views per hour and the like. */
export function rate(n: number): string {
  return n >= 10 ? Math.round(n).toLocaleString("en") : (Math.round(n * 10) / 10).toString();
}

/** "HH:MM" on this device's clock ↔ "HH:MM" UTC (campaign times are kept in UTC). */
export function shiftTime(time: string, to: "utc" | "local", offsetMin = new Date().getTimezoneOffset()): string {
  const [h, m] = time.split(":").map(Number);
  const total = (((h! * 60 + m! + (to === "utc" ? offsetMin : -offsetMin)) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
