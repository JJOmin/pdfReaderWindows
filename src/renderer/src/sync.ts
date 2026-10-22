import type { Api, SyncedDocument, SyncReport, SyncStatus } from '../../shared/types';

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const NAMES = { none: '', nextcloud: 'Nextcloud' } as const;

const describe = ({ documents, uploaded, unreadable }: SyncReport): string => {
  const sent = uploaded > 0 ? `${uploaded} of ${documents} documents sent` : 'everything was already there';
  return unreadable > 0 ? `${sent}; ${unreadable} files from other devices need the same sync key` : sent;
};

/**
 * The sync part of the Phone dialog (ADR 8). The main process does the signing in and the
 * sending; this only asks and shows. `report` writes to the status line at the bottom.
 */
export function setUpSync(api: Api, report: (text: string, error?: boolean) => void) {
  let waiting = false;
  let syncing = false;
  let status: SyncStatus = { backend: 'none', account: '', auto: true };

  const account = (text: string, error = false): void => {
    $('#sync-account').textContent = text;
    $('#sync-account').classList.toggle('error', error);
  };

  function show(): void {
    const connected = status.backend !== 'none';
    $('#sync-connect').hidden = connected;
    $('#sync-connected').hidden = !connected;
    $<HTMLButtonElement>('#sync-nextcloud').disabled = waiting;
    $('#sync-cancel').hidden = !waiting;
    $<HTMLButtonElement>('#sync-now').disabled = syncing;
    $<HTMLButtonElement>('#sync-everything').disabled = syncing;
    $<HTMLInputElement>('#sync-auto').checked = status.auto;
    if (waiting) account('Waiting for you to approve in the browser…');
    else if (connected) {
      const who = status.account ? ` as ${status.account}` : '';
      account(`Signed in to ${NAMES[status.backend]}${who}.`);
    } else account('Not signed in.');
  }

  async function sign(backend: 'nextcloud'): Promise<void> {
    waiting = true;
    show();
    try {
      status = await api.syncConnect(backend, $<HTMLInputElement>('#sync-server').value);
      waiting = false;
      show();
      await run();
    } catch (error) {
      waiting = false;
      show();
      account(message(error), true);
    }
  }

  /** Sends the library and fetches the places. Used by the button and after a document is prepared. */
  async function run(full = false): Promise<void> {
    if (syncing) return;
    // The dialog may never have been opened in this session.
    status = await api.syncStatus();
    if (status.backend === 'none') return;
    syncing = true;
    show();
    report(`Sync: sending to ${NAMES[status.backend]}`);
    try {
      const result = await api.syncRun(full);
      report(`Sync: ${describe(result)}.`);
    } catch (error) {
      report(`Sync: ${message(error)}`, true);
    } finally {
      syncing = false;
      show();
    }
  }

  function showDocuments(docs: SyncedDocument[]): void {
    $('#sync-documents-box').hidden = docs.length === 0 || status.backend === 'none';
    $('#sync-documents').replaceChildren(
      ...docs.map((doc) => {
        const item = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = doc.synced ? doc.name : `${doc.name} (not synced)`;
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = doc.synced ? 'Stop syncing' : 'Sync this document';
        button.addEventListener('click', () => {
          void api.syncSetDocument(doc.docId, !doc.synced).then(showDocuments);
        });
        item.append(name, button);
        return item;
      }),
    );
  }

  $('#sync-auto').addEventListener('change', () => {
    void api.syncSetAuto($<HTMLInputElement>('#sync-auto').checked).then((next) => {
      status = next;
      show();
    });
  });

  $('#sync-nextcloud').addEventListener('click', () => void sign('nextcloud'));
  $('#sync-cancel').addEventListener('click', () => void api.syncCancel());
  $('#sync-now').addEventListener('click', () => void run());
  $('#sync-everything').addEventListener('click', () => void run(true));
  $('#sync-disconnect').addEventListener('click', () => {
    void api.syncDisconnect().then((next) => {
      status = next;
      show();
    });
  });
  $('#sync-key-save').addEventListener('click', () => {
    api
      .syncSetKey($<HTMLInputElement>('#sync-key').value)
      .then((key) => {
        $<HTMLInputElement>('#sync-key').value = key;
        account('The sync key was changed. Files sent with the old key are sent again.');
      })
      .catch((error: unknown) => account(message(error), true));
  });

  return {
    /** Reads the state when the dialog opens. */
    async open(): Promise<void> {
      [status, $<HTMLInputElement>('#sync-key').value] = await Promise.all([api.syncStatus(), api.syncKey()]);
      show();
      await this.documents();
    },
    /** The list of prepared documents; also after one was prepared. */
    async documents(): Promise<void> {
      showDocuments(await api.syncDocuments());
    },
    run,
  };
}
