import { ethers } from "ethers";

export const LAUNCHPAD_UI_SETTINGS_EVENT = "launchpad-ui-settings-updated";

export type LaunchpadUiDefaults = {
  collectionName: string;
  collectionDescription: string;
  collectionBannerUrl: string;
  collectionWebsite: string;
  collectionTwitter: string;
};

export type LaunchpadUiSettings = LaunchpadUiDefaults & {
  updatedAt: number;
};

const STORAGE_PREFIX = "launchpad-ui";

const sanitizeString = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const clampText = (value: unknown, maxLen: number) => sanitizeString(value).slice(0, maxLen);
const toSafeUpdatedAt = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

export const MAX_LAUNCHPAD_UI_LENGTHS = {
  collectionName: 120,
  collectionDescription: 2400,
  collectionBannerUrl: 2048,
  collectionWebsite: 512,
  collectionTwitter: 512,
} as const;

export const getLaunchpadUiStorageKey = (
  contractAddress?: string,
  chainId?: number | null
) => {
  const normalizedContract = sanitizeString(contractAddress).toLowerCase() || "unknown";
  const normalizedChainId = chainId ?? "unknown";
  return `${STORAGE_PREFIX}:${normalizedContract}:${normalizedChainId}`;
};

export const normalizeLaunchpadUiDefaults = (
  raw: Partial<LaunchpadUiDefaults> | null | undefined,
  fallback: LaunchpadUiDefaults
): LaunchpadUiDefaults => ({
  collectionName:
    clampText(raw?.collectionName, MAX_LAUNCHPAD_UI_LENGTHS.collectionName) ||
    clampText(fallback.collectionName, MAX_LAUNCHPAD_UI_LENGTHS.collectionName),
  collectionDescription:
    clampText(raw?.collectionDescription, MAX_LAUNCHPAD_UI_LENGTHS.collectionDescription) ||
    clampText(
      fallback.collectionDescription,
      MAX_LAUNCHPAD_UI_LENGTHS.collectionDescription
    ),
  collectionBannerUrl: clampText(
    raw?.collectionBannerUrl,
    MAX_LAUNCHPAD_UI_LENGTHS.collectionBannerUrl
  ),
  collectionWebsite: clampText(raw?.collectionWebsite, MAX_LAUNCHPAD_UI_LENGTHS.collectionWebsite),
  collectionTwitter: clampText(raw?.collectionTwitter, MAX_LAUNCHPAD_UI_LENGTHS.collectionTwitter),
});

export const buildDefaultLaunchpadUiSettings = (
  defaults: LaunchpadUiDefaults
): LaunchpadUiSettings => ({
  ...normalizeLaunchpadUiDefaults(defaults, defaults),
  updatedAt: 0,
});

export const toLaunchpadUiSettings = (
  raw: Partial<LaunchpadUiSettings> | null | undefined,
  defaults: LaunchpadUiDefaults
): LaunchpadUiSettings => {
  const normalized = normalizeLaunchpadUiDefaults(raw, defaults);
  return {
    ...normalized,
    updatedAt: toSafeUpdatedAt(raw?.updatedAt),
  };
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    return `{${entries
      .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export const buildLaunchpadUiPayloadHash = (settings: LaunchpadUiDefaults) =>
  ethers.utils.keccak256(ethers.utils.toUtf8Bytes(stableStringify(settings)));

export const buildLaunchpadUiPublishMessage = (params: {
  contractAddress: string;
  chainId: number;
  payloadHash: string;
  timestamp: number;
}) =>
  [
    "Megahop Launchpad UI Publish",
    `contract:${sanitizeString(params.contractAddress).toLowerCase()}`,
    `chainId:${params.chainId}`,
    `payloadHash:${sanitizeString(params.payloadHash).toLowerCase()}`,
    `timestamp:${params.timestamp}`,
  ].join("\n");

export const loadLaunchpadUiSettings = (
  storageKey: string,
  defaults: LaunchpadUiDefaults
): LaunchpadUiSettings => {
  const fallback = buildDefaultLaunchpadUiSettings(defaults);
  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return fallback;
    }
    return toLaunchpadUiSettings(JSON.parse(raw), defaults);
  } catch {
    return fallback;
  }
};

export const saveLaunchpadUiSettings = (
  storageKey: string,
  settings: LaunchpadUiSettings
) => {
  if (typeof window === "undefined") {
    return;
  }

  const normalized = {
    ...toLaunchpadUiSettings(settings, settings),
    updatedAt: toSafeUpdatedAt(settings.updatedAt) || Date.now(),
  };
  window.localStorage.setItem(storageKey, JSON.stringify(normalized));
  window.dispatchEvent(
    new CustomEvent(LAUNCHPAD_UI_SETTINGS_EVENT, {
      detail: {
        key: storageKey,
      },
    })
  );
};
