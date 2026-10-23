import { READING_LIMITS, resolveVoice } from '../../shared/settings';
import { syncState } from '../../shared/sync-state';
import type { Api, OpenedPdf, PlaceOffer, Progress, RawRange, Utterance } from '../../shared/types';
import { focusBand, scrollToCentre } from './focus';
import { paint } from './highlights';
import { NotesPanel } from './notes-panel';
import { Pdf } from './pdf';
import { prepareForPhone, voicesKey } from './phone';
import { Reader } from './reader';
import { ReadingView } from './reading-view';
import { Search } from './search';
import { setUpPhones } from './phones';
import { setUpSync } from './sync';
import type { TextView } from './view';
import { renderVoices, SAMPLES } from './voices';

declare global {
  interface Window {
    api: Api;
  }
}

const api = window.api;
const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const FOLLOW_PAUSE_MS = 3000;
const SEARCH_DELAY_MS = 200;
/** A run of scrolling is reported once it has paused this long; the main process limits writes too. */
const PROGRESS_DELAY_MS = 150;

function status(message: string, error = false): void {
  $('#status').textContent = message;
  $('#status').classList.toggle('error', error);
}

const [settings, voices] = await Promise.all([api.getSettings(), api.voices()]);
const pdf = new Pdf();
const reading: ReadingView = new ReadingView(pdf, (page) => {
  if (view === reading) rendered(page);
});
/** The view on screen. Everything that points at text goes through it. */
let view: TextView = pdf;

let spoken: { utterance: Utterance; word: number } | undefined;
/** The opening of the document on screen, which its progress is saved against. */
let documentId = 0;
/** Where Play continues the first time it is pressed: the sentence the voice left off at. */
let resume: { page: number; index: number } | undefined;
/** The sentence the voice read last in this document, kept for the next time it is opened. */
let lastSentence: { page: number; index: number } | null = null;
/** The last place sent, standing in for anything that cannot be read off the screen yet. */
let kept: Progress | null = null;
let progressTimer: ReturnType<typeof setTimeout> | undefined;
let lastWheel = 0;
/** A passage to scroll to once its page has been rendered; `centre` is the focus mode's way of scrolling. */
let awaited: { page: number; ranges: readonly RawRange[]; centre?: boolean } | undefined;

function paintSpoken(): void {
  const utterance = spoken?.utterance;
  const word = utterance?.words[spoken!.word];
  // A sentence over a page break is painted on both pages (ADR 12).
  const sentence = utterance
    ? [
        ...view.domRanges(utterance.page, utterance.ranges),
        ...(utterance.next ? view.domRanges(utterance.next.page, utterance.next.ranges) : []),
      ]
    : [];
  paint('spoken-sentence', sentence, 1);
  paint('spoken-word', utterance && word ? view.domRanges(word.page ?? utterance.page, word.ranges) : [], 2);
}

/** Scrolls a passage into the comfortable part of the view, rendering its page first if needed. */
function reveal(page: number, ranges: readonly RawRange[]): void {
  const [range] = view.domRanges(page, ranges);
  if (!range) {
    awaited = { page, ranges };
    view.showPage(page);
    return;
  }
  awaited = undefined;
  const text = range.getBoundingClientRect();
  const box = view.container.getBoundingClientRect();
  if (text.top < box.top + 40 || text.bottom > box.bottom - 100) {
    view.container.scrollBy({ top: text.top - box.top - box.height * 0.3, behavior: 'smooth' });
  }
}

/** Keeps the spoken text on screen, unless the user has just scrolled somewhere else. */
function follow(): void {
  if (!spoken || performance.now() - lastWheel < FOLLOW_PAUSE_MS) return;
  const { utterance, word } = spoken;
  const current = utterance.words[word];
  reveal(current?.page ?? utterance.page, current?.ranges ?? utterance.ranges);
}

/**
 * Focus mode: puts the spoken sentence in the middle of the view, or, when it is taller than
 * most of the view, the line being read. A new sentence does this even if the user has just
 * scrolled; within a sentence only a tall one follows the words, so scrolling is not fought.
 */
function centreSpoken(newSentence: boolean): void {
  if (!spoken) return;
  const { utterance, word } = spoken;
  const boxes = view.domRanges(utterance.page, utterance.ranges).map((r) => r.getBoundingClientRect());
  if (boxes.length === 0) {
    awaited = { page: utterance.page, ranges: utterance.ranges, centre: true };
    view.showPage(utterance.page);
    return;
  }
  awaited = undefined;
  const sentence = {
    top: Math.min(...boxes.map((b) => b.top)),
    bottom: Math.max(...boxes.map((b) => b.bottom)),
  };
  const current = utterance.words[Math.max(0, word)];
  const line = current && view.domRanges(utterance.page, current.ranges)[0]?.getBoundingClientRect();
  const box = view.container.getBoundingClientRect();
  const band = focusBand(sentence, line, box.height);
  if (band === sentence && !newSentence) return;
  const delta = scrollToCentre(band, box.top + box.height / 2);
  if (Math.abs(delta) >= 1) {
    view.container.scrollTo({ top: view.container.scrollTop + delta, behavior: 'smooth' });
  }
}

/** Whether the voice is reading and the user wants the sentence kept in the middle. */
const focusing = (): boolean => settings.focusMode && reader.state === 'playing';

/** Where the user is in the document, or null before there is one. */
function currentProgress(): Progress | null {
  if (!pdf.pageCount) return null;
  const base = kept ?? { view: 'pdf', zoom: null, page: 1, offset: 0, sentence: null };
  // A view that has not yet been given its saved place would report the top of the document.
  const placed = view === pdf ? pdf.laidOut : reading.settled;
  return {
    view: view === pdf ? 'pdf' : 'reading',
    zoom: pdf.laidOut ? (pdf.fitsWidth ? null : Math.round(pdf.scale * 1000) / 1000) : base.zoom,
    ...(placed ? view.scrollAnchor() : { page: base.page, offset: base.offset }),
    sentence: lastSentence,
  };
}

/** Sends the place in the document to be remembered, soon after the last change. */
function remember(): void {
  clearTimeout(progressTimer);
  progressTimer = setTimeout(() => {
    const place = currentProgress();
    if (!place) return;
    kept = place;
    void api.saveProgress(documentId, place);
  }, PROGRESS_DELAY_MS);
}

const showPageInfo = (): void => {
  $('#page-info').textContent = pdf.pageCount ? `${view.currentPage} / ${pdf.pageCount}` : '';
};

const reader = new Reader({
  pageCount: () => pdf.pageCount,
  utterances: (page) => pdf.pageUtterances(page),
  synthesize: async (utterance) => {
    const voice = resolveVoice(settings, voices, utterance.lang, utterance.role);
    if (!voice) throw new Error('No speech models are installed. Run "npm run models", then restart.');
    return api.synthesize({
      text: utterance.spoken,
      words: utterance.words.map((w) => w.text),
      lang: utterance.lang,
      voice,
      speed: settings.speed,
    });
  },
  onChange: (state, utterance, word) => {
    const newSentence = utterance !== undefined && utterance !== spoken?.utterance;
    // A pause or resume carries no utterance and keeps the current highlight.
    if (utterance) spoken = { utterance, word };
    else if (state === 'idle') spoken = undefined;
    if (newSentence) {
      resume = undefined;
      const sentence = utterance;
      void pdf.pageUtterances(sentence.page).then((all) => {
        const index = all.indexOf(sentence);
        if (index < 0) return;
        lastSentence = { page: sentence.page, index };
        remember();
      });
    }
    paintSpoken();
    // Audio stops a moment after a pause, so a word can still arrive then: it is centred too.
    if (settings.focusMode) centreSpoken(newSentence);
    else follow();
    $('#play').textContent = state === 'playing' ? '⏸' : '▶';
    if (state === 'idle') status('');
    else if (utterance && word < 0) status(`Preparing: ${utterance.text.slice(0, 80)}`);
    else if (utterance) status(`Reading page ${utterance.page}`);
  },
  onError: (error) => status(error instanceof Error ? error.message : String(error), true),
});

const notes = new NotesPanel(pdf, [pdf, reading], () => view, {
  readFrom: async (page, offset) => {
    const utterances = await pdf.pageUtterances(page);
    const index = utterances.findIndex((u) => u.ranges.some(([, end]) => end > offset));
    reader.startAt(index < 0 ? { page: page + 1, index: 0 } : { page, index });
  },
  reveal,
  status,
});

const search = new Search(
  pdf,
  () => view,
  reveal,
  (current, total) => {
    const query = $<HTMLInputElement>('#search').value.trim();
    $('#search-count').textContent = query === '' ? '' : total === 0 ? 'No results' : `${current} / ${total}`;
  },
);

/** A page's text has appeared in one of the views: paint what belongs on it. */
function rendered(page: number): void {
  notes.paint();
  paintSpoken();
  search.paint();
  if (awaited?.page === page) {
    const { ranges, centre } = awaited;
    // One attempt only: a passage that cannot be found must not keep pulling the view back.
    awaited = undefined;
    if (view.domRanges(page, ranges).length > 0) {
      if (centre && focusing()) centreSpoken(true);
      else reveal(page, ranges);
    }
  }
}

pdf.events.on('textlayerrendered', async ({ pageNumber }: { pageNumber: number }) => {
  await pdf.align(pageNumber);
  if (view === pdf) rendered(pageNumber);
});
pdf.events.on('pagechanging', showPageInfo);
reading.container.addEventListener('scroll', showPageInfo, { passive: true });
for (const { container } of [pdf, reading]) {
  container.addEventListener('wheel', () => (lastWheel = performance.now()), { passive: true });
}
// What the progress file holds: where the view is scrolled to, and the zoom.
for (const container of [pdf.container, reading.container] as HTMLElement[]) {
  container.addEventListener('scroll', remember, { passive: true });
}
pdf.events.on('scalechanging', remember);
// Registered after the viewer's own, so the saved zoom and place are in effect by now.
pdf.events.on('pagesinit', remember);

function setView(next: TextView): void {
  const page = view.currentPage;
  view = next;
  $('#viewer-container').hidden = view !== pdf;
  reading.container.hidden = view !== reading;
  $('#toggle-reading').setAttribute('aria-pressed', String(view === reading));
  // Stay on the same page, or with the voice if it is reading.
  if (view === pdf) pdf.shown(page);
  else {
    void reading.build();
    reading.showPage(page);
  }
  notes.paint();
  paintSpoken();
  search.paint();
  if (spoken) {
    if (focusing()) centreSpoken(true);
    else reveal(spoken.utterance.page, spoken.utterance.ranges);
  }
  showPageInfo();
  remember();
}

async function show(opened: OpenedPdf | null): Promise<void> {
  if (!opened) return;
  reader.stop();
  // The main process would refuse its writes now; stop rendering for a document that is gone.
  preparing?.abort();
  // Nothing about the previous document may be reported as this one's.
  clearTimeout(progressTimer);
  const saved = opened.progress;
  documentId = opened.id;
  kept = saved;
  resume = saved?.sentence ?? undefined;
  lastSentence = saved?.sentence ?? null;
  try {
    await pdf.open(opened.data, saved ?? undefined);
  } catch (error) {
    status(`Could not open ${opened.name}: ${error instanceof Error ? error.message : String(error)}`, true);
    return;
  }
  offerPlace(opened.offer);
  document.title = `${opened.name} – Easy Reader`;
  $('#title').textContent = opened.name;
  $('#title').title = opened.name;
  $('#empty').hidden = true;
  fitToolbar();
  void showSync();
  notes.load(opened.name, opened.notes);
  $<HTMLInputElement>('#search').value = '';
  void search.find('');
  reading.reset();
  // Back in the view the document was left in, at the place it was left.
  if (saved && (saved.view === 'reading') !== (view === reading)) {
    setView(saved.view === 'reading' ? reading : pdf);
  }
  if (saved?.view === 'reading') reading.showPage(saved.page, saved.offset);
  if (view === reading) void reading.build();
  showPageInfo();
  status('');
  void addAndPrepare(opened.id);
}

/**
 * The opened PDF goes into the phone library at once, without audio, and is synced from then on; its
 * audio is rendered in the background, page by page, unless the user paused it (ADR 11).
 */
async function addAndPrepare(id: number): Promise<void> {
  try {
    held = await api.addToLibrary(id, pdf.pageCount);
  } catch (error) {
    status(`Not added for the phone: ${error instanceof Error ? error.message : String(error)}`, true);
    return;
  }
  if (id !== documentId) return;
  void phoneSync.documents();
  if (audioPaused || voices.length === 0 || held.voiced.length === pdf.pageCount) return showPreparing();
  if (held.voices !== '' && held.voices !== (await voicesKey(settings, voices))) {
    // Made with other voices: kept until the user asks for it again (Phone, Prepare audio again).
    return showPreparing();
  }
  void prepare();
}

/** Offers another device's newer place in this document (ADR 7 section 8). */
function offerPlace(offer: PlaceOffer | null): void {
  $('#place-offer').hidden = offer === null;
  if (!offer) return;
  $('#place-offer-text').textContent = `Continue where you stopped on ${offer.from}, page ${offer.page}?`;
  $('#place-continue').onclick = () => {
    $('#place-offer').hidden = true;
    reader.stop();
    // Play goes on from the sentence the other device read last.
    resume = offer.sentence ?? { page: offer.page, index: 0 };
    lastSentence = offer.sentence;
    view.showPage(offer.page, offer.offset);
    remember();
  };
}
$('#place-dismiss').addEventListener('click', () => ($('#place-offer').hidden = true));

/** A phone's marks were merged into this document's notes: show them. */
api.onNotesChanged((file) => {
  notes.load($('#title').textContent, file);
  notes.paint();
});

const open = async (): Promise<void> => show(await api.openPdf());
const playPause = (): void => {
  if (pdf.pageCount > 0) reader.toggle(resume ?? { page: view.currentPage, index: 0 });
};
const saveSettings = (): void => void api.setSettings(settings);

const focusButton = $('#focus-mode');
const showFocus = (): void => focusButton.setAttribute('aria-pressed', String(settings.focusMode));
showFocus();
focusButton.addEventListener('click', () => {
  settings.focusMode = !settings.focusMode;
  showFocus();
  saveSettings();
  if (focusing()) centreSpoken(true);
});

/** Zooms the PDF pages, or changes the text size in the reading view. */
function zoom(direction: 1 | -1, steps = 1): void {
  if (view === pdf) {
    pdf.zoom((direction > 0 ? 1.1 : 1 / 1.1) ** steps);
    return;
  }
  const size = $<HTMLInputElement>('#reading-size');
  const [min, max] = READING_LIMITS.size;
  size.value = String(Math.min(max, Math.max(min, settings.reading.size + 2 * direction * steps)));
  size.dispatchEvent(new Event('input'));
  size.dispatchEvent(new Event('change'));
}

/** Wheel movement per notch of a mouse wheel. */
const WHEEL_NOTCH = 100;
/** Zoom steps of 10 %, or two pixels of text, that Ctrl+wheel has asked for but not yet applied. */
let wheelSteps = 0;

/**
 * Ctrl+wheel zooms the document like the keys do, and keeps the point under the pointer where
 * it was. Chromium's own page zoom would scale the toolbar, so the event is taken.
 */
function zoomByWheel(event: WheelEvent): void {
  if (!event.ctrlKey) return;
  event.preventDefault();
  wheelSteps -= event.deltaY / WHEEL_NOTCH;
  if (view === pdf) {
    // A touchpad pinch sends small deltas: apply the step once it is worth a 1 % change.
    const factor = 1.1 ** wheelSteps;
    if (Math.abs(factor - 1) < 0.01) return;
    wheelSteps = 0;
    pdf.zoom(factor, { x: event.clientX, y: event.clientY });
  } else if (Math.abs(wheelSteps) >= 1) {
    const whole = Math.trunc(wheelSteps);
    wheelSteps -= whole;
    zoom(whole > 0 ? 1 : -1, Math.abs(whole));
  }
}
for (const container of [pdf.container, reading.container] as HTMLElement[]) {
  container.addEventListener('wheel', zoomByWheel, { passive: false });
}

$('#open').addEventListener('click', () => void open());
$('#play').addEventListener('click', playPause);
$('#stop').addEventListener('click', () => reader.stop());
$('#prev').addEventListener('click', () => void reader.skip(-1));
$('#next').addEventListener('click', () => void reader.skip(1));
$('#zoom-in').addEventListener('click', () => zoom(1));
$('#zoom-out').addEventListener('click', () => zoom(-1));
$('#toggle-reading').addEventListener('click', () => setView(view === pdf ? reading : pdf));
$('#empty-open').addEventListener('click', () => void open());

// The notes panel. In a narrow window it lies over the page, so it starts closed there and
// closes when the window becomes narrow. The button shows whether it is open, whoever opened it.
const sidebar = $('#sidebar');
const narrow = matchMedia('(max-width: 979px)');
new MutationObserver(() => {
  $('#toggle-sidebar').setAttribute('aria-pressed', String(!sidebar.hidden));
}).observe(sidebar, { attributes: true, attributeFilter: ['hidden'] });
if (narrow.matches) sidebar.hidden = true;
narrow.addEventListener('change', () => {
  if (narrow.matches) sidebar.hidden = true;
});
$('#toggle-sidebar').addEventListener('click', () => (sidebar.hidden = !sidebar.hidden));

// The toolbar keeps one row: items that do not fit move into the "⋯" menu, the highest
// data-overflow first, and come back when there is room. A comment marks each item's place.
const toolbar = $('#toolbar');
const more = $('#more');
const moreMenu = $('#more-menu');
const movable = [...toolbar.querySelectorAll<HTMLElement>('[data-overflow]')]
  .map((element) => {
    const home = document.createComment(element.id || 'toolbar item');
    element.before(home);
    return { element, home, rank: Number(element.dataset.overflow) };
  })
  .sort((a, b) => b.rank - a.rank);

function showMore(open: boolean): void {
  moreMenu.hidden = !open;
  more.setAttribute('aria-expanded', String(open));
}

function fitToolbar(): void {
  for (const { element, home } of movable) home.after(element);
  more.hidden = true;
  const overflows = (): boolean => toolbar.scrollWidth > toolbar.clientWidth;
  if (!overflows()) {
    showMore(false);
    return;
  }
  more.hidden = false;
  const moved = [];
  for (const item of movable) {
    if (!overflows()) break;
    moreMenu.append(item.element);
    moved.push(item);
  }
  // In the menu they keep the toolbar's order.
  moved.sort((a, b) => (a.home.compareDocumentPosition(b.home) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  for (const { element } of moved) moreMenu.append(element);
}

new ResizeObserver(fitToolbar).observe(toolbar);
more.addEventListener('click', () => showMore(more.getAttribute('aria-expanded') !== 'true'));
// A button that opens something closes the menu; zoom and the slider keep it open for more steps.
moreMenu.addEventListener('click', (event) => {
  if ((event.target as Element).parentElement === moreMenu) showMore(false);
});
document.addEventListener('pointerdown', (event) => {
  if (!moreMenu.hidden && !toolbar.contains(event.target as Node)) showMore(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !moreMenu.hidden) {
    showMore(false);
    more.focus();
  }
});

// A PDF dragged from Finder or Explorer onto the window opens there.
const draggingFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes('Files') ?? false;
document.addEventListener('dragover', (event) => {
  if (!draggingFiles(event)) return;
  event.preventDefault();
  event.dataTransfer!.dropEffect = 'copy';
  document.body.classList.add('dropping');
});
document.addEventListener('dragleave', (event) => {
  if (event.relatedTarget === null) document.body.classList.remove('dropping');
});
document.addEventListener('drop', (event) => {
  document.body.classList.remove('dropping');
  if (!draggingFiles(event)) return;
  event.preventDefault();
  const file = [...event.dataTransfer!.files].find((f) => /\.pdf$/iu.test(f.name));
  if (file) void api.openDropped(file).then(show);
  else status('Only PDF files can be opened.', true);
});
reading.bindControls(settings.reading, saveSettings);

const speed = $<HTMLInputElement>('#speed');
const showSpeed = (): void => void ($('#speed-value').textContent = `${settings.speed.toFixed(2)}×`);
speed.value = String(settings.speed);
showSpeed();
speed.addEventListener('input', () => {
  settings.speed = Number(speed.value);
  showSpeed();
});
const voiceSettingsChanged = (): void => {
  saveSettings();
  reader.invalidate();
};
speed.addEventListener('change', voiceSettingsChanged);

const stopAtReferences = $<HTMLInputElement>('#stop-at-references');
stopAtReferences.checked = settings.stopAtReferences;
reader.stopAtReferences = settings.stopAtReferences;
stopAtReferences.addEventListener('change', () => {
  settings.stopAtReferences = stopAtReferences.checked;
  reader.stopAtReferences = settings.stopAtReferences;
  saveSettings();
});

const polish = $<HTMLInputElement>('#polish');
polish.checked = settings.polish;
reader.polish = settings.polish;
polish.addEventListener('change', () => {
  settings.polish = polish.checked;
  reader.polish = settings.polish;
  saveSettings();
});

$('#open-voices').addEventListener('click', () => {
  renderVoices($('#voice-rows'), voices, settings, voiceSettingsChanged, (lang, voice) => {
    status('Preparing sample');
    void reader
      .preview(api.synthesize({ text: SAMPLES[lang], words: [], lang, voice, speed: settings.speed }))
      .then(() => status(''));
  });
  $<HTMLDialogElement>('#voices').showModal();
});

/** The running "Add this document" job. It goes on when the dialog is closed. */
let preparing: AbortController | undefined;
/** Hides the last job's result after a while; an error stays until the next job. */
let phoneProgressTimer: ReturnType<typeof setTimeout> | undefined;
const PHONE_RESULT_MS = 10_000;
/** The job's progress, in the dialog and at the bottom of the window, where it shows while the dialog is shut. */
const phoneStatus = (message: string, error = false): void => {
  clearTimeout(phoneProgressTimer);
  for (const id of ['#phone-status', '#phone-progress']) {
    $(id).textContent = message;
    $(id).classList.toggle('error', error);
  }
  $('#phone-progress').hidden = false;
};
const showPreparing = (): void => {
  $<HTMLButtonElement>('#phone-add').disabled = preparing !== undefined || pdf.pageCount === 0;
  $<HTMLButtonElement>('#send-phone').disabled = pdf.pageCount === 0;
  const pause = $<HTMLButtonElement>('#audio-pause');
  pause.hidden = pdf.pageCount === 0 || (!preparing && !audioPaused);
  pause.textContent = audioPaused ? 'Resume audio' : 'Pause audio';
  $('#phone-cancel').hidden = preparing === undefined;
  void showSync();
};

/** The sync button's state; the main process knows all of it but a document being prepared here. */
let syncAsked = 0;
async function showSync(): Promise<void> {
  const asked = ++syncAsked;
  const facts = await api.syncState();
  // An older answer must not overwrite a newer one.
  if (asked !== syncAsked) return;
  const state = syncState({ ...facts, busy: facts.busy || preparing !== undefined });
  const title = {
    off: 'Sync is not set up: pair a phone or sign in to Nextcloud',
    pending:
      facts.document && !facts.prepared
        ? 'Not synced: this document is not prepared for your phone yet'
        : facts.failed
          ? 'Not synced: the last sync failed'
          : 'Not synced: changes are not yet sent to Nextcloud',
    syncing: preparing ? 'Syncing: preparing this document for your phone' : 'Syncing',
    done: 'Synced',
  }[state];
  const button = $('#open-phone');
  button.dataset.state = state;
  button.title = title;
  button.setAttribute('aria-label', title);
}
api.onSyncChanged(() => void showSync());
void showSync();
const phoneSync = setUpSync(api, phoneStatus);
setUpPhones(api);
$('#open-phone').addEventListener('click', () => {
  showPreparing();
  $<HTMLDialogElement>('#phone').showModal();
  void phoneSync.open();
  void showSendTargets();
});
$('#phone-cancel').addEventListener('click', () => preparing?.abort());
api.onSendMenu(() => {
  if (!$<HTMLDialogElement>('#phone').open) $('#open-phone').click();
  void showSendTargets().then(() => $('#send-target').focus());
});
/** The open document's pages that have audio, and the voices that made it. */
let held: { voiced: number[]; voices: string } = { voiced: [], voices: '' };
/** The pause button: rendering runs by default, and stays paused for the session once paused. */
let audioPaused = false;

/**
 * Renders the open document's audio in the background, page by page, each page synced as soon as it
 * is written (ADR 11). `again` starts over with the chosen voices. Resolves to whether it finished.
 */
function prepare(again = false): Promise<boolean> {
  preparing?.abort();
  const job = new AbortController();
  preparing = job;
  showPreparing();
  const name = $('#title').textContent;
  return prepareForPhone(
    {
      api,
      id: documentId,
      settings,
      voices,
      pageCount: pdf.pageCount,
      utterances: (page) => pdf.pageUtterances(page),
      fromPage: view.currentPage,
      held: again ? { voiced: [], voices: '' } : held,
      progress: ({ pagesDone, pages }) =>
        phoneStatus(`Audio for the phone: page ${Math.min(pages, pagesDone + 1)} of ${pages}`),
    },
    job.signal,
  )
    .then(async ({ cancelled }) => {
      if (cancelled) {
        phoneStatus(audioPaused ? 'Audio for the phone: paused.' : 'Audio for the phone: stopped.');
        return false;
      }
      phoneStatus(`Audio for the phone: ${name} is ready.`);
      await phoneSync.documents();
      phoneProgressTimer = setTimeout(() => ($('#phone-progress').hidden = true), PHONE_RESULT_MS);
      return true;
    })
    .catch((error: unknown) => {
      phoneStatus(`Audio for the phone: ${error instanceof Error ? error.message : String(error)}`, true);
      return false;
    })
    .finally(() => {
      if (preparing === job) preparing = undefined;
      showPreparing();
    });
}
$('#audio-pause').addEventListener('click', () => {
  audioPaused = !audioPaused;
  if (audioPaused) preparing?.abort();
  else if (pdf.pageCount > 0) void prepare();
  showPreparing();
});
$('#phone-add').addEventListener('click', () => {
  // Starts over with the chosen voices, and so also undoes a pause.
  audioPaused = false;
  $<HTMLDialogElement>('#phone').close();
  void prepare(true);
});

/** "Send to phone" (ADR 10 section 6): prepares the document if it is not yet, then offers it. */
async function showSendTargets(): Promise<void> {
  const targets = await api.sendTargets();
  const select = $<HTMLSelectElement>('#send-target');
  select.replaceChildren(
    ...targets.map(({ device, name }) => {
      const option = document.createElement('option');
      option.value = device;
      option.textContent = name;
      return option;
    }),
  );
  $('#send-row').hidden = targets.length === 0 || pdf.pageCount === 0;
}
$('#send-phone').addEventListener('click', () => {
  const device = $<HTMLSelectElement>('#send-target').value;
  // The document is in the library since it was opened; its audio follows page by page (ADR 11).
  api.sendToPhone(device).then(
    (name) => phoneStatus(`Phone: sent to ${name}; it asks there whether to download it.`),
    (error: unknown) => phoneStatus(`Phone: ${error instanceof Error ? error.message : String(error)}`, true),
  );
});

const searchBox = $<HTMLInputElement>('#search');
let searchTimer: ReturnType<typeof setTimeout> | undefined;
searchBox.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void search.find(searchBox.value), SEARCH_DELAY_MS);
});
searchBox.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') search.step(event.shiftKey ? -1 : 1);
  else if (event.key === 'Escape') {
    searchBox.value = '';
    void search.find('');
    searchBox.blur();
  }
});
$('#search-prev').addEventListener('click', () => search.step(-1));
$('#search-next').addEventListener('click', () => search.step(1));

// Shortcuts take Cmd on the Mac and Ctrl elsewhere. A pinch on a Mac's touchpad still arrives as
// Ctrl+wheel, so zoomByWheel keeps Ctrl.
const MAC = navigator.userAgent.includes('Macintosh');
const command = (event: KeyboardEvent): boolean => (MAC ? event.metaKey : event.ctrlKey);
if (MAC) {
  for (const element of document.querySelectorAll<HTMLElement>('[title*="Ctrl+"], [placeholder*="Ctrl+"]')) {
    if (element.title) element.title = element.title.replaceAll('Ctrl+', '⌘');
    const input = element as HTMLInputElement;
    if (input.placeholder) input.placeholder = input.placeholder.replaceAll('Ctrl+', '⌘');
  }
}

document.addEventListener('keydown', (event) => {
  const typing = (event.target as Element).closest('textarea, input, select, dialog');
  if (event.code === 'Space' && !typing) {
    event.preventDefault();
    playPause();
  } else if (!MAC && event.ctrlKey && event.key === 'o') {
    // On the Mac the File menu's Open… has Cmd+O.
    void open();
  } else if (command(event) && event.key === 'f') {
    event.preventDefault();
    searchBox.select();
  } else if (command(event) && (event.key === '+' || event.key === '=')) {
    // Taken here so that nothing else, such as a menu shortcut, zooms the whole window too.
    event.preventDefault();
    zoom(1);
  } else if (command(event) && event.key === '-') {
    event.preventDefault();
    zoom(-1);
  }
});

if (voices.length === 0) status('No speech models are installed. Run "npm run models", then restart.', true);
api.onOpened((opened) => void show(opened));
void api.openInitial().then(show);
