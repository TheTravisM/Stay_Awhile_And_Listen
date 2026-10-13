import { chunkText } from "./chunker.js";

function startReading(text, tabId) {
  console.log(chunkText(text));
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
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return;

  const text = await readSelection(tab.id);
  if (text === null) {
    console.warn("cain: could not read selection on this tab");
    return;
  }
  if (!text.trim()) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "TOAST", text: "Select Some Text And Listen" });
    } catch {
      /* content script not present on this tab */
    }
    return;
  }
  startReading(text, tab.id);
});
