/** What decides the sync button's state. Times are milliseconds since 1970, 0 for never. */
export interface SyncFacts {
  /** Signed in to Nextcloud (ADR 8). */
  store: boolean;
  /** Wi-Fi sync is on and at least one phone is paired (ADR 7). */
  phones: boolean;
  /** A document is being prepared for the phone, or the store is being synced. */
  busy: boolean;
  /** A document is open. */
  document: boolean;
  /** The open document is in the phone library. */
  prepared: boolean;
  /** The last change the store should get: marks, or a newly prepared document. Not the place. */
  changedAt: number;
  /** When the last successful store sync started. */
  syncedAt: number;
  /** The last store sync failed. */
  failed: boolean;
}

/** off: nothing set up. pending: something is not on the devices yet. syncing. done. */
export type SyncState = 'off' | 'pending' | 'syncing' | 'done';

export function syncState(facts: SyncFacts): SyncState {
  if (facts.busy) return 'syncing';
  if (!facts.store && !facts.phones) return 'off';
  if (facts.document && !facts.prepared) return 'pending';
  // Phones fetch for themselves; only the store waits for this computer to send.
  if (facts.store && (facts.failed || facts.changedAt > facts.syncedAt)) return 'pending';
  return 'done';
}

/** A phone that asked within this long is connected: it polls every 5 seconds while its app is open. */
const CONNECTED_MS = 15_000;

const clock = (t: number): string =>
  new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** How the Phone dialog describes a paired phone: "connected, synced 12:03", "synced 09:41" or "paired 21.10.2026". */
export function phoneState(paired: number, seen: number, now: number): string {
  if (seen === 0) return `paired ${new Date(paired).toLocaleDateString()}`;
  return now - seen <= CONNECTED_MS ? `connected, synced ${clock(seen)}` : `synced ${clock(seen)}`;
}
