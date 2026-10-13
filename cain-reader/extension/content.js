let host = null;

function getHost() {
  if (!host) {
    host = document.createElement("div");
    host.style.position = "fixed";
    host.style.bottom = "16px";
    host.style.right = "16px";
    host.style.zIndex = "2147483647";
    document.documentElement.appendChild(host);
  }
  return host;
}

function showToast(text, kind) {
  const host = getHost();
  const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
  const toast = document.createElement("div");
  toast.textContent = text;
  const color = kind === "error" ? "#b00020" : kind === "warn" ? "#8a6d00" : "#111111";
  shadow.appendChild(toast);
  toast.style.cssText =
    "position:fixed;bottom:16px;right:16px;z-index:2147483647;" +
    "background:rgba(17,17,17,0.92);color:#f5f5f5;" +
    "border:1px solid " + color + ";" +
    "padding:10px 14px;border-radius:6px;" +
    "font:13px/1.4 system-ui,sans-serif;max-width:280px;";
  setTimeout(() => toast.remove(), 3000);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GET_SELECTION") {
    sendResponse({ text: window.getSelection().toString() });
    return;
  }
  if (msg.type === "TOAST") {
    showToast(msg.text, msg.kind);
    sendResponse({ ok: true });
  }
});
