import {
  engine,
  load,
  post,
  serve,
  yieldTask,
} from './Assets/voice-clone/engine/dist/host/worker.js';

const MODEL_URL =
  'https://huggingface.co/fusorlabs/qwen3-tts-12hz-0.6b-base-web/resolve/5b70db4fa8c56549063892c301a2d8131e7b5d07/';

let stoppedJob = null;

serve({
  load: () =>
    load({
      modelUrl: MODEL_URL,
      threads: 1,
      build: 'web-single-relaxed',
      glueName: 'qwen3_tts_runtime',
      cacheName: 'm3a-siri-voice-clone',
      distUrl: new URL('./Assets/voice-clone/engine/dist/', import.meta.url),
      onRuntime: (runtime) => post({ type: 'runtime', build: runtime.build.name }),
      onProgress: (progress) => post({ type: 'model-progress', ...progress }),
      onReady: (progress) => post({ type: 'ready', ...progress }),
    }),
  generate,
  stop: ({ job }) => {
    stoppedJob = job;
  },
});

async function generate({ job, request, reference }) {
  const { rt, glue } = engine;
  const chunks = [];
  let sampleCount = 0;
  stoppedJob = null;
  rt.start(request, reference);

  for (;;) {
    if (stoppedJob === job) {
      rt.cancel();
      post({ type: 'done', job, stopped: true });
      return;
    }

    const progress = JSON.parse(rt.step());
    const samples = rt.speech();
    if (samples.length) {
      chunks.push(samples.slice());
      sampleCount += samples.length;
    }
    post({ type: 'synthesis-progress', job, frames: progress.frames });
    if (progress.done) break;
    await yieldTask();
  }

  const wav = glue.wav(concat(chunks, sampleCount));
  post({ type: 'done', job, wav }, [wav.buffer]);
}

function concat(chunks, length) {
  const samples = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  return samples;
}
