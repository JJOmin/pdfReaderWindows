import { READING_LIMITS, resolveVoice } from '../../shared/settings';
import type { Api, OpenedPdf, RawRange, Utterance } from '../../shared/types';
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
let lastWheel = 0;
/** A passage to scroll to once its page has been rendered. */
let awaited: { page: number; ranges: readonly RawRange[] } | undefined;

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
    // A pause or resume carries no utterance and keeps the current highlight.
    if (utterance) spoken = { utterance, word };
    else if (state === 'idle') spoken = undefined;
    paintSpoken();
    follow();
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
    const { ranges } = awaited;
    // One attempt only: a passage that cannot be found must not keep pulling the view back.
    awaited = undefined;
    if (view.domRanges(page, ranges).length > 0) reveal(page, ranges);
  }
}

pdf.events.on('textlayerrendered', async ({ pageNumber }: { pageNumber: number }) => {
  await pdf.pageBlocks(pageNumber);
  if (view === pdf) rendered(pageNumber);
});
pdf.events.on('pagechanging', showPageInfo);
reading.container.addEventListener('scroll', showPageInfo, { passive: true });
for (const { container } of [pdf, reading]) {
  container.addEventListener('wheel', () => (lastWheel = performance.now()), { passive: true });
}

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
  if (spoken) reveal(spoken.utterance.page, spoken.utterance.ranges);
  showPageInfo();
}

async function show(opened: OpenedPdf | null): Promise<void> {
  if (!opened) return;
  reader.stop();
  try {
    await pdf.open(opened.data);
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
  if (view === reading) void reading.build();
  showPageInfo();
  status('');
}

const open = async (): Promise<void> => show(await api.openPdf());
const playPause = (): void => {
  if (pdf.pageCount > 0) reader.toggle({ page: view.currentPage, index: 0 });
};
const saveSettings = (): void => void api.setSettings(settings);

/** Zooms the PDF pages, or changes the text size in the reading view. */
function zoom(direction: 1 | -1): void {
  if (view === pdf) {
    pdf.zoom(direction > 0 ? 1.1 : 1 / 1.1);
    return;
  }
  const size = $<HTMLInputElement>('#reading-size');
  const [min, max] = READING_LIMITS.size;
  size.value = String(Math.min(max, Math.max(min, settings.reading.size + 2 * direction)));
  size.dispatchEvent(new Event('input'));
  size.dispatchEvent(new Event('change'));
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
  } else if (event.ctrlKey && (event.key === '+' || event.key === '=')) zoom(1);
  else if (event.ctrlKey && event.key === '-') zoom(-1);
});

if (voices.length === 0) status('No speech models are installed. Run "npm run models", then restart.', true);
void api.openInitial().then(show);
