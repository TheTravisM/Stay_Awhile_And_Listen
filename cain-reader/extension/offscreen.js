const queue = [];
let current = null;
let doneSending = false;
const audio = new Audio();

audio.addEventListener("ended", () => playNext());

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== "offscreen") return;
  if (msg.type === "PLAY_CHUNK") return onPlayChunk(msg);
  if (msg.type === "DONE_SENDING") return onDoneSending();
  if (msg.type === "STOP") return onStop();
});

function sendState(playing) {
  chrome.runtime
    .sendMessage({ target: "background", type: "PLAYBACK_STATE", playing })
    .catch(() => {});
}

function base64ToBlob(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: "audio/wav" });
}

function start(item) {
  current = item;
  audio.src = item.url;
  audio.play().catch(() => {});
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

function onPlayChunk({ index, wav }) {
  const url = URL.createObjectURL(base64ToBlob(wav));
  const idle = current === null;
  queue.push({ index, url });
  if (idle) playNext();
}

function onDoneSending() {
  doneSending = true;
  if (current === null && queue.length === 0) sendState(false);
}

function onStop() {
  audio.pause();
  if (current) {
    URL.revokeObjectURL(current.url);
    current = null;
  }
  for (const item of queue) URL.revokeObjectURL(item.url);
  queue.length = 0;
  doneSending = false;
  sendState(false);
}
