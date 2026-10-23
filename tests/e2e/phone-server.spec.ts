import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { request } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { codeMatches, parseAnnouncement, parsePairingUrl } from '../../src/shared/pairing.ts';

// Step S5 of ADR 7: a Node client stands in for the phone. Needs the fixture and the speech
// models, because the library it downloads is prepared first. Port 47613 must be free.
const fixture = join(import.meta.dirname, '../fixtures/sample.pdf');
const PORT = 47613;
const GROUP = '239.255.47.13';

let app: ElectronApplication | undefined;
let page: Page;
let dir: string;
const pageErrors: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pdfreader-server-'));
  copyFileSync(fixture, join(dir, 'sample.pdf'));
  const env: Record<string, string | undefined> = {
    ...process.env,
    PDFREADER_USER_DATA: join(dir, 'profile'),
  };
  delete env.ELECTRON_RUN_AS_NODE; // set by VS Code's extension host; would start Electron as plain Node
  app = await electron.launch({
    args: ['.', join(dir, 'sample.pdf'), '--mute-audio'],
    env: env as Record<string, string>,
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
});

test.afterAll(async () => {
  await app?.close();
});

interface Answer {
  status: number;
  body: Buffer;
  fingerprint: string;
}

/** One HTTPS request to the app, as the phone makes it: the certificate is checked by its fingerprint. */
function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        method,
        path,
        rejectUnauthorized: false,
        headers: {
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        const raw = (res.socket as TLSSocket).getPeerCertificate().raw;
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
            fingerprint: createHash('sha256').update(raw).digest('hex'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Waits for the app's UDP announcement, as the phone's Desktops screen does. */
function hearAnnouncement(): Promise<{ name: string; port: number }> {
  return new Promise((resolve, reject) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('No announcement within 10 s'));
    }, 10_000);
    socket.on('message', (message) => {
      const heard = parseAnnouncement(new Uint8Array(message));
      if (!heard) return;
      clearTimeout(timer);
      socket.close();
      resolve(heard);
    });
    // Joined on every interface, as the phone joins on its Wi-Fi: Windows delivers nothing to a
    // membership on the default interface alone.
    socket.bind(PORT, () => {
      for (const a of Object.values(networkInterfaces()).flat()) {
        if (a?.family === 'IPv4') socket.addMembership(GROUP, a.address);
      }
    });
  });
}

const device = randomBytes(16).toString('hex');
let token = '';
let code = '';
let docId = '';

test('a prepared document and phone sync switched on', async () => {
  await expect(page.locator('#page-info')).toHaveText('1 / 2');
  await page.click('#open-phone');
  await expect(page.locator('#lan-enabled')).not.toBeChecked();
  await expect(page.locator('#lan-on')).toBeHidden();
  await page.keyboard.press('Escape');
  // Rendered on its own since the document was opened (ADR 11).
  await expect(page.locator('#phone-progress')).toContainText('is ready', { timeout: 170_000 });
  docId = createHash('sha256').update(readFileSync(fixture)).digest('hex');

  const announced = hearAnnouncement();
  await page.click('#open-phone');
  await page.check('#lan-enabled');
  await expect(page.locator('#lan-code')).toHaveText(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/u);
  code = (await page.locator('#lan-code').textContent())!;
  expect(await announced).toMatchObject({ port: PORT });
});

test('the code proves the certificate, and a wrong code does not', async () => {
  const hello = await call('GET', '/v1/hello');
  expect(hello.status).toBe(200);
  expect(JSON.parse(hello.body.toString())).toMatchObject({ app: 'pdfreader', protocol: 2 });
  expect(codeMatches(hello.fingerprint, code)).toBe(true);
  const wrong = code.replace(/^./u, (c) => (c === 'A' ? 'B' : 'A'));
  expect(codeMatches(hello.fingerprint, wrong)).toBe(false);
});

test('pairing needs the user to accept, while the dialog is open', async () => {
  const asking = { device, name: 'Test phone' };
  const declined = call('POST', '/v1/pair', { body: asking });
  await expect(page.locator('#lan-ask-text')).toHaveText('Pair with Test phone?');
  await page.click('#lan-decline');
  expect((await declined).status).toBe(403);

  const accepted = call('POST', '/v1/pair', { body: asking });
  await page.click('#lan-accept');
  const answer = await accepted;
  expect(answer.status).toBe(200);
  token = (JSON.parse(answer.body.toString()) as { token: string }).token;
  expect(token).toMatch(/^[0-9a-f]{64}$/u);
  await expect(page.locator('#lan-phones li')).toContainText('Test phone');
  // A paired phone and a prepared document: the sync button says everything is there.
  await expect(page.locator('#open-phone')).toHaveAttribute('data-state', 'done');

  await page.keyboard.press('Escape');
  await expect(page.locator('#phone')).toBeHidden();
  expect((await call('POST', '/v1/pair', { body: asking })).status).toBe(404);
});

test('a phone that read the QR code pairs without a click, once, and not after the dialog closed', async () => {
  await page.click('#open-phone');
  await expect(page.locator('#lan-qr')).toBeVisible();
  const url = parsePairingUrl((await page.locator('#lan-qr').getAttribute('data-url'))!);
  expect(url).toMatchObject({ code, name: expect.any(String) });
  expect(url!.addresses.length).toBeGreaterThan(0);

  const scanner = randomBytes(16).toString('hex');
  const paired = await call('POST', '/v1/pair', {
    body: { device: scanner, name: 'Scanning phone', secret: url!.secret },
  });
  expect(paired.status).toBe(200);
  expect((JSON.parse(paired.body.toString()) as { token: string }).token).toMatch(/^[0-9a-f]{64}$/u);
  await expect(page.locator('#lan-ask')).toBeHidden();
  await expect(page.locator('#lan-phones li', { hasText: 'Scanning phone' })).toHaveCount(1);

  // The secret is used up, and a made-up one never worked.
  const again = await call('POST', '/v1/pair', {
    body: { device: scanner, name: 'Scanning phone', secret: url!.secret },
  });
  expect(again.status).toBe(403);
  const guess = await call('POST', '/v1/pair', {
    body: { device: scanner, name: 'Scanning phone', secret: 'f'.repeat(32) },
  });
  expect(guess.status).toBe(403);
  // The picture changed with it.
  await expect
    .poll(async () => parsePairingUrl((await page.locator('#lan-qr').getAttribute('data-url'))!)?.secret)
    .not.toBe(url!.secret);

  const fresh = parsePairingUrl((await page.locator('#lan-qr').getAttribute('data-url'))!)!;
  await page.keyboard.press('Escape');
  await expect(page.locator('#phone')).toBeHidden();
  const late = await call('POST', '/v1/pair', {
    body: { device: scanner, name: 'Scanning phone', secret: fresh.secret },
  });
  expect(late.status).toBe(404);
  await page.click('#open-phone');
  const reopened = parsePairingUrl((await page.locator('#lan-qr').getAttribute('data-url'))!)!;
  expect(reopened.secret).not.toBe(fresh.secret);
  await page
    .locator('#lan-phones li', { hasText: 'Scanning phone' })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(page.locator('#lan-phones li')).toHaveCount(1);
  await page.keyboard.press('Escape');
});

test('a paired phone downloads the library byte for byte, and an unknown token gets nothing', async () => {
  const library = await call('GET', '/v1/library', { token });
  expect(library.status).toBe(200);
  expect(JSON.parse(library.body.toString())).toEqual([
    expect.objectContaining({ docId, name: 'sample.pdf' }),
  ]);

  const folder = join(dir, 'profile', 'phone-library', docId);
  const files = [
    'document.pdf',
    'manifest.json',
    ...readdirSync(join(folder, 'pages')).map((f) => `pages/${f}`),
    ...readdirSync(join(folder, 'audio')).map((f) => `audio/${f}`),
  ];
  for (const file of files) {
    const got = await call('GET', `/v1/doc/${docId}/${file}`, { token });
    expect(got.status, file).toBe(200);
    expect(got.body.equals(readFileSync(join(folder, ...file.split('/')))), file).toBe(true);
  }

  const stranger = randomBytes(32).toString('hex');
  for (const path of ['/v1/library', `/v1/doc/${docId}/document.pdf`, `/v1/doc/${docId}/state`]) {
    const got = await call('GET', path, { token: stranger });
    expect(got.status, path).toBe(401);
    expect(got.body.length).toBe(0);
    expect((await call('GET', path)).status).toBe(401);
  }
  expect((await call('GET', `/v1/doc/${docId}/../../settings.json`, { token })).status).toBe(404);
});

test('a phone writes its own place and no other device’s', async () => {
  const state = { device, name: 'Test phone', updated: Date.now(), page: 2, offset: 0.1, sentence: null };
  expect((await call('PUT', `/v1/doc/${docId}/state/${device}`, { token, body: state })).status).toBe(204);
  const other = 'e'.repeat(32);
  const forged = { ...state, device: other };
  expect((await call('PUT', `/v1/doc/${docId}/state/${other}`, { token, body: forged })).status).toBe(403);
  const states = await call('GET', `/v1/doc/${docId}/state`, { token });
  // Beside this computer's own place, which is in the library since the PDF was opened (ADR 11).
  const listed = JSON.parse(states.body.toString()) as { device: string }[];
  expect(listed).toContainEqual(state);
  expect(listed.map((s) => s.device)).not.toContain(other);
});

test('a phone’s marks are merged per mark and reach the open document', async () => {
  const notesFile = join(dir, 'sample.pdf.notes.json');
  const mark = {
    id: '3f2b8c1e-0000-4000-8000-0000000000aa',
    page: 1,
    // Offsets of the phone's raw string: the desktop finds the mark again by its text.
    start: 3,
    end: 14,
    text: 'Dieser Text',
    quote: 'Dieser Text',
    kind: 'highlight',
    color: 'green',
    comment: 'phone',
    created: '2026-10-21T00:00:00.000Z',
    updated: 1000,
  };
  const put = (body: unknown) => call('PUT', `/v1/doc/${docId}/notes`, { token, body });
  const read = async () =>
    JSON.parse((await call('GET', `/v1/doc/${docId}/notes`, { token })).body.toString());

  // The phone sends a mark and general notes: the open document shows both, and the answer is the merge.
  const sent = await put({ version: 1, notes: 'from the phone', notesUpdated: 1000, annotations: [mark] });
  expect(sent.status).toBe(200);
  await expect(page.locator('#annotations blockquote')).toHaveText('Dieser Text');
  await expect(page.locator('#annotations textarea')).toHaveValue('phone');
  await expect(page.locator('#notes')).toHaveValue('from the phone');
  await expect.poll(() => existsSync(notesFile)).toBe(true);
  expect(JSON.parse(readFileSync(notesFile, 'utf8')).annotations[0]).toMatchObject({
    id: mark.id,
    updated: 1000,
  });

  // An edit in the window is stamped, and a phone's older edit of the same mark does not undo it.
  await page.fill('#annotations textarea', 'desktop');
  await expect.poll(async () => (await read()).annotations[0]?.comment).toBe('desktop');
  const stamped = (await read()).annotations[0].updated as number;
  expect(stamped).toBeGreaterThan(1000);
  const older = await put({
    version: 1,
    notes: '',
    annotations: [{ ...mark, comment: 'phone, older', updated: 2000 }],
  });
  expect(JSON.parse(older.body.toString()).annotations[0].comment).toBe('desktop');
  expect((await read()).annotations[0].comment).toBe('desktop');

  // A mark the phone made on its own is added beside it.
  const second = {
    ...mark,
    id: '3f2b8c1e-0000-4000-8000-0000000000bb',
    text: 'Text prüft',
    quote: 'Text prüft',
    comment: '',
  };
  await put({ version: 1, notes: '', annotations: [{ ...second, updated: stamped + 1 }] });
  await expect(page.locator('#annotations li')).toHaveCount(2);

  // Deleted in the window: it is a removal for the phones, and stays deleted if a phone still has it.
  await page.locator('#annotations li', { hasText: 'Text prüft' }).locator('.delete').click();
  await expect(page.locator('#annotations li')).toHaveCount(1);
  await expect.poll(async () => (await read()).removed?.[0]?.id).toBe(second.id);
  const again = await put({ version: 1, notes: '', annotations: [{ ...second, updated: 1500 }] });
  expect(JSON.parse(again.body.toString()).annotations.map((a: { id: string }) => a.id)).toEqual([mark.id]);
  await expect(page.locator('#annotations li')).toHaveCount(1);

  // Bad input is refused and changes nothing.
  expect((await put({ version: 2 })).status).toBe(400);
  expect((await call('PUT', `/v1/doc/${docId}/notes`, { token: 'f'.repeat(64), body: {} })).status).toBe(401);
  expect(pageErrors).toEqual([]);
});

test('a phone asks what changed since a time, and is told only of others’ changes', async () => {
  const changes = async (since: number) => {
    const answer = await call('GET', `/v1/changes?since=${since}`, { token });
    expect(answer.status).toBe(200);
    return JSON.parse(answer.body.toString()) as { now: number; docs: Record<string, { notes: number }> };
  };
  // From the start everything is new; the answer says what to ask from next.
  const first = await changes(0);
  expect(Object.keys(first.docs)).toEqual([docId]);
  expect(first.docs[docId]!.notes).toBeGreaterThan(0);
  expect((await changes(first.now)).docs).toEqual({});

  // The phone's own place is not news to it.
  const state = { device, name: 'Test phone', updated: Date.now(), page: 1, offset: 0, sentence: null };
  await call('PUT', `/v1/doc/${docId}/state/${device}`, { token, body: state });
  expect((await changes(first.now)).docs).toEqual({});

  // A mark made in the window is.
  await page.fill('#annotations textarea', 'changed on the desktop');
  await expect.poll(async () => Object.keys((await changes(first.now)).docs)).toEqual([docId]);

  // Without a token nothing is told, and the dialog shows the phone as connected.
  expect((await call('GET', '/v1/changes?since=0')).status).toBe(401);
  await page.click('#open-phone');
  await expect(page.locator('#lan-phones li', { hasText: 'Test phone' })).toContainText('connected, synced');
  await page.keyboard.press('Escape');
});

test('a document the user stopped syncing is not shown to phones on Wi-Fi either', async () => {
  await page.evaluate((id) => window.api.syncSetDocument(id, false), docId);
  const library = JSON.parse((await call('GET', '/v1/library', { token })).body.toString()) as unknown[];
  expect(library).toEqual([]);
  const changes = JSON.parse((await call('GET', '/v1/changes?since=0', { token })).body.toString());
  expect(changes.docs).toEqual({});
  expect((await call('GET', `/v1/doc/${docId}/manifest.json`, { token })).status).toBe(404);
  await page.evaluate((id) => window.api.syncSetDocument(id, true), docId);
  expect(JSON.parse((await call('GET', '/v1/library', { token })).body.toString())).toHaveLength(1);
});

test('Send to phone puts the document in that phone’s inbox, until the phone says it is handled', async () => {
  // Stopped first, to see that sending makes it synced again.
  await page.evaluate((id) => window.api.syncSetDocument(id, false), docId);
  await page.click('#open-phone');
  await expect(page.locator('#send-row')).toBeVisible();
  await expect(page.locator('#send-target option')).toHaveText(['Test phone']);
  await page.click('#send-phone');
  await expect(page.locator('#phone-progress')).toContainText('sent to Test phone');

  const inbox = async () =>
    JSON.parse((await call('GET', '/v1/inbox', { token })).body.toString()) as unknown[];
  expect(await inbox()).toEqual([expect.objectContaining({ docId, name: 'sample.pdf' })]);
  const synced = await page.evaluate(() => window.api.syncDocuments());
  expect(synced).toEqual([expect.objectContaining({ docId, synced: true })]);

  // Declined or accepted, the phone says so, and the offer is gone.
  expect((await call('DELETE', `/v1/inbox/${docId}`, { token })).status).toBe(204);
  expect(await inbox()).toEqual([]);
  expect((await call('GET', '/v1/inbox')).status).toBe(401);
  await page.keyboard.press('Escape');
});

test('Remove stops a paired phone at once', async () => {
  await page.click('#open-phone');
  await page
    .locator('#lan-phones li', { hasText: 'Test phone' })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(page.locator('#lan-phones li')).toHaveCount(0);
  expect((await call('GET', '/v1/library', { token })).status).toBe(401);
  expect(pageErrors).toEqual([]);
});
