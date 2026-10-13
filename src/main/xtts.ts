import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { requestKey, selectEvictions } from '../shared/render-cache';
import type { SynthRequest } from '../shared/types';

export type Priority = 'live' | 'background';

export interface XttsOptions {
  /** The program that starts the helper, and its arguments. */
  command: string;
  args: string[];
  cacheDir: string;
  /** Speaker names by the `sid` the app uses. */
  speakers: Record<number, string>;
  maxCacheBytes?: number;
  /** The helper is stopped after this long without a request, which gives the GPU memory back. */
  idleMs?: number;
  /** Rendered sentences between two checks that the cache still fits its limit. */
  trimEvery?: number;
}

interface Job {
  key: string;
  path: string;
  request: SynthRequest;
  priority: Priority;
  promise: Promise<string>;
  resolve(path: string): void;
  reject(error: Error): void;
}

interface Helper {
  process: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  /** The last lines it wrote to standard error, for an error message if it dies. */
  log: string[];
}

const DEFAULT_CACHE_BYTES = 2 * 1024 ** 3;
const DEFAULT_IDLE_MS = 10 * 60_000;
const DEFAULT_TRIM_EVERY = 25;

/**
 * The XTTS-v2 voice: a Python helper process that renders sentences into a cache folder.
 * A sentence is rendered once; asking again, in this session or the next, finds the file.
 * Requests run one at a time, and a sentence somebody is waiting for goes before one that is
 * only being prepared.
 */
export class Xtts {
  private helper: Helper | undefined;
  private readonly jobs = new Map<string, Job>();
  private readonly waiting: Job[] = [];
  private current: Job | undefined;
  /** The id the helper was given for `current`; an answer to any other id is stale. */
  private currentId = 0;
  private nextId = 1;
  /** Starts due, so that a cache left over from an earlier session is checked at once. */
  private sinceTrim = Infinity;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: XttsOptions) {
    mkdirSync(options.cacheDir, { recursive: true });
  }

  /** Where the audio of a request is, rendering it first if it is not there yet. */
  render(request: SynthRequest, priority: Priority): Promise<string> {
    const key = requestKey(request);
    const path = join(
      this.options.cacheDir,
      `${createHash('sha256').update(key).digest('hex').slice(0, 40)}.wav`,
    );

    if (existsSync(path)) {
      // Used now, so it is the last to go when the cache is trimmed.
      const now = new Date();
      utimesSync(path, now, now);
      return Promise.resolve(path);
    }
    const known = this.jobs.get(key);
    if (known) {
      if (priority === 'live') known.priority = 'live';
      return known.promise;
    }
    if (this.options.speakers[request.voice.sid] === undefined) {
      return Promise.reject(new Error(`No XTTS speaker ${request.voice.sid}`));
    }

    let resolve!: (path: string) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((res, rej) => ((resolve = res), (reject = rej)));
    const job: Job = { key, path, request, priority, promise, resolve, reject };
    this.jobs.set(key, job);
    this.waiting.push(job);
    void this.pump();
    return promise;
  }

  /** Stops the helper. A later request starts it again. */
  close(): void {
    clearTimeout(this.idleTimer);
    const helper = this.helper;
    this.helper = undefined;
    if (!helper) return;
    // Closing its input is the polite way: the helper leaves its loop and exits.
    helper.process.stdin.end();
    const kill = setTimeout(() => helper.process.kill(), 3000);
    kill.unref();
    helper.process.once('exit', () => clearTimeout(kill));
  }

  private start(): Helper {
    const child = spawn(this.options.command, this.options.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // Everything runs offline: the libraries must not look for their files on the network.
      env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONUTF8: '1' },
    });
    const log: string[] = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      log.push(...chunk.split(/\r?\n/u).filter(Boolean));
      log.splice(0, Math.max(0, log.length - 20));
    });

    let onReady!: () => void;
    let onFailed!: (error: Error) => void;
    const ready = new Promise<void>((res, rej) => ((onReady = res), (onFailed = rej)));
    // Nobody may be waiting on `ready` yet; the failure is reported through the jobs.
    ready.catch(() => undefined);
    const helper: Helper = { process: child, ready, log };

    const died = (reason: string): void => {
      const error = new Error(
        `The XTTS helper ${reason}${log.length ? `: ${log.slice(-4).join(' | ')}` : ''}`,
      );
      if (this.helper === helper) this.helper = undefined;
      onFailed(error);
      this.failAll(error, helper);
    };
    child.once('error', (error) => died(`could not be started (${error.message})`));
    child.once('exit', (code, signal) => died(`exited (${signal ?? `code ${code}`})`));

    createInterface({ input: child.stdout }).on('line', (line) => {
      let message: { id?: number | null; ready?: boolean; ok?: boolean; error?: string };
      try {
        message = JSON.parse(line);
      } catch {
        return; // Not ours: a library wrote to the wrong stream.
      }
      if (message.ready === true) onReady();
      else if (message.ready === false) onFailed(new Error(message.error ?? 'The XTTS helper did not start'));
      else this.answered(message);
    });
    return helper;
  }

  private answered(message: { id?: number | null; ok?: boolean; error?: string }): void {
    const job = this.current;
    if (!job || message.id === undefined || message.id !== this.currentId) return;
    this.current = undefined;
    this.jobs.delete(job.key);
    if (message.ok) {
      job.resolve(job.path);
      if (++this.sinceTrim >= (this.options.trimEvery ?? DEFAULT_TRIM_EVERY)) this.trim(job.path);
    } else {
      job.reject(new Error(message.error ?? 'XTTS could not speak this sentence'));
    }
    this.armIdle();
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.current || this.waiting.length === 0) return;
    // One at a time, a sentence somebody is waiting for before one being prepared.
    const index = Math.max(
      0,
      this.waiting.findIndex((job) => job.priority === 'live'),
    );
    const job = this.waiting.splice(index, 1)[0]!;
    this.current = job;
    try {
      this.helper ??= this.start();
      const helper = this.helper;
      await helper.ready;
      if (this.current !== job) return; // failed meanwhile, and already reported
      this.currentId = this.nextId++;
      helper.process.stdin.write(
        JSON.stringify({
          id: this.currentId,
          text: job.request.text,
          lang: job.request.lang,
          speaker: this.options.speakers[job.request.voice.sid],
          speed: job.request.speed,
          out: job.path,
        }) + '\n',
      );
    } catch (error) {
      // The helper never became ready. Everything waiting hears of it, and the next call retries.
      this.helper = undefined;
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    }
    this.armIdle();
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.current || this.waiting.length > 0) this.armIdle();
      else this.close();
    }, this.options.idleMs ?? DEFAULT_IDLE_MS);
    this.idleTimer.unref();
  }

  /** Rejects the job in progress and every job waiting. */
  private failAll(error: Error, helper?: Helper): void {
    if (helper && this.helper && this.helper !== helper) return;
    const jobs = [this.current, ...this.waiting].filter((job): job is Job => job !== undefined);
    this.current = undefined;
    this.waiting.length = 0;
    for (const job of jobs) {
      this.jobs.delete(job.key);
      job.reject(error);
    }
  }

  /** Deletes the least recently used files until the cache fits. `keep` was just rendered. */
  private trim(keep: string): void {
    this.sinceTrim = 0;
    try {
      const files = readdirSync(this.options.cacheDir)
        .filter((name) => name.endsWith('.wav') && join(this.options.cacheDir, name) !== keep)
        .map((name) => {
          const stat = statSync(join(this.options.cacheDir, name));
          return { name, size: stat.size, mtime: stat.mtimeMs };
        });
      for (const name of selectEvictions(files, this.options.maxCacheBytes ?? DEFAULT_CACHE_BYTES)) {
        unlinkSync(join(this.options.cacheDir, name));
      }
    } catch {
      // A cache that cannot be trimmed is still a cache.
    }
  }
}
