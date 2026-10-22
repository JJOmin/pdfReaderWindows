import { randomBytes } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
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
import { newMemo, parseMemo, syncLibrary, type SyncMemo } from './engine';
import { WebDavStore, nextcloudDavBase, nextcloudLogin } from './webdav';

export interface SyncOptions {
  /** `sync.json` in the user data folder. */
  configPath: string;
  /** What a sync remembers for the next one (the change journals of ADR 10). */
  memoPath: string;
  /** The phone library of ADR 7. */
  libraryRoot: string;
  /** This computer's name, as the other devices show it. */
  deviceName: string;
  /** Encrypts the secrets with what the operating system keeps for this user. */
  box: { encrypt(text: string): string; decrypt(text: string): string };
  /** Opens an address in the user's own browser. */
  openUrl(url: string): void;
  /** A document's notes changed here because of a sync: one that is open should show them. */
  onNotesChanged?(docId: string): void;
}

/**
 * The sign-in and the secrets, and the one place that turns "the user chose Nextcloud" into a
 * store. Everything the renderer asks passes through here, and it is checked here.
 */
export class SyncManager {
  private signingIn: AbortController | undefined;
  private running = false;

  constructor(private readonly options: SyncOptions) {}

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
    return { backend: config.backend, account, auto: config.auto };
  }

  private device: Promise<string> | undefined;

  /**
   * This computer's id. It names its place in the phone library (step S6) and in the store, so
   * both kinds of sync agree on who wrote it. Kept from the first time it is asked for.
   */
  deviceId(): Promise<string> {
    return (this.device ??= this.load().then(async ({ config, secrets }) => {
      try {
        await this.save(config, secrets);
      } catch {
        // Without the system's secret store the id lasts this session only.
      }
      return config.deviceId;
    }));
  }

  async getStatus(): Promise<SyncStatus> {
    return this.status((await this.load()).config);
  }

  async connect(backend: unknown, server: unknown): Promise<SyncStatus> {
    if (backend !== 'nextcloud') throw new Error('Unknown sync service');
    this.signingIn?.abort();
    const attempt = (this.signingIn = new AbortController());
    try {
      const { config, secrets } = await this.load();
      secrets.key ??= formatSyncKey(newSyncKey());
      const url = typeof server === 'string' ? parseServerUrl(server) : null;
      if (!url) throw new Error('Enter the address of your Nextcloud, for example https://cloud.example.com');
      const login = await nextcloudLogin(url, this.options.openUrl, attempt.signal);
      Object.assign(config, { backend, server: url.href.replace(/\/$/u, ''), user: login.user });
      secrets.password = login.password;
      await this.save(config, secrets);
      await this.forget();
      return this.status(config);
    } finally {
      if (this.signingIn === attempt) this.signingIn = undefined;
    }
  }

  /** Switches syncing on its own on or off. It stays so across restarts. */
  async setAuto(on: unknown): Promise<SyncStatus> {
    if (typeof on !== 'boolean') throw new Error('Expected on or off');
    const { config, secrets } = await this.load();
    config.auto = on;
    await this.save(config, secrets);
    return this.status(config);
  }

  /** The documents the user stopped syncing. */
  async stopped(): Promise<string[]> {
    return (await this.load()).config.stopped;
  }

  /** Stops or resumes syncing one document. It stays prepared; only the store does not get it. */
  async setStopped(docId: unknown, stop: unknown): Promise<string[]> {
    if (typeof docId !== 'string' || !/^[0-9a-f]{64}$/u.test(docId) || typeof stop !== 'boolean') {
      throw new Error('Expected a document and on or off');
    }
    const { config, secrets } = await this.load();
    const others = config.stopped.filter((id) => id !== docId);
    config.stopped = stop ? [...others, docId] : others;
    await this.save(config, secrets);
    return config.stopped;
  }

  cancel(): void {
    this.signingIn?.abort();
  }

  async disconnect(): Promise<SyncStatus> {
    const { config, secrets } = await this.load();
    Object.assign(config, { backend: 'none', server: '', user: '' });
    // The key stays, so signing in again finds the files that are already in the store.
    await this.save(config, { key: secrets.key });
    await this.forget();
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
    await this.forget();
    return secrets.key;
  }

  /** A sync after a new account or key must walk everything, since the memo describes another store. */
  private forget(): Promise<void> {
    return rm(this.options.memoPath, { force: true });
  }

  private async loadMemo(): Promise<SyncMemo> {
    try {
      return parseMemo(JSON.parse(await readFile(this.options.memoPath, 'utf8')));
    } catch {
      return newMemo();
    }
  }

  private store(config: SyncConfig, secrets: SyncSecrets): SyncStore {
    if (config.backend === 'nextcloud' && secrets.password) {
      return new WebDavStore(nextcloudDavBase(config.server, config.user), config.user, secrets.password);
    }
    throw new Error('Sign in to a sync service first');
  }

  /** `full` walks the whole store instead of what the journals say changed. */
  async run(full = false): Promise<SyncReport> {
    if (this.running) throw new Error('Syncing is already running');
    this.running = true;
    try {
      const { config, secrets } = await this.load();
      const store = this.store(config, secrets);
      const key = parseSyncKey(secrets.key ?? '');
      if (!key) throw new Error('There is no sync key');
      const memo = await this.loadMemo();
      const report = await syncLibrary(store, key, this.options.libraryRoot, config.deviceId, {
        memo,
        full,
        stopped: new Set(config.stopped),
        name: this.options.deviceName,
        onNotesChanged: this.options.onNotesChanged,
      });
      // Saved only when the sync finished, so a failed one is repeated from the same journals.
      await writeFile(this.options.memoPath, JSON.stringify(memo));
      return report;
    } finally {
      this.running = false;
    }
  }
}
