export const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export const str = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return v.toString();
  return JSON.stringify(v);
};

export const fmt = (n: number, d = 0): string => n.toLocaleString(undefined, { maximumFractionDigits: d });
export const pct = (n: number): string => (n > 0 && n < 0.1 ? "<0.1%" : `${fmt(n, n < 10 ? 1 : 0)}%`);
export const ms = (n: number): string => (n >= 1000 ? `${fmt(n / 1000, 1)} s` : `${fmt(n)} ms`);
export const bytes = (n: number): string => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${fmt(v, v < 10 ? 1 : 0)} ${units[i]}`;
};

const TRANSIENT_TEXT = /timeout|timed out|deadline|connection refused|connection reset|unavailable|temporar|try again|too many requests|\b(408|429|502|503|504)\b/i;
/** Log patterns / messages that look transient (retryable) rather than a hard fault. */
export const isTransientText = (s: string): boolean => TRANSIENT_TEXT.test(s);

export const idsOf = (v: unknown): string[] => {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => str(x));
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).flatMap(idsOf);
  return [];
};
