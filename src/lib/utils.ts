import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind class names with correct precedence. The shadcn/ui standard
 * helper: `clsx` resolves conditionals, `tailwind-merge` dedupes conflicting
 * utilities (e.g. `px-2 px-4` → `px-4`).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const currencyCentsFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const percentFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Format a dollar amount with no cents (used for large summary figures). */
export function formatCurrency(value: number): string {
  if (!Number.isFinite(value)) return "$0";
  return currencyFormatter.format(value);
}

/** Format a dollar amount including cents (used for monthly payments). */
export function formatCurrencyCents(value: number): string {
  if (!Number.isFinite(value)) return "$0.00";
  return currencyCentsFormatter.format(value);
}

/** Format a 0–1 ratio as a percentage, e.g. 0.8 → "80.00%". */
export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return "0%";
  return percentFormatter.format(ratio);
}

/** Format a human-readable byte size, e.g. 1536 → "1.5 KB". */
export function formatBytes(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

/** Clamp a number into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Generate a reasonably-unique id without a crypto dependency. Used for
 * client-side annotation/scenario ids; collisions are practically impossible
 * for the scale this app operates at.
 */
export function uid(prefix = "id"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.floor(
    Math.random() * 1e9,
  ).toString(36)}`;
}

/**
 * Trailing-edge debounce. Returns a stable callable plus a `.cancel()` to
 * tear down pending timers (important for React effect cleanup).
 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  delayMs: number,
): { (...args: A): void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return debounced;
}
