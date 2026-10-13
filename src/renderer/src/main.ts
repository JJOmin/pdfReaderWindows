import { resolveVoice } from '../../shared/settings';
import type { Api, OpenedPdf, Utterance } from '../../shared/types';
import { paint } from './highlights';
import { NotesPanel } from './notes-panel';
import { Pdf } from './pdf';
import { Reader, type Cursor } from './reader';
import { renderVoices, SAMPLES } from './voices';

declare global {
  interface Window {
    api: Api;
  }
}

const api = window.api;
const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const FOLLOW_PAUSE_MS = 3000;

function status(message: string, error = false): void {
  $('#status').textContent = message;
  $('#status').classList.toggle('error', error);
}

const pdf = new Pdf();
const [settings, voices] = await Promise.all([api.getSettings(), api.voices()]);

let spoken: { utterance: Utterance; word: number } | undefined;
let lastWheel = 0;

function paintSpoken(): void {
  const utterance = spoken?.utterance;
  const word = utterance?.words[spoken!.word];
  paint('spoken-sentence', utterance ? pdf.domRanges(utterance.page, utterance.ranges) : [], 1);
  paint('spoken-word', utterance && word ? pdf.domRanges(utterance.page, word.ranges) : [], 2);
}

/** Keeps the spoken text on screen, unless the user has just scrolled somewhere else. */
function follow(): void {
  if (!spoken || performance.now() - lastWheel < FOLLOW_PAUSE_MS) return;
  const { utterance, word } = spoken;
  const [range] = pdf.domRanges(utterance.page, utterance.words[word]?.ranges ?? utterance.ranges);
  if (!range) {
    // Not rendered yet: go there, and the text layer's arrival repaints and follows again.
    pdf.showPage(utterance.page);
    return;
  }
  const text = range.getBoundingClientRect();
  const view = pdf.container.getBoundingClientRect();
  if (text.top < view.top + 40 || text.bottom > view.bottom - 100) {
    pdf.container.scrollBy({ top: text.top - view.top - view.height * 0.3, behavior: 'smooth' });
  }
}

const reader = new Reader({
  pageCount: () => pdf.pageCount,
  utterances: async (page) => (await pdf.pageText(page)).utterances,
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

const notes = new NotesPanel(
  pdf,
  async (page, offset) => {
    const { utterances } = await pdf.pageText(page);
    const index = utterances.findIndex((u) => u.ranges.some(([, end]) => end > offset));
    reader.startAt(index < 0 ? { page: page + 1, index: 0 } : { page, index });
  },
  status,
);

pdf.events.on('textlayerrendered', async ({ pageNumber }: { pageNumber: number }) => {
  await pdf.pageText(pageNumber);
  notes.paint();
  paintSpoken();
  follow();
});
pdf.events.on('pagechanging', () => {
  $('#page-info').textContent = pdf.pageCount ? `${pdf.currentPage} / ${pdf.pageCount}` : '';
});
pdf.container.addEventListener('wheel', () => (lastWheel = performance.now()), { passive: true });

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
  $('#page-info').textContent = `1 / ${pdf.pageCount}`;
  notes.load(opened.name, opened.notes);
  status('');
}

const open = async (): Promise<void> => show(await api.openPdf());
const startCursor = (): Cursor => ({ page: pdf.currentPage, index: 0 });
const playPause = (): void => {
  if (pdf.pageCount > 0) reader.toggle(startCursor());
};

$('#open').addEventListener('click', () => void open());
$('#play').addEventListener('click', playPause);
$('#stop').addEventListener('click', () => reader.stop());
$('#prev').addEventListener('click', () => void reader.skip(-1));
$('#next').addEventListener('click', () => void reader.skip(1));
$('#zoom-in').addEventListener('click', () => pdf.zoom(1.1));
$('#zoom-out').addEventListener('click', () => pdf.zoom(1 / 1.1));
$('#toggle-sidebar').addEventListener('click', (event) => {
  const sidebar = $('#sidebar');
  sidebar.hidden = !sidebar.hidden;
  (event.currentTarget as HTMLElement).setAttribute('aria-pressed', String(!sidebar.hidden));
});

const speed = $<HTMLInputElement>('#speed');
const showSpeed = (): void => void ($('#speed-value').textContent = `${settings.speed.toFixed(2)}×`);
speed.value = String(settings.speed);
showSpeed();
speed.addEventListener('input', () => {
  settings.speed = Number(speed.value);
  showSpeed();
});
const settingsChanged = (): void => {
  void api.setSettings(settings);
  reader.invalidate();
};
speed.addEventListener('change', settingsChanged);

$('#open-voices').addEventListener('click', () => {
  renderVoices($('#voice-rows'), voices, settings, settingsChanged, (lang, voice) => {
    status('Preparing sample');
    void reader
      .preview(api.synthesize({ text: SAMPLES[lang], words: [], lang, voice, speed: settings.speed }))
      .then(() => status(''));
  });
  $<HTMLDialogElement>('#voices').showModal();
});

document.addEventListener('keydown', (event) => {
  const typing = (event.target as Element).closest('textarea, input, select, dialog');
  if (event.code === 'Space' && !typing) {
    event.preventDefault();
    playPause();
  } else if (event.ctrlKey && event.key === 'o') void open();
  else if (event.ctrlKey && (event.key === '+' || event.key === '=')) pdf.zoom(1.1);
  else if (event.ctrlKey && event.key === '-') pdf.zoom(1 / 1.1);
});

if (voices.length === 0) status('No speech models are installed. Run "npm run models", then restart.', true);
void api.openInitial().then(show);
