// Maverick hotkeys: each command is sent to the open Maverick tab as a "cue-action" event.
const CUE_URLS = ['http://localhost:5174/*', 'http://127.0.0.1:5174/*'];

async function sendToCue(command) {
  const [tab] = await chrome.tabs.query({ url: CUE_URLS });
  if (!tab) return false;
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: (action) => dispatchEvent(new CustomEvent('cue-action', { detail: action })),
    args: [command],
  });
  return true;
}

chrome.commands.onCommand.addListener((command) => { sendToCue(command).catch(() => {}); });
