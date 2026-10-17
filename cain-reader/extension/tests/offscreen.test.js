import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// T12.3: offscreen.js is a classic script (no imports) that talks to chrome.*
// and Web Audio, so it cannot be imported directly. It is evaluated in a vm
// context with small browser stubs; that also lets the tests drive the real
// message handlers against a fake Web Audio clock.

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'offscreen.js'),
  'utf8'
);

function loadOffscreen({ startSuspended = false } = {}) {
  const messages = [];
  const revoked = [];
  const blobs = [];
  const sources = [];
  const contexts = [];
  const audio = [];
  const errors = [];
  const timers = new Map();
  let timerId = 0;
  let blobId = 0;

  class FakeBuffer {
    constructor(length, sampleRate) {
      this.length = length;
      this.sampleRate = sampleRate;
      this.duration = length / sampleRate;
      this.data = new Float32Array(length);
    }
    getChannelData() {
      return this.data;
    }
  }

  class FakeSource {
    constructor() {
      this.buffer = null;
      this.startedAt = null;
      this.stopCount = 0;
      this.disconnected = false;
      this.onended = null;
      sources.push(this);
    }
    connect() {}
    disconnect() {
      this.disconnected = true;
    }
    start(when) {
      this.startedAt = when;
    }
    stop() {
      this.stopCount++;
    }
  }

  class FakeGain {
    constructor() {
      this.disconnected = false;
    }
    connect() {}
    disconnect() {
      this.disconnected = true;
    }
  }

  class FakeAudioContext {
    constructor(options = {}) {
      this.sampleRate = options.sampleRate ?? 48000;
      this.state = startSuspended ? 'suspended' : 'running';
      this.currentTime = 0;
      this.destination = {};
      this.closed = false;
      this.resumeCount = 0;
      this.gains = [];
      contexts.push(this);
    }
    createBuffer(channels, length, sampleRate) {
      return new FakeBuffer(length, sampleRate);
    }
    createBufferSource() {
      return new FakeSource();
    }
    createGain() {
      const gain = new FakeGain();
      this.gains.push(gain);
      return gain;
    }
    resume() {
      this.resumeCount++;
      this.state = 'running';
      return Promise.resolve();
    }
    close() {
      this.closed = true;
      this.state = 'closed';
      return Promise.resolve();
    }
  }

  class FakeAudio {
    constructor() {
      this.src = '';
      this.handlers = {};
      this.playCount = 0;
      this.pauseCount = 0;
      audio.push(this);
    }
    addEventListener(type, fn) {
      this.handlers[type] = fn;
    }
    play() {
      this.playCount++;
      return Promise.resolve();
    }
    pause() {
      this.pauseCount++;
    }
  }

  class FakeBlob {
    constructor(parts, options = {}) {
      this.parts = parts;
      this.type = options.type;
      this.id = ++blobId;
    }
  }

  const sandbox = {
    setTimeout: (fn, ms) => {
      const id = ++timerId;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    // Strict enough that a malformed chunk really throws, like the browser.
    atob: (b64) => {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new Error('invalid base64');
      return Buffer.from(b64, 'base64').toString('binary');
    },
    Blob: FakeBlob,
    Audio: FakeAudio,
    AudioContext: FakeAudioContext,
    URL: {
      createObjectURL: (blob) => {
        const url = `blob:${blob.id}`;
        blobs.push(blob);
        return url;
      },
      revokeObjectURL: (url) => revoked.push(url),
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: (msg) => {
          messages.push(msg);
          return Promise.resolve();
        },
      },
    },
    addEventListener() {},
    console: {
      log() {},
      warn() {},
      error: (...args) => errors.push(args.join(' ')),
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);

  return {
    sandbox,
    messages,
    revoked,
    blobs,
    sources,
    contexts,
    audio,
    errors,
    timers,
    fireTimers: () => {
      for (const [id, timer] of [...timers]) {
        timers.delete(id);
        timer.fn();
      }
    },
  };
}

// PLAYBACK_STATE messages as short labels: idle / playing / stopped.
function playbackStates(env) {
  return env.messages
    .filter((msg) => msg.type === 'PLAYBACK_STATE')
    .map((msg) => (msg.stopped ? 'stopped' : msg.playing ? 'playing' : 'idle'));
}

function pcmBase64(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((value, i) => buf.writeInt16LE(value, i * 2));
  return buf.toString('base64');
}

const wavBase64 = Buffer.from('RIFF0000WAVEfmt ').toString('base64');

test('pcm16ToFloat32 decodes little-endian signed 16-bit PCM', () => {
  const { sandbox } = loadOffscreen();
  const bytes = Uint8Array.from([0x00, 0x40, 0x00, 0xc0, 0xff, 0x7f, 0x00, 0x80, 0x7f]);
  const out = sandbox.pcm16ToFloat32(bytes);

  assert.strictEqual(out.length, 4, 'trailing odd byte is ignored');
  assert.strictEqual(out[0], 0.5);
  assert.strictEqual(out[1], -0.5);
  assert.strictEqual(out[2], 32767 / 32768);
  assert.strictEqual(out[3], -1);
});

test('base64ToBytes round-trips arbitrary bytes', () => {
  const { sandbox } = loadOffscreen();
  const bytes = sandbox.base64ToBytes(
    Buffer.from([0, 1, 127, 128, 254, 255]).toString('base64')
  );
  assert.deepStrictEqual(Array.from(bytes), [0, 1, 127, 128, 254, 255]);
});

test('PLAY_PCM schedules chunks back-to-back in order at the server rate', () => {
  const env = loadOffscreen();
  env.sandbox.onStreamStart();
  env.sandbox.onStreamChunk({ sampleRate: 24000, pcm: pcmBase64([100, -100]) });
  env.sandbox.onStreamChunk({ sampleRate: 24000, pcm: pcmBase64([200, -200]) });

  assert.strictEqual(env.contexts.length, 1, 'one context per stream');
  assert.strictEqual(env.contexts[0].sampleRate, 24000);
  assert.strictEqual(env.sources.length, 2);
  assert.strictEqual(env.sources[0].buffer.sampleRate, 24000);
  assert.strictEqual(env.sources[0].buffer.length, 2);
  assert.strictEqual(env.sources[0].buffer.data[0], 100 / 32768);
  assert.strictEqual(env.sources[0].startedAt, 0.06, 'first chunk starts after a short lead');
  assert.ok(
    Math.abs(env.sources[1].startedAt - (0.06 + 2 / 24000)) < 1e-12,
    'second chunk starts exactly when the first ends (no gap, no overlap)'
  );
});

test('a starved stream restarts with a lead instead of overlapping', () => {
  const env = loadOffscreen();
  env.sandbox.onStreamStart();
  env.sandbox.onStreamChunk({ sampleRate: 24000, pcm: pcmBase64([1, 2]) });

  env.contexts[0].currentTime = 5; // server fell 5 s behind real time
  env.sandbox.onStreamChunk({ sampleRate: 24000, pcm: pcmBase64([3, 4]) });

  assert.strictEqual(env.sources[1].startedAt, 5.06);
});

test('a suspended audio context is resumed', () => {
  const env = loadOffscreen({ startSuspended: true });
  env.sandbox.onStreamStart();
  env.sandbox.onStreamChunk({ sampleRate: 24000, pcm: pcmBase64([1, 2]) });

  assert.strictEqual(env.contexts[0].resumeCount, 1);
});

test('DONE_SENDING reports idle only after the scheduled audio ends', () => {
  const env = loadOffscreen();
  env.sandbox.onStreamStart();
  env.sandbox.onStreamChunk({ sampleRate: 24000, pcm: pcmBase64([1, 2]) });
  env.sandbox.onDoneSending();

  assert.deepStrictEqual(playbackStates(env), [], 'still playing');
  env.sources[0].onended();
  assert.deepStrictEqual(playbackStates(env), ['idle']);
});

test('a stream with no chunks reports idle straight away', () => {
  const env = loadOffscreen();
  env.sandbox.onStreamStart();
  env.sandbox.onDoneSending();

  assert.deepStrictEqual(playbackStates(env), ['idle']);
});

test('the end timer reports idle even if ended never fires', () => {
  const env = loadOffscreen();
  env.sandbox.onStreamStart();
  env.sandbox.onStreamChunk({ sampleRate: 24000, pcm: pcmBase64([1, 2]) });
  env.sandbox.onDoneSending();

  assert.strictEqual(env.timers.size, 1, 'a safety-net timer is armed');
  const timer = [...env.timers.values()][0];
  assert.ok(timer.ms > 250 && timer.ms < 400, `unexpected delay ${timer.ms}`);
  env.fireTimers();
  assert.deepStrictEqual(playbackStates(env), ['idle']);
});

test('STOP cancels stream audio, releases resources and reports stopped', () => {
  const env = loadOffscreen();
  env.sandbox.onStreamStart();
  env.sandbox.onStreamChunk({ sampleRate: 24000, pcm: pcmBase64([1, 2]) });
  env.sandbox.onStreamChunk({ sampleRate: 24000, pcm: pcmBase64([3, 4]) });
  const ctx = env.contexts[0];

  env.sandbox.onStop();

  assert.strictEqual(env.sources.length, 2);
  assert.ok(env.sources.every((s) => s.stopCount === 1 && s.disconnected));
  assert.ok(env.sources.every((s) => s.onended === null), 'no late idle notice');
  assert.strictEqual(ctx.gains[0].disconnected, true);
  assert.strictEqual(ctx.closed, true);
  assert.strictEqual(env.timers.size, 0);
  assert.deepStrictEqual(playbackStates(env), ['stopped']);
});

test('bad PCM chunks are ignored without breaking the stream', () => {
  const env = loadOffscreen();
  env.sandbox.onStreamStart();
  env.sandbox.onStreamChunk({ sampleRate: 24000, pcm: pcmBase64([1, 2]) });
  env.sandbox.onStreamChunk({ sampleRate: 24000, pcm: '' });
  env.sandbox.onStreamChunk({ sampleRate: 24000 });
  env.sandbox.onStreamChunk({ sampleRate: 24000, pcm: '!!!!' });
  env.sandbox.onStreamChunk({ sampleRate: 44100, pcm: pcmBase64([3, 4]) });
  env.sandbox.onStreamChunk({ sampleRate: 100, pcm: pcmBase64([5, 6]) });

  assert.strictEqual(env.sources.length, 1, 'only the good chunk was scheduled');
  assert.strictEqual(env.contexts.length, 1, 'no context churn');
  assert.strictEqual(env.errors.length, 2, 'each rejected chunk is logged');

  env.sandbox.onDoneSending();
  env.sources[0].onended();
  assert.deepStrictEqual(playbackStates(env), ['idle']);
});

test('PLAY_CHUNK keeps the existing WAV queue behaviour', () => {
  const env = loadOffscreen();
  env.sandbox.onPlayChunk({ index: 0, wav: wavBase64 });
  env.sandbox.onPlayChunk({ index: 1, wav: wavBase64 });

  assert.strictEqual(env.audio.length, 1);
  assert.strictEqual(env.blobs[0].type, 'audio/wav');
  assert.strictEqual(env.audio[0].src, 'blob:1');
  assert.strictEqual(env.audio[0].playCount, 1, 'only the first chunk starts');

  env.audio[0].handlers.ended();
  assert.deepStrictEqual(env.revoked, ['blob:1']);
  assert.strictEqual(env.audio[0].src, 'blob:2');
  assert.strictEqual(env.audio[0].playCount, 2);

  env.audio[0].handlers.ended();
  assert.deepStrictEqual(env.revoked, ['blob:1', 'blob:2']);
  assert.deepStrictEqual(playbackStates(env), [], 'no idle before DONE_SENDING');

  env.sandbox.onDoneSending();
  assert.deepStrictEqual(playbackStates(env), ['idle']);
});

test('STOP still cancels WAV playback and reports stopped', () => {
  const env = loadOffscreen();
  env.sandbox.onPlayChunk({ index: 0, wav: wavBase64 });
  env.sandbox.onPlayChunk({ index: 1, wav: wavBase64 });

  env.sandbox.onStop();

  assert.strictEqual(env.audio[0].pauseCount, 1);
  assert.deepStrictEqual(env.revoked, ['blob:1', 'blob:2']);
  assert.deepStrictEqual(playbackStates(env), ['stopped']);

  env.audio[0].handlers.ended();
  assert.deepStrictEqual(playbackStates(env), ['stopped'], 'nothing resumes after STOP');
});

test('starting one pipeline cancels the other', () => {
  const wavFirst = loadOffscreen();
  wavFirst.sandbox.onPlayChunk({ index: 0, wav: wavBase64 });
  wavFirst.sandbox.onStreamStart();
  assert.strictEqual(wavFirst.audio[0].pauseCount, 1);
  assert.deepStrictEqual(wavFirst.revoked, ['blob:1']);

  const streamFirst = loadOffscreen();
  streamFirst.sandbox.onStreamStart();
  streamFirst.sandbox.onStreamChunk({ sampleRate: 24000, pcm: pcmBase64([1, 2]) });
  streamFirst.sandbox.onPlayChunk({ index: 0, wav: wavBase64 });
  assert.strictEqual(streamFirst.sources[0].stopCount, 1);
  assert.strictEqual(streamFirst.audio[0].playCount, 1);
  assert.deepStrictEqual(playbackStates(streamFirst), [], 'no state change on switch');
});
