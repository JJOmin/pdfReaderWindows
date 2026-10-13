import { prerender } from '../../shared/prerender';
import { isRenderedVoice } from '../../shared/render-cache';
import { READING_LIMITS, resolveVoice } from '../../shared/settings';
import type { Api, OpenedPdf, Progress, RawRange, Utterance } from '../../shared/types';
import { focusBand, scrollToCentre } from './focus';
import { paint } from './highlights';
import { NotesPanel } from './notes-panel';
import { Pdf } from './pdf';
import { Reader } from './reader';
import { ReadingView } from './reading-view';
import { Search } from './search';
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
  paint('spoken-sentence', utterance ? view.domRanges(utterance.page, utterance.ranges) : [], 1);
  paint('spoken-word', utterance && word ? view.domRanges(utterance.page, word.ranges) : [], 2);
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
  reveal(utterance.page, utterance.words[word]?.ranges ?? utterance.ranges);
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
    zoom: pdf.laidOut ? Math.round(pdf.scale * 1000) / 1000 : base.zoom,
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
  // The sentences being rendered belong to the document that is closing.
  prerendering?.abort();
  prerenderButton.textContent = 'Pre-render';
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
  document.title = `${opened.name} – PDF Reader`;
  $('#title').textContent = opened.name;
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
}

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
$('#toggle-sidebar').addEventListener('click', (event) => {
  const sidebar = $('#sidebar');
  sidebar.hidden = !sidebar.hidden;
  (event.currentTarget as HTMLElement).setAttribute('aria-pressed', String(!sidebar.hidden));
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

const polish = $<HTMLInputElement>('#polish');
polish.checked = settings.polish;
reader.polish = settings.polish;
polish.addEventListener('change', () => {
  settings.polish = polish.checked;
  reader.polish = settings.polish;
  saveSettings();
});

const prerenderButton = $<HTMLButtonElement>('#prerender');
/** Set while a pre-render runs; aborting it stops after the sentence in progress. */
let prerendering: AbortController | undefined;
// Only a rendered voice needs this, so the button is there only when one is installed.
prerenderButton.hidden = !voices.some(isRenderedVoice);

const showPrerender = (label: string, running: boolean): void => {
  prerenderButton.textContent = label;
  prerenderButton.setAttribute('aria-pressed', String(running));
  prerenderButton.title = running
    ? 'Stop rendering. What is done stays.'
    : 'Render this document with the XTTS voice in the background, at the current speed. Read with any other voice meanwhile, and pick XTTS under Voices when it is done.';
};

/**
 * Renders the open document with the XTTS voice, from the page in view onwards. It does not
 * depend on the voice chosen for reading: the point is to read with another voice meanwhile,
 * and to find the sentences ready when XTTS is chosen.
 */
async function startPrerender(): Promise<void> {
  const gpu = voices.find(isRenderedVoice);
  if (!gpu || pdf.pageCount === 0) return;
  // Fixed now: a speed or voice changed while this runs must not change what is being rendered.
  const speed = settings.speed;
  const controller = new AbortController();
  prerendering = controller;
  showPrerender('Rendering…', true);
  let label = 'Pre-render';
  try {
    const result = await prerender<Utterance>(
      {
        pageCount: () => pdf.pageCount,
        utterances: (page) => pdf.pageUtterances(page),
        request: (utterance) =>
          gpu.langs.includes(utterance.lang)
            ? // The same text, voice and speed playback sends, so that playback finds the result.
              {
                text: utterance.spoken,
                words: [],
                lang: utterance.lang,
                voice: { model: gpu.model, sid: gpu.sid },
                speed,
              }
            : undefined,
        render: (request) => api.prerender(request),
        progress: ({ pagesDone, pages }) => showPrerender(`Rendering ${pagesDone}/${pages}`, true),
      },
      view.currentPage,
      controller.signal,
    );
    const failed = result.failed > 0 ? `, ${result.failed} could not be rendered` : '';
    const message = result.cancelled
      ? `Rendering stopped after ${result.rendered} sentences`
      : `Rendered ${result.rendered} sentences with XTTS at ${speed.toFixed(2)}×${failed}`;
    status(message, false);
    // Kept on the button: the status line is overwritten by the reader a moment later.
    if (!result.cancelled && result.failed === 0) label = 'Rendered ✓';
  } catch (error) {
    status(error instanceof Error ? error.message : String(error), true);
  } finally {
    // A newer run may have taken over if this document was replaced meanwhile.
    if (prerendering === controller) {
      prerendering = undefined;
      showPrerender(label, false);
    }
  }
}
prerenderButton.addEventListener('click', () => {
  if (prerendering) prerendering.abort();
  else void startPrerender();
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

document.addEventListener('keydown', (event) => {
  const typing = (event.target as Element).closest('textarea, input, select, dialog');
  if (event.code === 'Space' && !typing) {
    event.preventDefault();
    playPause();
  } else if (event.ctrlKey && event.key === 'o') void open();
  else if (event.ctrlKey && event.key === 'f') {
    event.preventDefault();
    searchBox.select();
  } else if (event.ctrlKey && (event.key === '+' || event.key === '=')) {
    // Taken here so that nothing else, such as a menu shortcut, zooms the whole window too.
    event.preventDefault();
    zoom(1);
  } else if (event.ctrlKey && event.key === '-') {
    event.preventDefault();
    zoom(-1);
  }
});

if (voices.length === 0) status('No speech models are installed. Run "npm run models", then restart.', true);
void api.openInitial().then(show);
