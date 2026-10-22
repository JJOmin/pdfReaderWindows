import qrcode from 'qrcode-generator';
import { phoneState } from '../../shared/sync-state';
import type { Api, PhoneServerStatus } from '../../shared/types';

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Draws the QR code on the canvas: dark modules on a white square with the quiet zone the scanner needs. */
function drawQr(canvas: HTMLCanvasElement, text: string): void {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const modules = qr.getModuleCount();
  const quiet = 4;
  const scale = 4;
  canvas.width = canvas.height = (modules + quiet * 2) * scale;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000';
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (qr.isDark(row, col)) context.fillRect((col + quiet) * scale, (row + quiet) * scale, scale, scale);
    }
  }
}

/**
 * The "Phones on this network" part of the Phone dialog (ADR 7). The main process runs the
 * server; this switches it, shows the code and asks the user before a phone is paired.
 */
export function setUpPhones(api: Api): void {
  const dialog = $<HTMLDialogElement>('#phone');

  function show(status: PhoneServerStatus): void {
    $<HTMLInputElement>('#lan-enabled').checked = status.enabled;
    $('#lan-on').hidden = !status.running;
    $('#lan-error').textContent = status.enabled && !status.running ? status.error : '';
    $('#lan-code').textContent = status.code;
    const qr = $<HTMLCanvasElement>('#lan-qr');
    qr.hidden = status.pairingUrl === '';
    // The e2e test reads the secret from here, as a phone would from the picture.
    qr.dataset.url = status.pairingUrl;
    if (status.pairingUrl !== '') drawQr(qr, status.pairingUrl);
    $('#lan-addresses').textContent =
      status.addresses.length > 0
        ? `If the phone does not list it, type ${status.addresses.map((a) => `${a}:${status.port}`).join(' or ')}`
        : '';
    $('#lan-vpn').hidden = !status.enabled || status.vpn.length === 0;
    $('#lan-vpn').textContent =
      `A VPN seems to be on (${status.vpn.join(', ')}). While it is, the phone may find this computer but ` +
      'not connect. See ⓘ above.';
    const list = $('#lan-phones');
    list.replaceChildren(
      ...status.phones.map(({ device, name, paired, seen }) => {
        const item = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = `${name}, ${phoneState(paired, seen, Date.now())}`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Remove';
        remove.addEventListener('click', () => void api.phoneRemove(device).then(show, fail));
        item.append(label, remove);
        return item;
      }),
    );
  }

  // The phone polls every 5 seconds while it is open, so "connected" is kept up to date as often.
  let ticking: ReturnType<typeof setInterval> | undefined;
  const fail = (error: unknown): void => void ($('#lan-error').textContent = message(error));
  const refresh = (): void => void api.phoneServer().then(show, fail);

  $('#open-phone').addEventListener('click', () => {
    refresh();
    // The QR code's secret is made when pairing opens, so the picture is asked for again.
    void api.phonePairing(true).then(refresh, fail);
    clearInterval(ticking);
    ticking = setInterval(refresh, 5000);
  });
  dialog.addEventListener('close', () => {
    clearInterval(ticking);
    $('#lan-ask').hidden = true;
    void api.phonePairing(false);
  });
  $<HTMLInputElement>('#lan-enabled').addEventListener('change', (event) => {
    void api.phoneServerEnable((event.target as HTMLInputElement).checked).then(show, fail);
  });

  api.onPhoneEvent((event) => {
    if (event.kind === 'changed') return refresh();
    $('#lan-ask-text').textContent = `Pair with ${event.name}?`;
    $('#lan-ask').hidden = false;
  });
  const answer = (accept: boolean): void => {
    $('#lan-ask').hidden = true;
    void api.phoneAnswer(accept).catch(fail);
  };
  $('#lan-accept').addEventListener('click', () => answer(true));
  $('#lan-decline').addEventListener('click', () => answer(false));
}
