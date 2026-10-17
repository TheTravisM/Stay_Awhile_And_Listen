addEventListener("error", (e) => console.error("offscreen error:", e.message, e.filename, e.lineno));

const queue = [];
let current = null;
let doneSending = false;
const audio = new Audio();

audio.addEventListener("ended", () => playNext());

// --- Streaming PCM playback (T12.3) -----------------------------------------
// Messages handled here (all `{ target: "offscreen" }`):
//   PLAY_CHUNK   { index, wav }        one base64 WAV (existing path)
//   STREAM_START {}                    arm a streaming run; stops WAV playback
//   PLAY_PCM     { sampleRate, pcm }   one base64 little-endian signed 16-bit
//                                      MONO PCM chunk (no header); chunks must
//                                      arrive in order and are scheduled in
//                                      arrival order
//   DONE_SENDING                       no more audio (shared with the WAV path)
//   STOP                               cancel immediately (shared)
//
// Chunks are scheduled back-to-back on the Web Audio clock, so playback is
// gapless while chunks keep up with real time; a starved stream restarts with a
// short lead instead of overlapping itself. Only one pipeline plays at a time:
// starting either path cancels the other. Nothing is buffered beyond the audio
// already handed to the audio clock.
const STREAM_START_DELAY = 0.06; // s of lead time so the first chunk starts cleanly
const STREAM_END_SLACK_MS = 250; // extra wait before the safety-net idle notice
const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 96000;

let streamCtx = null;
let streamGain = null;
let streamRate = null;
let streamNextTime = 0;
let streamSources = new Set();
let streamActive = false;
let streamDone = false;
let streamIdleSent = false;
let streamEndTimer = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== "offscreen") return;
  if (msg.type === "PLAY_CHUNK") return onPlayChunk(msg);
  if (msg.type === "STREAM_START") return onStreamStart();
  if (msg.type === "PLAY_PCM") return onStreamChunk(msg);
  if (msg.type === "DONE_SENDING") return onDoneSending();
  if (msg.type === "STOP") return onStop();
});

function sendState(playing, stopped = false) {
  const message = { target: "background", type: "PLAYBACK_STATE", playing };
  if (stopped) message.stopped = true;
  chrome.runtime
    .sendMessage(message)
    .catch(() => { /* no listener has responded yet */ });
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64ToBlob(b64) {
  return new Blob([base64ToBytes(b64)], { type: "audio/wav" });
}

// Pure: little-endian signed 16-bit PCM -> float samples in [-1, 1). A trailing
// odd byte is ignored. Kept free of DOM/chrome access so it stays unit-testable.
function pcm16ToFloat32(bytes) {
  const count = Math.floor(bytes.length / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let value = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
    if (value >= 0x8000) value -= 0x10000;
    out[i] = value / 32768;
  }
  return out;
}

function start(item) {
  current = item;
  audio.src = item.url;
  audio.play().catch((err) => console.error("offscreen play failed:", err));
}

function playNext() {
  const prev = current;
  current = null;
  const item = queue.shift();
  if (prev) URL.revokeObjectURL(prev.url);
  if (!item) {
    if (doneSending) sendState(false);
    return;
  }
  start(item);
}

// Existing WAV path. Unchanged except that it also drops an active PCM stream,
// so two audio pipelines never play at once.
function onPlayChunk({ index, wav }) {
  if (streamActive) cancelStreamPlayback();
  const url = URL.createObjectURL(base64ToBlob(wav));
  const idle = current === null;
  queue.push({ index, url });
  if (idle) playNext();
}

function isSupportedRate(rate) {
  return Number.isFinite(rate) && rate >= MIN_SAMPLE_RATE && rate <= MAX_SAMPLE_RATE;
}

// One context per run, created at the server's sample rate so buffers need no
// resampling. A rate change mid-stream is refused rather than restarted, which
// would schedule audio on a second clock and overlap what is already playing.
function ensureStreamContext(sampleRate) {
  if (streamCtx && streamCtx.state !== "closed") {
    if (streamRate !== sampleRate) {
      console.warn("offscreen: ignoring sample-rate change mid-stream", streamRate, "->", sampleRate);
      return null;
    }
    return streamCtx;
  }
  const ctx = new AudioContext({ sampleRate });
  streamCtx = ctx;
  streamRate = sampleRate;
  streamNextTime = 0;
  streamGain = ctx.createGain();
  streamGain.connect(ctx.destination);
  if (ctx.state === "suspended" && typeof ctx.resume === "function") {
    ctx.resume().catch((err) => console.error("offscreen: audio resume failed:", err));
  }
  return ctx;
}

function beginStream() {
  cancelStreamPlayback();
  stopWavPlayback();
  streamActive = true;
  streamDone = false;
  streamIdleSent = false;
}

function onStreamStart() {
  beginStream();
}

function onStreamChunk(msg) {
  if (!msg || typeof msg.pcm !== "string" || msg.pcm.length === 0) return;
  if (!isSupportedRate(msg.sampleRate)) {
    console.error("offscreen: ignoring PCM chunk with unsupported sample rate", msg.sampleRate);
    return;
  }
  if (!streamActive) beginStream();

  let bytes;
  try {
    bytes = base64ToBytes(msg.pcm);
  } catch (err) {
    console.error("offscreen: ignoring undecodable PCM chunk:", err);
    return;
  }
  const samples = pcm16ToFloat32(bytes);
  if (!samples.length) return;

  const ctx = ensureStreamContext(msg.sampleRate);
  if (!ctx) return;

  const buffer = ctx.createBuffer(1, samples.length, msg.sampleRate);
  buffer.getChannelData(0).set(samples);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(streamGain);

  const now = ctx.currentTime;
  if (streamNextTime < now + STREAM_START_DELAY) streamNextTime = now + STREAM_START_DELAY;
  source.start(streamNextTime);
  streamNextTime += buffer.duration;

  streamSources.add(source);
  source.onended = () => {
    streamSources.delete(source);
    try {
      source.disconnect();
    } catch {
      /* already torn down */
    }
    maybeStreamIdle();
  };
}

// Safety net: if a scheduled source's `ended` event never arrives (suspended or
// closed context), still tell the background that playback finished, so the
// read-in-progress flag cannot stick.
function armStreamEndTimer() {
  if (!streamCtx) return;
  if (streamEndTimer !== null) clearTimeout(streamEndTimer);
  const remaining = Math.max(0, streamNextTime - streamCtx.currentTime) * 1000;
  streamEndTimer = setTimeout(() => {
    streamEndTimer = null;
    maybeStreamIdle(true);
  }, remaining + STREAM_END_SLACK_MS);
}

function maybeStreamIdle(force = false) {
  if (!streamActive || !streamDone || streamIdleSent) return;
  if (!force && streamSources.size > 0) return;
  streamIdleSent = true;
  finishStream();
}

function finishStream() {
  cancelStreamPlayback();
  sendState(false);
}

function onDoneSending() {
  doneSending = true;
  if (streamActive) {
    streamDone = true;
    armStreamEndTimer();
    maybeStreamIdle();
    return;
  }
  if (current === null && queue.length === 0) sendState(false);
}

// Stop and release everything the streaming path holds: scheduled sources, the
// gain node and the audio context. Clears late `ended` handlers so a cancelled
// stream cannot report idle after the fact.
function cancelStreamPlayback() {
  if (streamEndTimer !== null) {
    clearTimeout(streamEndTimer);
    streamEndTimer = null;
  }
  for (const source of streamSources) {
    source.onended = null;
    try {
      source.stop();
    } catch {
      /* already stopped */
    }
    try {
      source.disconnect();
    } catch {
      /* ignore */
    }
  }
  streamSources.clear();
  if (streamGain) {
    try {
      streamGain.disconnect();
    } catch {
      /* ignore */
    }
    streamGain = null;
  }
  if (streamCtx) {
    const ctx = streamCtx;
    streamCtx = null;
    try {
      ctx.close().catch(() => {});
    } catch {
      /* already closed */
    }
  }
  streamRate = null;
  streamNextTime = 0;
  streamActive = false;
  streamDone = false;
  streamIdleSent = false;
}

function stopWavPlayback() {
  audio.pause();
  if (current) {
    URL.revokeObjectURL(current.url);
    current = null;
  }
  for (const item of queue) URL.revokeObjectURL(item.url);
  queue.length = 0;
}

function onStop() {
  stopWavPlayback();
  cancelStreamPlayback();
  doneSending = false;
  sendState(false, true);
}
