import { UsageError } from "./process.ts";

export function parseDuration(text: string): number {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text);
  if (!text || !match) throw new UsageError(`not a duration: ${text} (use 30m, 2h, 1h30m)`);
  const minutes = Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
  if (minutes <= 0) throw new UsageError(`duration must be positive: ${text}`);
  return minutes;
}

export function formatMinutes(minutes: number): string {
  const whole = Math.max(0, Math.floor(minutes));
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}

export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
