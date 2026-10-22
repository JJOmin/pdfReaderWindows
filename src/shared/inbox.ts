/**
 * "Send to phone" (ADR 10 section 6): what this computer offers each phone. A phone reads its offers
 * over Wi-Fi (`GET /v1/inbox`) or, away from home, in this computer's change journal, and asks the user
 * "Accept / Decline". An offer leaves the inbox when the phone says it is handled, or when the phone's
 * own journal shows the document on the phone.
 */

export interface Offer {
  docId: string;
  name: string;
  /** What it takes on the phone, so the phone can say "paper.pdf (12 MB)". */
  bytes: number;
  /** When it was sent: sending the same document again is a new offer. */
  sent: number;
}

/** Offers by the phone's device id. */
export type Inbox = Record<string, Offer[]>;

const DOC_ID = /^[0-9a-f]{64}$/u;
const DEVICE_ID = /^[0-9a-f]{32}$/u;

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

export function parseOffers(value: unknown): Offer[] {
  if (!Array.isArray(value)) return [];
  const offers: Offer[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { docId, name, bytes, sent } = entry as Record<string, unknown>;
    if (typeof docId !== 'string' || !DOC_ID.test(docId)) continue;
    if (typeof name !== 'string' || name.length === 0 || name.length > 512) continue;
    if (!count(bytes) || !count(sent)) continue;
    offers.push({ docId, name, bytes, sent });
  }
  return offers;
}

export function parseInbox(value: unknown): Inbox {
  const inbox: Inbox = {};
  if (typeof value !== 'object' || value === null) return inbox;
  for (const [device, offers] of Object.entries(value)) {
    const parsed = parseOffers(offers);
    if (DEVICE_ID.test(device) && parsed.length > 0) inbox[device] = parsed;
  }
  return inbox;
}

/** Adds an offer for a phone; the same document sent again replaces the older offer. */
export function addOffer(inbox: Inbox, device: string, offer: Offer): Inbox {
  const others = (inbox[device] ?? []).filter((o) => o.docId !== offer.docId);
  return { ...inbox, [device]: [...others, offer] };
}

/** Takes the offers of these documents out of a phone's inbox. */
export function removeOffers(inbox: Inbox, device: string, docIds: Iterable<string>): Inbox {
  const gone = new Set(docIds);
  const left = (inbox[device] ?? []).filter((o) => !gone.has(o.docId));
  const rest = Object.fromEntries(Object.entries(inbox).filter(([d]) => d !== device));
  return left.length > 0 ? { ...rest, [device]: left } : rest;
}
