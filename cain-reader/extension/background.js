import { chunkText } from "./chunker.js";

// storage.sync key for speech rate; the server applies it.
const SPEED_KEY = "speed";
const TTS_URL = "http://127.0.0.1:8765/tts";

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

async function fetchChunk(i, chunks, signal, speed) {
  const res = await fetch(TTS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: chunks[i], speed }),
    signal,
  });
  if (!res.ok) throw new TtsError(res.status);
  return arrayBufferToBase64(await res.arrayBuffer());
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
    offscreenPromise = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play synthesized speech",
    });
    offscreenPromise.catch(() => {
      offscreenPromise = null;
    });
  }
  await offscreenPromise;
}

async function startReading(text, tabId) {
  // 1. stop any current read
  if (currentController) currentController.abort();
  currentController = new AbortController();
  const signal = currentController.signal;
  runId++;
  const myRun = runId;
  active = true;
  await sendOffscreen({ target: "offscreen", type: "STOP" });

  // 2. chunk
  const { chunks, truncated } = chunkText(text);
  if (!chunks.length) {
    toast(tabId, "Select Some Text And Listen");
    return;
  }
  if (truncated) toast(tabId, "Reading first 5,000 characters", "warn");

  // 3. offscreen doc
  try {
    await ensureOffscreen();
  } catch (err) {
    console.warn("cain: offscreen unavailable:", err);
    return;
  }
  if (myRun !== runId) return;

  // 4. fetch sequentially with one-chunk lookahead (max 2 in flight)
  const last = chunks.length - 1;
  const speed = await getSpeed();
  if (myRun !== runId) return;

  let index = 0;
  let current = fetchChunk(0, chunks, signal, speed);
  let pending = last >= 1 ? fetchChunk(1, chunks, signal, speed) : null;

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
      active = false;
      return;
    }
    if (myRun !== runId) return;
    await sendOffscreen({
      target: "offscreen",
      type: "PLAY_CHUNK",
      index,
      wav,
    });
    index++;
    if (index > last) break;
    current = pending;
    pending = null;
    if (index + 1 <= last) {
      pending = fetchChunk(index + 1, chunks, signal, speed);
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

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "cain-read",
    title: "Read with Cain",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "cain-read") return;
  startReading(info.selectionText, tab?.id);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "read-selection") return;
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
    toast(tab.id, "Select Some Text And Listen");
    return;
  }
  startReading(text, tab.id);
});
