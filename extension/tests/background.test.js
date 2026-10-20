import { test } from 'node:test';
import assert from 'node:assert';

// T12.4: background.js is a service-worker module with no importers, so the
// only way to exercise its real streaming code is to stub the handful of
// chrome APIs it touches while loading and then drive startReading() directly.
// Nothing here changes a production file.

const env = {
  offscreen: [], // messages sent to the offscreen document
  toasts: [], // messages sent to content scripts
  active: false,
  speed: 1,
  created: 0,
  fetch: null,
  listeners: {},
  onOffscreenMessage: null,
};

globalThis.chrome = {
  runtime: {
    onMessage: {
      addListener: (fn) => {
        env.listeners.message = fn;
      },
    },
    onInstalled: { addListener: () => {} },
    getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }],
    sendMessage: async (msg) => {
      env.offscreen.push(msg);
      if (env.onOffscreenMessage) await env.onOffscreenMessage(msg);
    },
  },
  offscreen: {
    createDocument: async () => {
      env.created++;
    },
  },
  storage: {
    sync: { get: async () => ({ speed: env.speed }) },
    session: {
      get: async () => ({ active: env.active }),
      set: async (values) => {
        if ('active' in values) env.active = values.active;
      },
    },
  },
  tabs: {
    query: async () => [{ id: 7 }],
    sendMessage: async (tabId, msg) => {
      env.toasts.push(msg);
    },
  },
  contextMenus: { onClicked: { addListener: () => {} } },
  commands: {
    onCommand: {
      addListener: (fn) => {
        env.listeners.command = fn;
      },
    },
  },
};

globalThis.fetch = (url, init) => env.fetch(url, init);

const bg = await import('../background.js');

const STREAM_URL = 'http://127.0.0.1:8765/tts/stream';
const TTS_URL = 'http://127.0.0.1:8765/tts';

function setup() {
  env.offscreen.length = 0;
  env.toasts.length = 0;
  env.active = false;
  env.speed = 1;
  env.created = 0;
  env.onOffscreenMessage = null;
  env.fetch = async () => {
    throw new Error('fetch was not stubbed');
  };
  return env;
}

const offscreenTypes = () => env.offscreen.map((msg) => msg.type);
const pcmChunks = () => env.offscreen.filter((msg) => msg.type === 'PLAY_PCM');
const playChunkRates = () =>
  env.offscreen.filter((msg) => msg.type === 'PLAY_CHUNK').map((msg) => msg.rate);

function chunkRecord(index, audio, sampleRate = 24000) {
  return `${JSON.stringify({
    type: 'chunk',
    index,
    sample_rate: sampleRate,
    channels: 1,
    encoding: 'pcm_s16le',
    samples: 2,
    audio,
  })}\n`;
}

// A fake /tts/stream body delivered in small reads, so records are deliberately
// split across network reads.
function streamBody(text, { status = 200, chunkSize = 7 } = {}) {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.subarray(i, i + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(body, { status });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('the NDJSON parser only emits a record once its line is complete', () => {
  const parser = bg.__test.createNdjsonParser();
  assert.deepStrictEqual(parser.push('{"type":"chu'), []);
  assert.deepStrictEqual(parser.push('nk","index":0}\n{"type":"chunk","index":1}'), [
    { type: 'chunk', index: 0 },
  ]);
  assert.deepStrictEqual(parser.push('\n'), [{ type: 'chunk', index: 1 }]);
  assert.deepStrictEqual(parser.push('\n\n'), []);
  assert.deepStrictEqual(parser.flush(), []);
});

test('the NDJSON parser flushes a trailing record and rejects bad JSON', () => {
  const parser = bg.__test.createNdjsonParser();
  assert.deepStrictEqual(parser.push('{"a":1}\n{"b":2}'), [{ a: 1 }]);
  assert.deepStrictEqual(parser.flush(), [{ b: 2 }]);
  assert.deepStrictEqual(parser.flush(), []);

  assert.throws(() => bg.__test.createNdjsonParser().push('{oops}\n'), SyntaxError);
});

test('a streamed read forwards PCM chunks in order as they arrive', async () => {
  setup();
  const urls = [];
  env.fetch = async (url, init) => {
    urls.push(url);
    assert.deepStrictEqual(JSON.parse(init.body), {
      text: 'Stay awhile and listen.',
      speed: 1,
    });
    return streamBody(chunkRecord(0, 'AAAA') + chunkRecord(1, 'AAAB') + '{"type":"done"}\n');
  };

  await bg.__test.startReading('Stay awhile and listen.', 7);

  assert.deepStrictEqual(urls, [STREAM_URL]);
  assert.deepStrictEqual(offscreenTypes(), [
    'STOP',
    'STREAM_START',
    'PLAY_PCM',
    'PLAY_PCM',
    'DONE_SENDING',
  ]);
  assert.deepStrictEqual(pcmChunks().map((msg) => msg.pcm), ['AAAA', 'AAAB']);
  assert.deepStrictEqual(pcmChunks().map((msg) => msg.sampleRate), [24000, 24000]);
  assert.strictEqual(env.active, true, 'active stays true until playback ends');
});

test('chunks reach the offscreen page while the response is still open', async () => {
  setup();
  let release;
  env.fetch = async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(chunkRecord(0, 'AAAA')));
        release = () => {
          controller.enqueue(new TextEncoder().encode(chunkRecord(1, 'AAAB')));
          controller.close();
        };
      },
    });
    return new Response(body, { status: 200 });
  };

  const reading = bg.__test.startReading('Stay awhile and listen.', 7);
  await waitFor(() => pcmChunks().length === 1);

  // The response is still streaming: the first chunk was already played and
  // nothing was buffered waiting for the end of the body.
  assert.deepStrictEqual(offscreenTypes(), ['STOP', 'STREAM_START', 'PLAY_PCM']);

  release();
  await reading;
  assert.deepStrictEqual(offscreenTypes(), [
    'STOP',
    'STREAM_START',
    'PLAY_PCM',
    'PLAY_PCM',
    'DONE_SENDING',
  ]);
});

test('a non-streaming server falls back to the chunked /tts path', async () => {
  setup();
  const urls = [];
  env.fetch = async (url) => {
    urls.push(url);
    if (url === STREAM_URL) return new Response('{"error":"no streaming"}', { status: 501 });
    return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
  };

  await bg.__test.startReading('Stay awhile and listen.', 7);

  assert.deepStrictEqual(urls, [STREAM_URL, TTS_URL]);
  assert.deepStrictEqual(offscreenTypes(), ['STOP', 'PLAY_CHUNK', 'DONE_SENDING']);
  assert.deepStrictEqual(playChunkRates(), [1.0], 'speed 1.0 plays at rate 1.0');
});

test('speed != 1.0 sends the whole text to /tts unstretched and plays it at that rate', async () => {
  setup();
  env.speed = 1.25;
  const urls = [];
  const bodies = [];
  env.fetch = async (url, init) => {
    urls.push(url);
    bodies.push(JSON.parse(init.body));
    return new Response(new Uint8Array([1, 2]), { status: 200 });
  };

  await bg.__test.startReading('Stay awhile and listen. Say it again, please.', 7);

  // One request, and the server is asked for speed 1.0: the offscreen player
  // applies 1.25 with pitch preserved, so nothing is stretched twice and no
  // phase-vocoder echo is added.
  assert.deepStrictEqual(urls, [TTS_URL]);
  assert.deepStrictEqual(bodies, [
    { text: 'Stay awhile and listen. Say it again, please.', speed: 1 },
  ]);
  assert.deepStrictEqual(playChunkRates(), [1.25]);
  assert.deepStrictEqual(offscreenTypes(), ['STOP', 'PLAY_CHUNK', 'DONE_SENDING']);
});

test('a read over the stream limit goes straight to /tts', async () => {
  setup();
  const urls = [];
  env.fetch = async (url) => {
    urls.push(url);
    return new Response(new Uint8Array([1, 2]), { status: 200 });
  };
  const long = 'The quick brown fox jumps over the lazy dog. '.repeat(60);

  await bg.__test.startReading(long, 7);

  assert.ok(!urls.includes(STREAM_URL), 'no stream request for a long read');
  assert.ok(urls.length > 1, 'chunked /tts requests');
});

test('a dead server toasts the offline message and stops', async () => {
  setup();
  env.fetch = async () => {
    throw new TypeError('fetch failed');
  };

  await bg.__test.startReading('Stay awhile and listen.', 7);

  assert.deepStrictEqual(
    env.toasts.map((msg) => msg.text),
    ['Cain server offline — run server\\run.ps1']
  );
  assert.deepStrictEqual(offscreenTypes(), ['STOP', 'STOP']);
  assert.strictEqual(env.active, false);
});

test('an error record toasts and stops the read', async () => {
  setup();
  env.fetch = async () =>
    streamBody('{"type":"error","error":"streaming produced no audio"}\n');

  await bg.__test.startReading('Stay awhile and listen.', 7);

  assert.deepStrictEqual(env.toasts.map((msg) => msg.text), ['TTS error']);
  assert.deepStrictEqual(offscreenTypes(), ['STOP', 'STOP']);
  assert.strictEqual(env.active, false);
});

test('a stream that produced no audio toasts and stops', async () => {
  setup();
  env.fetch = async () => streamBody('{"type":"done","chunks":0}\n');

  await bg.__test.startReading('Stay awhile and listen.', 7);

  assert.deepStrictEqual(env.toasts.map((msg) => msg.text), ['TTS error']);
  assert.deepStrictEqual(offscreenTypes(), ['STOP', 'STOP']);
  assert.strictEqual(env.active, false);
});

test('a server error on /tts/stream toasts and stops without falling back', async () => {
  setup();
  const urls = [];
  env.fetch = async (url) => {
    urls.push(url);
    return new Response('{"error":"boom"}', { status: 500 });
  };

  await bg.__test.startReading('Stay awhile and listen.', 7);

  assert.deepStrictEqual(urls, [STREAM_URL]);
  assert.deepStrictEqual(env.toasts.map((msg) => msg.text), ['TTS error']);
  assert.deepStrictEqual(offscreenTypes(), ['STOP', 'STOP']);
  assert.strictEqual(env.active, false);
});

test('STOP mid-stream stops further chunks and sends no DONE_SENDING', async () => {
  setup();
  let release;
  env.fetch = async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(chunkRecord(0, 'AAAA')));
        release = () => {
          controller.enqueue(new TextEncoder().encode(chunkRecord(1, 'AAAB')));
          controller.close();
        };
      },
    });
    return new Response(body, { status: 200 });
  };

  const reading = bg.__test.startReading('Stay awhile and listen.', 7);
  await waitFor(() => pcmChunks().length === 1);

  // The shortcut toggle path: the background listener aborts the fetch and
  // invalidates the run.
  env.listeners.message({ target: 'background', type: 'STOP' });
  release();
  await reading;

  assert.deepStrictEqual(pcmChunks().map((msg) => msg.pcm), ['AAAA']);
  assert.deepStrictEqual(offscreenTypes(), ['STOP', 'STREAM_START', 'PLAY_PCM', 'STOP']);
  await waitFor(() => env.active === false);
});

// --- speed control (T12.6) ---------------------------------------------------

test('speed 1.0 still streams the whole text in one request', async () => {
  setup();
  const urls = [];
  env.fetch = async (url, init) => {
    urls.push(url);
    assert.deepStrictEqual(JSON.parse(init.body), {
      text: 'Stay awhile and listen. Say it again, please.',
      speed: 1,
    });
    return streamBody(chunkRecord(0, 'AAAA') + '{"type":"done"}\n');
  };

  await bg.__test.startReading('Stay awhile and listen. Say it again, please.', 7);

  assert.deepStrictEqual(urls, [STREAM_URL]);
  assert.deepStrictEqual(offscreenTypes(), [
    'STOP',
    'STREAM_START',
    'PLAY_PCM',
    'DONE_SENDING',
  ]);
});

test('a long read at speed != 1.0 keeps the chunked /tts path', async () => {
  setup();
  env.speed = 1.5;
  const urls = [];
  const bodies = [];
  env.fetch = async (url, init) => {
    urls.push(url);
    bodies.push(JSON.parse(init.body));
    return new Response(new Uint8Array([1, 2]), { status: 200 });
  };
  const long = 'The quick brown fox jumps over the lazy dog. '.repeat(60);

  await bg.__test.startReading(long, 7);

  assert.ok(!urls.includes(STREAM_URL), 'no stream request for a long read');
  assert.ok(urls.length > 1, 'chunked /tts requests');
  assert.ok(
    bodies.every((body) => body.speed === 1),
    'synthesis is never stretched server-side'
  );
  const rates = playChunkRates();
  assert.ok(rates.length > 1, 'every chunk is played');
  assert.ok(
    rates.every((rate) => rate === 1.5),
    'every chunk plays at the selected speed'
  );
});

test('a dead server at speed != 1.0 still toasts offline and stops', async () => {
  setup();
  env.speed = 0.75;
  env.fetch = async () => {
    throw new TypeError('fetch failed');
  };

  await bg.__test.startReading('Stay awhile and listen.', 7);

  assert.deepStrictEqual(
    env.toasts.map((msg) => msg.text),
    ['Cain server offline — run server\\run.ps1']
  );
  assert.deepStrictEqual(offscreenTypes(), ['STOP', 'STOP']);
  assert.strictEqual(env.active, false);
});

test('a /tts error at speed != 1.0 toasts and stops', async () => {
  setup();
  env.speed = 1.5;
  env.fetch = async () => new Response('{"error":"boom"}', { status: 500 });

  await bg.__test.startReading('Stay awhile and listen.', 7);

  assert.deepStrictEqual(env.toasts.map((msg) => msg.text), ['TTS error']);
  assert.deepStrictEqual(offscreenTypes(), ['STOP', 'STOP']);
  assert.strictEqual(env.active, false);
});

test('STOP during a speed != 1.0 read aborts it without playing', async () => {
  setup();
  env.speed = 1.5;
  let signal = null;
  env.fetch = async (url, init) => {
    signal = init.signal;
    return await new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError'))
      );
    });
  };

  const reading = bg.__test.startReading('Stay awhile and listen.', 7);
  await waitFor(() => signal != null);
  env.listeners.message({ target: 'background', type: 'STOP' });
  await reading;

  assert.deepStrictEqual(offscreenTypes(), ['STOP', 'STOP']);
  assert.strictEqual(pcmChunks().length, 0);
  await waitFor(() => env.active === false);
});

test('an empty selection does not leave the active flag set', async () => {
  setup();

  await bg.__test.startReading('   ', 7);

  assert.deepStrictEqual(env.toasts.map((msg) => msg.text), ['Select some text first']);
  assert.strictEqual(env.active, false);
});

test('a superseded failed read cannot clear the newer read flag', async () => {
  setup();
  let failFetch;
  env.fetch = () =>
    new Promise((resolve, reject) => {
      failFetch = reject;
    });

  const first = bg.__test.startReading('First read.', 7);
  await waitFor(() => failFetch != null);

  // The second read starts while the first is reporting its failure: the first
  // awaits the STOP message, which is the window where a newer run can slip in.
  env.fetch = async () => streamBody(chunkRecord(0, 'AAAA') + '{"type":"done"}\n');
  let second = null;
  env.onOffscreenMessage = (msg) => {
    if (msg.type === 'STOP' && !second) {
      second = bg.__test.startReading('Second read.', 7);
      return second;
    }
  };

  failFetch(new TypeError('fetch failed'));
  await first;
  await second;

  assert.strictEqual(env.active, true, 'the newer read still owns the flag');
});

test('the hotkey stops a read restored from storage', async () => {
  setup();
  // Re-evaluate the module to simulate a service worker restart: the new
  // instance starts with empty in-memory state, while the persisted flag says
  // a read is still playing.
  env.active = true;
  await import('../background.js?restart=1');
  env.offscreen.length = 0;
  env.toasts.length = 0;

  await env.listeners.command('read-selection');

  assert.deepStrictEqual(offscreenTypes(), ['STOP']);
  await waitFor(() => env.active === false);
  assert.deepStrictEqual(env.toasts, [], 'no new read was started');
});
