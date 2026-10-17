import { chunkText } from "./chunker.js";

// storage.sync key for speech rate; the server applies it.
const SPEED_KEY = "speed";
// storage.session key for "a read is in progress"; survives the SW sleeping.
const ACTIVE_KEY = "active";
const TTS_URL = "http://127.0.0.1:8765/tts";
const TTS_STREAM_URL = "http://127.0.0.1:8765/tts/stream";
// Both endpoints take one request per read (server cap: 2000 characters), so
// longer reads keep using the chunked /tts path.
const MAX_REQUEST_CHARS = 2000;

// In-memory mirror of the persisted "active" flag; storage.session is the
// source of truth so the toggle survives the service worker sleeping.
let active = false;
let runId = 0;
let currentController = null;
let offscreenPromise = null;

class TtsError extends Error {
  constructor(status) {
    super("http " + status);
    this.status = status;
  }
}

// A rejected promise here must never stop the fetch loop (e.g. port closed,
// no listener yet). Rejects and sync throws both resolve to undefined.
function sendOffscreen(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime
        .sendMessage(msg)
        .then(() => resolve())
        .catch(() => resolve());
    } catch (err) {
      console.warn("cain: send to offscreen failed:", err);
      resolve();
    }
  });
}

function toast(tabId, text, kind) {
  if (tabId == null) return;
  try {
    chrome.tabs
      .sendMessage(tabId, { type: "TOAST", text, kind })
      .catch(() => {});
  } catch {
    /* content script not present on this tab */
  }
}

async function getSpeed() {
  try {
    const n = Number((await chrome.storage.sync.get(SPEED_KEY))[SPEED_KEY]);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* storage unavailable */
  }
  return 1.0;
}

// Stop the current read: abort fetches, invalidate runs, halt playback.
async function stopReading() {
  runId++;
  if (currentController) {
    currentController.abort();
    currentController = null;
  }
  await sendOffscreen({ target: "offscreen", type: "STOP" });
  await setActive(false);
}

// Persist the read-in-progress flag so it survives the service worker
// sleeping; the in-memory variable is just a cached mirror.
async function setActive(value) {
  active = value;
  try {
    await chrome.storage.session.set({ [ACTIVE_KEY]: value });
  } catch {
    /* storage unavailable */
  }
}

async function restoreActive() {
  try {
    active = !!(await chrome.storage.session.get(ACTIVE_KEY))[ACTIVE_KEY];
  } catch {
    active = false;
  }
}

// Bounded slices; never spread a large array into String.fromCharCode.
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const slice = 0x2000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += slice) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + slice));
  }
  return btoa(binary);
}

// The server always synthesizes at speed 1.0 and the selected speed is applied
// by the offscreen WAV player instead (`PLAY_CHUNK.rate`, pitch preserved).
// Stretching server-side is both audible (librosa's phase vocoder sounds
// echoey) and wasted work when the player is going to change the rate anyway.
async function fetchChunk(i, chunks, signal) {
  const res = await fetch(TTS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: chunks[i], speed: 1.0 }),
    signal,
  });
  if (!res.ok) throw new TtsError(res.status);
  return arrayBufferToBase64(await res.arrayBuffer());
}

// Start a chunk fetch but mark it handled. A run can exit (abort or a newer
// read) before awaiting a lookahead fetch, and an unhandled rejection there
// would show up as a service-worker console error on every failed read.
function prefetch(i, chunks, signal) {
  const p = fetchChunk(i, chunks, signal);
  p.catch(() => {});
  return p;
}

async function ensureOffscreen() {
  try {
    const ctxs = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (ctxs && ctxs.length > 0) return;
  } catch {
    /* getContexts unavailable; fall through to create */
  }
  if (!offscreenPromise) {
    const creation = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play synthesized speech",
    });
    offscreenPromise = creation;
    // Hold the promise only while creation is in flight. Once it settles the
    // cache must clear: Chrome closes an AUDIO_PLAYBACK offscreen document
    // ~30 s after it goes silent, so a stale resolved promise would make the
    // next read skip recreating it (getContexts() returns empty) and silently
    // drop its PLAY_CHUNK — first read plays, later reads are mute.
    creation.catch(() => {}).finally(() => {
      if (offscreenPromise === creation) offscreenPromise = null;
    });
  }
  await offscreenPromise;
}

// T12.4: incremental /tts/stream reading. The server emits newline-delimited
// JSON, one record per line, but a network read can split a line anywhere, so
// a line is only parsed once its terminating newline has arrived and the tail
// is kept for the next read. Nothing is buffered beyond that partial line.
// Pure (no chrome/DOM access) so it stays unit-testable.
function createNdjsonParser() {
  let buffered = "";
  const takeLines = () => {
    const records = [];
    let nl;
    while ((nl = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (line) records.push(JSON.parse(line));
    }
    return records;
  };
  return {
    push(text) {
      buffered += text;
      return takeLines();
    },
    flush() {
      const tail = buffered.trim();
      buffered = "";
      return tail ? [JSON.parse(tail)] : [];
    },
  };
}

// Read /tts/stream incrementally, forwarding each PCM chunk to the offscreen
// page as soon as it arrives. Returns "played", "fallback" (the server does not
// stream this request: old server, non-streaming engine, or speed != 1.0),
// "aborted" (Stop or a newer read) or "failed" (already toasted).
async function streamReading(text, signal, speed, tabId, myRun) {
  let res;
  try {
    res = await fetch(TTS_STREAM_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, speed }),
      signal,
    });
  } catch (err) {
    if (signal.aborted || (err && err.name === "AbortError")) return "aborted";
    const offline = err && err.name === "TypeError";
    toast(
      tabId,
      offline ? "Cain server offline — run server\\run.ps1" : "TTS error",
      "error"
    );
    await sendOffscreen({ target: "offscreen", type: "STOP" });
    await setActive(false);
    return "failed";
  }
  if (myRun !== runId) return "aborted";
  if (res.status === 400 || res.status === 404 || res.status === 501) {
    return "fallback";
  }
  if (!res.ok || !res.body) {
    toast(tabId, "TTS error", "error");
    await sendOffscreen({ target: "offscreen", type: "STOP" });
    await setActive(false);
    return "failed";
  }

  const parser = createNdjsonParser();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let offscreenReady = false;
  let sent = 0;
  let aborted = false;
  let streamError = false;

  const handle = async (record) => {
    if (aborted || streamError) return;
    // Checked before every send: a STOP or a newer read must not leave another
    // PLAY_PCM in flight behind the STOP message.
    if (myRun !== runId || signal.aborted) {
      aborted = true;
      return;
    }
    if (!record || typeof record !== "object") return;
    if (record.type === "error") {
      streamError = true;
      return;
    }
    if (record.type !== "chunk") return; // "done" needs no message of its own
    if (!offscreenReady) {
      // Created only once audio is actually arriving: Chrome force-closes an
      // AUDIO_PLAYBACK offscreen document 30 s after creation if it has not
      // started playing.
      try {
        await ensureOffscreen();
      } catch (err) {
        console.warn("cain: offscreen unavailable:", err);
        streamError = true;
        return;
      }
      if (myRun !== runId) {
        aborted = true;
        return;
      }
      offscreenReady = true;
      await sendOffscreen({ target: "offscreen", type: "STREAM_START" });
    }
    await sendOffscreen({
      target: "offscreen",
      type: "PLAY_PCM",
      sampleRate: record.sample_rate,
      pcm: record.audio,
    });
    sent++;
  };

  try {
    while (!aborted && !streamError) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const record of parser.push(decoder.decode(value, { stream: true }))) {
        await handle(record);
        if (aborted || streamError) break;
      }
    }
    if (!aborted && !streamError) {
      for (const record of parser.push(decoder.decode())) await handle(record);
      for (const record of parser.flush()) await handle(record);
    }
  } catch (err) {
    if (signal.aborted || (err && err.name === "AbortError")) {
      aborted = true;
    } else {
      console.warn("cain: stream read failed:", err);
      streamError = true;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed or aborted */
    }
  }

  if (aborted || myRun !== runId) return "aborted";
  if (streamError || sent === 0) {
    toast(tabId, "TTS error", "error");
    await sendOffscreen({ target: "offscreen", type: "STOP" });
    await setActive(false);
    return "failed";
  }
  await sendOffscreen({ target: "offscreen", type: "DONE_SENDING" });
  // active stays true; T5.3 clears it on PLAYBACK_STATE {playing:false}.
  return "played";
}

async function startReading(text, tabId) {
  // 1. stop any current read
  if (currentController) currentController.abort();
  currentController = new AbortController();
  const signal = currentController.signal;
  runId++;
  const myRun = runId;
  await setActive(true);
  await sendOffscreen({ target: "offscreen", type: "STOP" });
  if (myRun !== runId) return;

  // 2. chunk
  const { chunks, truncated } = chunkText(text);
  if (!chunks.length) {
    toast(tabId, "Select some text first");
    return;
  }
  if (truncated) toast(tabId, "Reading first 5,000 characters", "warn");

  const speed = await getSpeed();
  if (myRun !== runId) return;

  const fullText = chunks.join(" ");
  const fitsOneRequest = fullText.length <= MAX_REQUEST_CHARS;

  // 3. At speed 1.0 prefer the incremental stream: one request, audio played as
  // the server produces it. Anything the server cannot stream falls back to the
  // chunked /tts path below.
  if (speed === 1.0 && fitsOneRequest) {
    const outcome = await streamReading(fullText, signal, speed, tabId, myRun);
    if (outcome !== "fallback") return;
    if (myRun !== runId) return;
  }

  // 4. Any other speed cannot stream (the streaming engine only speaks at
  // speed=1.0), so while the text fits one request it goes to /tts whole and
  // the offscreen player applies the speed with pitch preserved; the server is
  // asked for speed 1.0 so nothing is stretched twice. Longer text keeps the
  // chunked path below, which also plays at the selected rate.
  if (speed !== 1.0 && fitsOneRequest) {
    await readViaChunks([fullText], signal, speed, tabId, myRun);
    return;
  }

  // 5. fetch chunks sequentially with one-chunk lookahead (max 2 in flight)
  await readViaChunks(chunks, signal, speed, tabId, myRun);
}

// `rate` is the selected speaking speed; every chunk is played at it with pitch
// preserved (the server synthesized it at 1.0).
async function readViaChunks(chunks, signal, rate, tabId, myRun) {
  const last = chunks.length - 1;

  let index = 0;
  let current = prefetch(0, chunks, signal);
  let pending = last >= 1 ? prefetch(1, chunks, signal) : null;
  let offscreenReady = false;

  while (index <= last) {
    if (myRun !== runId) return;
    let wav;
    try {
      wav = await current;
    } catch (err) {
      if (err && err.name === "AbortError") return; // 7. from Stop: ignore
      if (myRun !== runId) return;
      const offline = err && err.name === "TypeError";
      toast(
        tabId,
        offline ? "Cain server offline — run server\\run.ps1" : "TTS error",
        "error"
      );
      await sendOffscreen({ target: "offscreen", type: "STOP" });
      await setActive(false);
      return;
    }
    if (myRun !== runId) return;

    // 4. Create the offscreen document only when the first chunk is ready to
    // play. Chrome force-closes an AUDIO_PLAYBACK offscreen document 30 s
    // after creation if it has not started playing; creating it before the
    // (slow) first synthesis can make Chrome close it before any audio
    // arrives, silently dropping the PLAY_CHUNK.
    if (!offscreenReady) {
      try {
        await ensureOffscreen();
      } catch (err) {
        console.warn("cain: offscreen unavailable:", err);
        await setActive(false);
        return;
      }
      if (myRun !== runId) return;
      offscreenReady = true;
    }

    await sendOffscreen({
      target: "offscreen",
      type: "PLAY_CHUNK",
      index,
      wav,
      rate,
    });
    index++;
    if (index > last) break;
    current = pending;
    pending = null;
    if (index + 1 <= last) {
      pending = prefetch(index + 1, chunks, signal);
    }
  }

  if (myRun !== runId) return;
  await sendOffscreen({ target: "offscreen", type: "DONE_SENDING" });
  // active stays true; T5.3 clears it on PLAYBACK_STATE {playing:false}.
}

async function readSelection(tabId) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: "GET_SELECTION" });
    return resp?.text ?? "";
  } catch {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.getSelection().toString(),
      });
      return results?.[0]?.result ?? "";
    } catch {
      return null;
    }
  }
}

restoreActive();

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "cain-read",
    title: "Read with Cain",
    contexts: ["selection"],
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== "background") return;
  if (msg.type === "STOP") {
    stopReading();
    return;
  }
  if (msg.type === "PLAYBACK_STATE" && !msg.playing && !msg.stopped) {
    // msg.stopped marks the reply to a STOP that stopReading/startReading
    // sent; they already set active themselves.
    setActive(false);
    return;
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "cain-read") return;
  startReading(info.selectionText, tab?.id);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "read-selection") return;

  // Toggle: if a read is in progress, stop it; otherwise read the selection.
  if (active) {
    void stopReading();
    return;
  }

  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!tab?.id) return;

  const text = await readSelection(tab.id);
  if (text === null) {
    console.warn("cain: could not read selection on this tab");
    return;
  }
  if (!text.trim()) {
    toast(tab.id, "Select some text first");
    return;
  }
  startReading(text, tab.id);
});

// Exported only so node:test can drive this module (see
// tests/background.test.js); the service worker itself never imports it, so
// these exports are inert at runtime.
export const __test = { createNdjsonParser, startReading };
