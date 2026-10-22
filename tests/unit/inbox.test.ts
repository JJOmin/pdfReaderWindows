import { describe, expect, it } from 'vitest';
import { addOffer, parseInbox, parseOffers, removeOffers, type Offer } from '../../src/shared/inbox';

const PHONE = 'e'.repeat(32);
const OTHER = 'c'.repeat(32);
const offer = (id: string, sent = 1): Offer => ({
  docId: id.repeat(64),
  name: `${id}.pdf`,
  bytes: 1000,
  sent,
});

describe('inbox', () => {
  it('adds an offer per phone, and a document sent again replaces the older offer', () => {
    let inbox = addOffer({}, PHONE, offer('a'));
    inbox = addOffer(inbox, PHONE, offer('b'));
    inbox = addOffer(inbox, PHONE, offer('a', 5));
    inbox = addOffer(inbox, OTHER, offer('a'));
    expect(inbox[PHONE]).toEqual([offer('b'), offer('a', 5)]);
    expect(inbox[OTHER]).toEqual([offer('a')]);
  });

  it('takes handled offers out, and a phone with none left out of the inbox', () => {
    const inbox = addOffer(addOffer({}, PHONE, offer('a')), PHONE, offer('b'));
    expect(removeOffers(inbox, PHONE, ['a'.repeat(64)])).toEqual({ [PHONE]: [offer('b')] });
    expect(removeOffers(inbox, PHONE, ['a'.repeat(64), 'b'.repeat(64)])).toEqual({});
    expect(removeOffers(inbox, OTHER, ['a'.repeat(64)])).toEqual(inbox);
  });

  it('reads only what is valid', () => {
    expect(parseOffers([offer('a'), { ...offer('b'), bytes: -1 }, { docId: 'x' }, null])).toEqual([
      offer('a'),
    ]);
    expect(parseOffers('nope')).toEqual([]);
    expect(parseInbox({ [PHONE]: [offer('a')], short: [offer('b')], [OTHER]: [] })).toEqual({
      [PHONE]: [offer('a')],
    });
    expect(parseInbox(null)).toEqual({});
  });
});
