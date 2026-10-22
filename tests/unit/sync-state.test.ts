import { describe, expect, it } from 'vitest';
import { syncState, type SyncFacts } from '../../src/shared/sync-state';

const base: SyncFacts = {
  store: true,
  phones: false,
  busy: false,
  document: true,
  prepared: true,
  changedAt: 100,
  syncedAt: 200,
  failed: false,
};

describe('syncState', () => {
  it('is off with neither a store nor a paired phone', () => {
    expect(syncState({ ...base, store: false })).toBe('off');
  });

  it('is syncing while a document is prepared or sent, even before anything is set up', () => {
    expect(syncState({ ...base, busy: true })).toBe('syncing');
    expect(syncState({ ...base, store: false, busy: true })).toBe('syncing');
  });

  it('is pending while the open document is not on the devices', () => {
    expect(syncState({ ...base, prepared: false })).toBe('pending');
    expect(syncState({ ...base, store: false, phones: true, prepared: false })).toBe('pending');
  });

  it('is pending after a change the store has not had, or a failed sync', () => {
    expect(syncState({ ...base, changedAt: 300 })).toBe('pending');
    expect(syncState({ ...base, failed: true })).toBe('pending');
  });

  it('is done when everything was sent, and for phones once the document is prepared', () => {
    expect(syncState(base)).toBe('done');
    expect(syncState({ ...base, store: false, phones: true, changedAt: 300 })).toBe('done');
    expect(syncState({ ...base, document: false, prepared: false })).toBe('done');
  });
});
