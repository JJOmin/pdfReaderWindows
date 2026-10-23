import { describe, expect, it } from 'vitest';
import {
  DICTATION_RATE,
  MAX_DICTATION_SECONDS,
  joinHeard,
  padSilence,
  parseDictation,
} from '../../src/shared/dictation';

describe('padSilence', () => {
  it('puts 0.4 s of silence before and after, as the phone does', () => {
    const speech = new Float32Array([0.5, -0.5, 0.25]);
    const padded = padSilence(speech);
    const pad = Math.round(0.4 * DICTATION_RATE);
    expect(padded.length).toBe(speech.length + 2 * pad);
    expect([...padded.slice(pad, pad + 3)]).toEqual([0.5, -0.5, 0.25]);
    expect(padded.slice(0, pad).every((s) => s === 0)).toBe(true);
    expect(padded.slice(pad + 3).every((s) => s === 0)).toBe(true);
  });
});

describe('parseDictation', () => {
  it('accepts audio of up to the longest recording and a little more', () => {
    const audio = new Float32Array(DICTATION_RATE);
    expect(parseDictation(audio)).toBe(audio);
    expect(parseDictation(new Float32Array((MAX_DICTATION_SECONDS + 2) * DICTATION_RATE))).toBeDefined();
  });

  it.each([
    ['not audio', 'abc'],
    ['plain numbers', [0, 1, 2]],
    ['nothing', new Float32Array(0)],
    ['16-bit samples', new Int16Array(100)],
    ['too long', new Float32Array((MAX_DICTATION_SECONDS + 3) * DICTATION_RATE)],
  ])('rejects %s', (_name, value) => {
    expect(parseDictation(value)).toBeUndefined();
  });
});

describe('joinHeard', () => {
  it('starts a comment with what was heard', () => {
    expect(joinHeard('', ' Das ist wichtig. ')).toBe('Das ist wichtig.');
  });

  it('adds to the words already there with one space', () => {
    expect(joinHeard('Check this.', 'Also that.')).toBe('Check this. Also that.');
    expect(joinHeard('Check this. \n', 'Also that.')).toBe('Check this. Also that.');
  });

  it('leaves the comment alone when nothing was heard', () => {
    expect(joinHeard('Check this.', '  ')).toBe('Check this.');
  });
});
