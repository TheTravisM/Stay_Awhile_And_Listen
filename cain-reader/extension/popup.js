const HEALTH_URL = "http://127.0.0.1:8765/health";
const SPEED_KEY = "speed";

const dot = document.getElementById("dot");
const statusText = document.getElementById("status-text");
const slider = document.getElementById("speed");
const speedLabel = document.getElementById("speed-value");
const stopBtn = document.getElementById("stop");

// Ping /health with a 2 s timeout; a failed/odd response means "offline".
async function checkHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(HEALTH_URL, { signal: controller.signal });
    if (!res.ok) throw new Error("unhealthy status");
    const data = await res.json();
    if (data && data.ok) {
      dot.classList.add("on");
      dot.classList.remove("off");
      statusText.textContent = "Server online (" + (data.engine || "unknown") + ")";
      return;
    }
    throw new Error("ok flag missing");
  } catch {
    dot.classList.remove("on");
    dot.classList.add("off");
    statusText.textContent = "Server offline";
  } finally {
    clearTimeout(timer);
  }
}

function showSpeed(v) {
  speedLabel.textContent = Number(v).toFixed(2);
}

slider.addEventListener("input", () => {
  const v = Number(slider.value);
  showSpeed(v);
  try {
    chrome.storage.sync.set({ [SPEED_KEY]: v }).catch(() => {});
  } catch {
    /* storage unavailable */
  }
});

stopBtn.addEventListener("click", () => {
  try {
    chrome.runtime.sendMessage({ target: "background", type: "STOP" }).catch(() => {});
  } catch {
    /* service worker not available */
  }
});

(async function init() {
  // Seed the slider from the persisted speed (default 1.0).
  let speed = 1.0;
  try {
    const n = Number((await chrome.storage.sync.get(SPEED_KEY))[SPEED_KEY]);
    if (Number.isFinite(n) && n > 0) speed = n;
  } catch {
    /* storage unavailable */
  }
  slider.value = String(speed);
  showSpeed(speed);
  checkHealth();
})();
