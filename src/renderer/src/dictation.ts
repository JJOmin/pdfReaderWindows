import { DICTATION_RATE, MAX_DICTATION_SECONDS } from '../../shared/dictation';

export interface Recording {
  /** Ends the recording; `done` then resolves. */
  stop(): void;
  /** The recording as 16 kHz mono samples, once it has been stopped, by the user or by the time limit. */
  done: Promise<Float32Array>;
}

/** Starts listening to the microphone. Rejects if there is none or the user does not allow it. */
export async function startRecording(): Promise<Recording> {
  if (!(await window.api.dictationAccess())) {
    throw new Error('The microphone is blocked. Allow Easy Reader to use it in the system settings.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.addEventListener('dataavailable', (event) => chunks.push(event.data));
  const limit = setTimeout(() => recorder.stop(), MAX_DICTATION_SECONDS * 1000);
  const done = new Promise<Float32Array>((resolve, reject) => {
    recorder.addEventListener('stop', () => {
      clearTimeout(limit);
      for (const track of stream.getTracks()) track.stop();
      // The context resamples while it decodes, so the recording needs no resampler of its own.
      const context = new AudioContext({ sampleRate: DICTATION_RATE });
      new Blob(chunks)
        .arrayBuffer()
        .then((bytes) => context.decodeAudioData(bytes))
        .then((audio) => {
          const mono = new Float32Array(audio.length);
          for (let c = 0; c < audio.numberOfChannels; c++) {
            const channel = audio.getChannelData(c);
            for (let i = 0; i < mono.length; i++) mono[i]! += channel[i]! / audio.numberOfChannels;
          }
          resolve(mono);
        })
        .catch(reject)
        .finally(() => void context.close());
    });
  });
  recorder.start();
  return { stop: () => recorder.state === 'recording' && recorder.stop(), done };
}
