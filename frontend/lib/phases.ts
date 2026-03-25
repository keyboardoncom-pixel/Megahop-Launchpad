export type Phase = {
  id: number;
  name: string;
  priceEth: string;
  limitPerWallet: number;
  startsAt?: number;
  endsAt?: number;
  allowlistEnabled?: boolean;
  allowlistRoot?: string;
};

export const getPhaseStatus = (phase: Phase, now: Date = new Date()) => {
  const nowMs = now.getTime();
  const startMs = phase.startsAt ? phase.startsAt * 1000 : null;
  const endMs = phase.endsAt ? phase.endsAt * 1000 : null;

  if (!startMs && !endMs) return "live";
  if (startMs && nowMs < startMs) return "upcoming";
  if (endMs && nowMs > endMs) return "ended";
  if (startMs || endMs) return "live";
  return "tbd";
};

export const formatPhaseWindow = (phase: Phase) => {
  const formatDate = (unix?: number) =>
    unix
      ? new Date(unix * 1000).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
          hour12: true,
        })
      : "";
  const start = formatDate(phase.startsAt);
  const end = formatDate(phase.endsAt);
  if (start && end) return `${start} → ${end}`;
  if (start) return `Starts ${start}`;
  if (end) return `Ends ${end}`;
  return "Open-ended";
};

export const toInputDateTime = (unixSeconds?: number) => {
  if (!unixSeconds) return "";
  const date = new Date(unixSeconds * 1000);
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
};

export const fromInputDateTime = (value: string) => {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) return 0;
  return Math.floor(ms / 1000);
};
