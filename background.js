import { CONFIG } from "./config.js";

const TICK = "tick";
const CLOSE_PREFIX = "close:";

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = ([min, max]) => min + Math.random() * (max - min);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- scheduling ----------

chrome.runtime.onInstalled.addListener(async () => {
  const { enabled } = await chrome.storage.local.get("enabled");
  if (enabled === undefined) await chrome.storage.local.set({ enabled: true });
  await scheduleNext();
});

chrome.runtime.onStartup.addListener(scheduleNext);

async function scheduleNext() {
  const mins = rand([CONFIG.minIntervalMin, CONFIG.maxIntervalMin]);
  await chrome.alarms.create(TICK, { delayInMinutes: mins });
  await chrome.storage.local.set({ nextRun: Date.now() + mins * 60_000 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === TICK) {
    await scheduleNext();
    const { enabled } = await chrome.storage.local.get("enabled");
    if (enabled && inActiveHours()) await runSession();
  } else if (alarm.name.startsWith(CLOSE_PREFIX)) {
    await closeWorker(Number(alarm.name.slice(CLOSE_PREFIX.length)));
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "runNow") {
    runSession().then(sendResponse);
    return true;
  }
});

function inActiveHours() {
  const [start, end] = CONFIG.activeHours;
  const h = new Date().getHours();
  return h >= start && h < end;
}

// ---------- sessions ----------

async function runSession() {
  if (await workerBusy()) return log("skipped: previous session still running");

  const kinds = Object.entries(CONFIG.weights).flatMap(([k, w]) => Array(w).fill(k));
  const kind = pick(kinds);
  try {
    if (kind === "site") return await visitSite();
    if (kind === "youtube") return await watchYouTube();
    if (kind === "search") return await googleSearch();
  } catch (e) {
    return log(`error (${kind}): ${e.message}`);
  }
}

async function visitSite() {
  const url = pick(CONFIG.sites);
  const { winId, tabId } = await openWorker(url);
  const dwell = rand(CONFIG.siteDwellSec);
  await waitForLoad(tabId);
  await inject(tabId, browseLikeAHuman, [dwell]);
  await scheduleClose(winId, dwell + 10);
  return log(`site: ${url}`);
}

async function googleSearch() {
  const q = pick(CONFIG.googleSearches);
  const url = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  const { winId, tabId } = await openWorker(url);
  const dwell = rand(CONFIG.siteDwellSec);
  await waitForLoad(tabId);
  await inject(tabId, clickSearchResult, []);
  await sleep(4000);
  await waitForLoad(tabId);
  await inject(tabId, browseLikeAHuman, [dwell]);
  await scheduleClose(winId, dwell + 10);
  return log(`search: "${q}"`);
}

async function watchYouTube() {
  const useChannel = CONFIG.youtubeChannels.length && Math.random() < 0.35;
  const label = useChannel ? pick(CONFIG.youtubeChannels) : pick(CONFIG.youtubeSearches);
  const listUrl = useChannel
    ? `https://www.youtube.com/${label}/videos`
    : `https://www.youtube.com/results?search_query=${encodeURIComponent(label)}`;

  const { winId, tabId } = await openWorker(listUrl);
  await waitForLoad(tabId);
  await sleep(3000); // let YouTube render its results

  const [{ result: links }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () =>
      [...document.querySelectorAll('a[href*="/watch?v="]')]
        .map((a) => a.href.split("&")[0])
        .filter((h, i, all) => all.indexOf(h) === i)
        .slice(0, 6),
  });
  if (!links?.length) {
    await closeWorker(winId);
    return log(`youtube: no videos found for ${label}`);
  }

  const video = pick(links);
  await chrome.tabs.update(tabId, { url: video });
  await waitForLoad(tabId);
  await sleep(3000);
  await inject(tabId, () => document.querySelector("video")?.play().catch(() => {}), []);

  const mins = rand(CONFIG.watchMin);
  await scheduleClose(winId, mins * 60);
  return log(`youtube (${label}): ${video} for ${mins.toFixed(1)} min`);
}

// ---------- worker window ----------

async function openWorker(url) {
  const { state, ...bounds } = CONFIG.window;
  const win = await chrome.windows.create({
    url,
    focused: false,
    type: "normal",
    ...(state === "minimized" ? { state } : bounds),
  });
  const tabId = win.tabs[0].id;
  await chrome.tabs.update(tabId, { muted: true });
  await chrome.storage.session.set({ workerWindow: win.id });
  return { winId: win.id, tabId };
}

async function workerBusy() {
  const { workerWindow } = await chrome.storage.session.get("workerWindow");
  if (!workerWindow) return false;
  try {
    await chrome.windows.get(workerWindow);
    return true;
  } catch {
    return false;
  }
}

async function scheduleClose(winId, seconds) {
  await chrome.alarms.create(CLOSE_PREFIX + winId, { delayInMinutes: Math.max(seconds, 30) / 60 });
}

async function closeWorker(winId) {
  await chrome.windows.remove(winId).catch(() => {});
  await chrome.storage.session.remove("workerWindow");
}

function waitForLoad(tabId, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id, info) => id === tabId && info.status === "complete" && done();
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((t) => t.status === "complete" && done()).catch(done);
  });
}

async function inject(tabId, func, args) {
  await chrome.scripting.executeScript({ target: { tabId }, func, args }).catch(() => {});
}

async function log(message) {
  const { history = [] } = await chrome.storage.local.get("history");
  history.unshift({ at: Date.now(), message });
  await chrome.storage.local.set({ history: history.slice(0, 30) });
  return message;
}

// ---------- functions injected into pages ----------

// Scrolls down in uneven steps, pauses, occasionally scrolls back up,
// and halfway through may open one same-site link.
function browseLikeAHuman(dwellSec) {
  const end = Date.now() + dwellSec * 1000;
  const half = Date.now() + (dwellSec * 1000) / 2;
  let clicked = false;
  const step = () => {
    if (Date.now() > end) return;
    const dir = Math.random() < 0.15 ? -1 : 1;
    window.scrollBy({ top: dir * (150 + Math.random() * 500), behavior: "smooth" });
    if (!clicked && Date.now() > half && Math.random() < 0.5) {
      clicked = true;
      const links = [...document.querySelectorAll("a[href]")].filter(
        (a) => a.host === location.host && a.offsetParent && !a.href.includes("#")
      );
      if (links.length) return links[Math.floor(Math.random() * Math.min(links.length, 40))].click();
    }
    setTimeout(step, 2000 + Math.random() * 6000);
  };
  setTimeout(step, 1500);
}

function clickSearchResult() {
  const results = [...document.querySelectorAll("#search a h3")].map((h) => h.closest("a"));
  const target = results[Math.floor(Math.random() * Math.min(results.length, 5))];
  target?.click();
}
