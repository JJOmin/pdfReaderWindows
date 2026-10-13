// Stands in for helper/xtts_helper.py in unit tests: same protocol, no model.
// The "audio" it writes is the text of the request with a running number, so a test can see
// in which order requests were served and how many reached the helper.
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { setTimeout } from 'node:timers';

const started = process.env.FAKE_HELPER_LOAD_MS ? Number(process.env.FAKE_HELPER_LOAD_MS) : 0;
let served = 0;

setTimeout(() => {
  process.stdout.write(JSON.stringify({ ready: true, rate: 24000, speakers: ['Test Speaker'] }) + '\n');
  createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line);
    if (request.text === 'CRASH') process.exit(3);
    setTimeout(() => {
      if (request.text === 'FAIL') {
        process.stdout.write(JSON.stringify({ id: request.id, ok: false, error: 'ValueError: no' }) + '\n');
        return;
      }
      served += 1;
      writeFileSync(request.out, `${served}:${request.text}:${request.speaker}:${request.speed}`);
      process.stdout.write(JSON.stringify({ id: request.id, ok: true, seconds: 1, rate: 24000 }) + '\n');
    }, 40);
  });
}, started);
