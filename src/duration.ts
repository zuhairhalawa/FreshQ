import { FreshQError } from "./errors.js";

const UNIT_MS = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
} as const;

/** Longest supported lookback. Longer windows make exhaustive searching expensive. */
export const MAX_SINCE_MS = 30 * UNIT_MS.d;

/** Parse a duration such as `30m`, `1h`, `2h`, `24h`, `7d`, `2w` into milliseconds. */
export function parseDuration(input: string): number {
  const match = /^(\d{1,4})([mhdw])$/.exec(input.trim().toLowerCase());
  if (!match) {
    throw new FreshQError(
      "usage",
      `Invalid --since value "${input}".`,
      "Use a number followed by m, h, d or w - for example 30m, 1h, 2h, 24h or 7d.",
    );
  }
  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof UNIT_MS;
  const ms = amount * UNIT_MS[unit];
  if (ms <= 0) {
    throw new FreshQError("usage", `--since must be greater than zero (got "${input}").`);
  }
  if (ms > MAX_SINCE_MS) {
    throw new FreshQError("usage", `--since "${input}" is longer than the supported maximum of 30 days.`);
  }
  return ms;
}

/** Human-friendly age such as `just now`, `5m ago`, `3h 12m ago`, `2d 4h ago`. */
export function formatAge(createdAtMs: number, nowMs: number): string {
  const secs = Math.max(0, Math.floor((nowMs - createdAtMs) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rem = mins % 60;
    return rem === 0 ? `${hours}h ago` : `${hours}h ${rem}m ago`;
  }
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH === 0 ? `${days}d ago` : `${days}d ${remH}h ago`;
}
