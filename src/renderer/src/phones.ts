import type { Api, PhoneServerStatus } from '../../shared/types';

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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
    $('#lan-addresses').textContent =
      status.addresses.length > 0
        ? `If the phone does not list it, type ${status.addresses.map((a) => `${a}:${status.port}`).join(' or ')}`
        : '';
    const list = $('#lan-phones');
    list.replaceChildren(
      ...status.phones.map(({ device, name, paired }) => {
        const item = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = `${name}, paired ${new Date(paired).toLocaleDateString()}`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Remove';
        remove.addEventListener('click', () => void api.phoneRemove(device).then(show, fail));
        item.append(label, remove);
        return item;
      }),
    );
  }

  const fail = (error: unknown): void => void ($('#lan-error').textContent = message(error));
  const refresh = (): void => void api.phoneServer().then(show, fail);

  $('#open-phone').addEventListener('click', () => {
    refresh();
    void api.phonePairing(true);
  });
  dialog.addEventListener('close', () => {
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
