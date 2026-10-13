import { LANGS, ROLES, type Lang, type Settings, type VoiceOption, type VoiceRef } from '../../shared/types';

const LANG_NAMES: Record<Lang, string> = { en: 'English', de: 'German' };
const ROLE_NAMES = { main: 'Main text', quote: 'Quotes', heading: 'Headings' } as const;
export const SAMPLES: Record<Lang, string> = {
  en: 'This is how this voice reads a sentence from your paper.',
  de: 'So klingt diese Stimme, wenn sie einen Satz aus deinem Text vorliest.',
};

const key = (voice: VoiceRef): string => `${voice.model}:${voice.sid}`;

/** Fills the voices dialog: one voice picker with a preview button per language and role. */
export function renderVoices(
  host: HTMLElement,
  voices: VoiceOption[],
  settings: Settings,
  onChange: () => void,
  onPreview: (lang: Lang, voice: VoiceRef) => void,
): void {
  host.replaceChildren();
  if (voices.length === 0) {
    host.append('No speech models are installed. Run "npm run models" in the project folder, then restart.');
    return;
  }
  for (const lang of LANGS) {
    const options = voices.filter((v) => v.langs.includes(lang));
    const heading = document.createElement('h3');
    heading.textContent = LANG_NAMES[lang];
    host.append(heading);
    for (const role of ROLES) {
      const select = document.createElement('select');
      select.id = `voice-${lang}-${role}`;
      if (role !== 'main') select.add(new Option('Same as main text', ''));
      for (const option of options) select.add(new Option(option.label, key(option)));
      const current = settings.voices[lang][role];
      select.value = current && options.some((o) => key(o) === key(current)) ? key(current) : '';
      const chosen = (): VoiceRef | null => options.find((o) => key(o) === select.value) ?? null;
      select.addEventListener('change', () => {
        const voice = chosen();
        settings.voices[lang][role] = voice && { model: voice.model, sid: voice.sid };
        onChange();
      });

      const label = document.createElement('label');
      label.htmlFor = select.id;
      label.textContent = ROLE_NAMES[role];

      const preview = document.createElement('button');
      preview.type = 'button';
      preview.textContent = '▶';
      preview.title = 'Play a sample';
      preview.addEventListener('click', () => {
        const voice = chosen() ?? settings.voices[lang].main;
        if (voice) onPreview(lang, voice);
      });
      host.append(label, select, preview);
    }
  }
}
