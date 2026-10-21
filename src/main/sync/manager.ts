import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import {
  parseSyncConfig,
  parseSyncSecrets,
  type SyncConfig,
  type SyncSecrets,
} from '../../shared/sync-config';
import {
  formatSyncKey,
  newSyncKey,
  parseServerUrl,
  parseSyncKey,
  type SyncStore,
} from '../../shared/sync-store';
import type { SyncReport, SyncStatus } from '../../shared/types';
import {
  DROPBOX_APP_KEY,
  DROPBOX_REDIRECT_PORT,
  DropboxStore,
  dropboxAuthorize,
  type DropboxHosts,
} from './dropbox';
import { syncLibrary } from './engine';
import { WebDavStore, nextcloudDavBase, nextcloudLogin } from './webdav';

export interface SyncOptions {
  /** `sync.json` in the user data folder. */
  configPath: string;
  /** The phone library of ADR 7. */
  libraryRoot: string;
  /** Encrypts the secrets with what the operating system keeps for this user. */
  box: { encrypt(text: string): string; decrypt(text: string): string };
  /** Opens an address in the user's own browser. */
  openUrl(url: string): void;
  dropboxKey?: string;
  dropboxHosts?: DropboxHosts;
  dropboxPort?: number;
}

/**
 * The sign-in and the secrets, and the one place that turns "the user chose Nextcloud" into a
 * store. Everything the renderer asks passes through here, and it is checked here.
 */
export class SyncManager {
  private signingIn: AbortController | undefined;
  private running = false;

  constructor(private readonly options: SyncOptions) {}

  private get dropboxKey(): string {
    return this.options.dropboxKey ?? DROPBOX_APP_KEY;
  }

  private async load(): Promise<{ config: SyncConfig; secrets: SyncSecrets }> {
    let file: unknown = null;
    try {
      file = JSON.parse(await readFile(this.options.configPath, 'utf8'));
    } catch {
      // No file yet, or one that is not ours: nothing is connected.
    }
    const config = parseSyncConfig(file, () => randomBytes(16).toString('hex'));
    let secrets: SyncSecrets = {};
    try {
      if (config.secrets) secrets = parseSyncSecrets(JSON.parse(this.options.box.decrypt(config.secrets)));
    } catch {
      // Secrets written for another user or computer cannot be opened; sign in again.
    }
    return { config, secrets };
  }

  private async save(config: SyncConfig, secrets: SyncSecrets): Promise<void> {
    const sealed = { ...config, secrets: this.options.box.encrypt(JSON.stringify(secrets)) };
    await writeFile(this.options.configPath, JSON.stringify(sealed, null, 2));
  }

  private status(config: SyncConfig): SyncStatus {
    const account = config.backend === 'nextcloud' ? `${config.user} at ${new URL(config.server).host}` : '';
    return { backend: config.backend, account, dropboxAvailable: this.dropboxKey !== '' };
  }

  async getStatus(): Promise<SyncStatus> {
    return this.status((await this.load()).config);
  }

  async connect(backend: unknown, server: unknown): Promise<SyncStatus> {
    if (backend !== 'nextcloud' && backend !== 'dropbox') throw new Error('Unknown sync service');
    this.signingIn?.abort();
    const attempt = (this.signingIn = new AbortController());
    try {
      const { config, secrets } = await this.load();
      secrets.key ??= formatSyncKey(newSyncKey());
      if (backend === 'nextcloud') {
        const url = typeof server === 'string' ? parseServerUrl(server) : null;
        if (!url)
          throw new Error('Enter the address of your Nextcloud, for example https://cloud.example.com');
        const login = await nextcloudLogin(url, this.options.openUrl, attempt.signal);
        Object.assign(config, {
          backend,
          server: url.href.replace(/\/$/u, ''),
          user: login.user,
        });
        secrets.password = login.password;
        delete secrets.refresh;
      } else {
        secrets.refresh = await dropboxAuthorize(
          this.dropboxKey,
          this.options.openUrl,
          attempt.signal,
          this.options.dropboxHosts,
          this.options.dropboxPort ?? DROPBOX_REDIRECT_PORT,
        );
        Object.assign(config, { backend, server: '', user: '' });
        delete secrets.password;
      }
      await this.save(config, secrets);
      return this.status(config);
    } finally {
      if (this.signingIn === attempt) this.signingIn = undefined;
    }
  }

  cancel(): void {
    this.signingIn?.abort();
  }

  async disconnect(): Promise<SyncStatus> {
    const { config, secrets } = await this.load();
    Object.assign(config, { backend: 'none', server: '', user: '' });
    // The key stays, so signing in again finds the files that are already in the store.
    await this.save(config, { key: secrets.key });
    return this.status(config);
  }

  async key(): Promise<string> {
    const { config, secrets } = await this.load();
    if (!secrets.key) {
      secrets.key = formatSyncKey(newSyncKey());
      await this.save(config, secrets);
    }
    return secrets.key;
  }

  async setKey(text: unknown): Promise<string> {
    const key = typeof text === 'string' ? parseSyncKey(text) : null;
    if (!key) throw new Error('A sync key is 64 hexadecimal digits');
    const { config, secrets } = await this.load();
    secrets.key = formatSyncKey(key);
    await this.save(config, secrets);
    return secrets.key;
  }

  private store(config: SyncConfig, secrets: SyncSecrets): SyncStore {
    if (config.backend === 'nextcloud' && secrets.password) {
      return new WebDavStore(nextcloudDavBase(config.server, config.user), config.user, secrets.password);
    }
    if (config.backend === 'dropbox' && secrets.refresh) {
      return new DropboxStore(this.dropboxKey, secrets.refresh, this.options.dropboxHosts);
    }
    throw new Error('Sign in to a sync service first');
  }

  async run(): Promise<SyncReport> {
    if (this.running) throw new Error('Syncing is already running');
    this.running = true;
    try {
      const { config, secrets } = await this.load();
      const store = this.store(config, secrets);
      const key = parseSyncKey(secrets.key ?? '');
      if (!key) throw new Error('There is no sync key');
      return await syncLibrary(store, key, this.options.libraryRoot, config.deviceId);
    } finally {
      this.running = false;
    }
  }
}
