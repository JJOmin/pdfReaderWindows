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
  /** Sync on its own (ADR 10 section 3). On unless the user switched it off. */
  auto: boolean;
  /** Documents the user stopped syncing: they stay prepared but are not sent to the store. */
  stopped: string[];
}

/** The secrets, as JSON inside `SyncConfig.secrets`. */
export interface SyncSecrets {
  /** The key that encrypts every file in the store, as `formatSyncKey` writes it. */
  key?: string;
  /** A Nextcloud app password. */
  password?: string;
}

const DEVICE_ID = /^[0-9a-f]{32}$/;
const DOC_ID = /^[0-9a-f]{64}$/;

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
    auto: input.auto !== false,
    stopped: Array.isArray(input.stopped)
      ? input.stopped.filter((id): id is string => typeof id === 'string' && DOC_ID.test(id))
      : [],
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
