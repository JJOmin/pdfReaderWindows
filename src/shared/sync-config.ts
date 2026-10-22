// Dropbox was removed for now (ADR 10); a file that still names it reads as signed out.
export const BACKENDS = ['none', 'nextcloud'] as const;
export type Backend = (typeof BACKENDS)[number];

/** What `sync.json` holds in the clear. Everything secret is in `secrets`, encrypted by the system. */
export interface SyncConfig {
  /** Names this computer's state file in the store. */
  deviceId: string;
  backend: Backend;
  /** Nextcloud only. */
  server: string;
  user: string;
  secrets: string;
}

/** The secrets, as JSON inside `SyncConfig.secrets`. */
export interface SyncSecrets {
  /** The key that encrypts every file in the store, as `formatSyncKey` writes it. */
  key?: string;
  /** A Nextcloud app password. */
  password?: string;
}

const DEVICE_ID = /^[0-9a-f]{32}$/;

const text = (value: unknown, max: number): string =>
  typeof value === 'string' && value.length <= max ? value : '';

/** Reads `sync.json`. A missing or damaged file means nothing is connected. */
export function parseSyncConfig(value: unknown, newDeviceId: () => string): SyncConfig {
  const input = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const backend = BACKENDS.find((b) => b === input.backend) ?? 'none';
  return {
    deviceId:
      typeof input.deviceId === 'string' && DEVICE_ID.test(input.deviceId) ? input.deviceId : newDeviceId(),
    backend,
    server: text(input.server, 2048),
    user: text(input.user, 256),
    secrets: text(input.secrets, 16_384),
  };
}

export function parseSyncSecrets(value: unknown): SyncSecrets {
  const input = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const secrets: SyncSecrets = {};
  for (const field of ['key', 'password'] as const) {
    const entry = text(input[field], 4096);
    if (entry) secrets[field] = entry;
  }
  return secrets;
}
