import { readFile, writeFile } from 'node:fs/promises';
import { parseInbox, type Inbox } from '../shared/inbox';

/** The "Send to phone" offers, in `inbox.json` in the user data folder. Changes are made one at a time. */
export class InboxFile {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<Inbox> {
    try {
      return parseInbox(JSON.parse(await readFile(this.path, 'utf8')));
    } catch {
      return {};
    }
  }

  update(change: (inbox: Inbox) => Inbox): Promise<Inbox> {
    const next = this.queue.then(async () => {
      const inbox = change(await this.load());
      await writeFile(this.path, JSON.stringify(inbox, null, 2));
      return inbox;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}
