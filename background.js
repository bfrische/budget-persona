import { CONFIG } from "./config.js";

const TICK = "tick";
const CLOSE_PREFIX = "close:";
const MAX_LOG = 300;

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = ([min, max]) => min + Math.random() * (max - min);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// ---------- logging ----------

// Every entry goes to chrome.storage (shown live in the popup) and to the
// service worker console (chrome://extensions → Budget Persona → "service worker").
// `session` groups the steps of one run so the popup can show them together.
let logQueue = Promise.resolve();

function log(level, message, session = null) {
  const entry = { at: Date.now(), level, message, session };
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(
    `[budget-persona]${session ? ` #${session}` : ""} ${level}: ${message}`
  );
  // Serialize writes so concurrent logs don't clobber each other.
  logQueue = logQueue.then(async () => {
    const { history = [] } = await chrome.storage.local.get("history");
    history.unshift(entry);
    await chrome.storage.local.set({ history: history.slice(0, MAX_LOG) });
  });
  return logQueue.then(() => message);
}

self.addEventListener("error", (e) => log("error", `uncaught: ${e.message}`));
self.addEventListener("unhandledrejection", (e) => log("error", `unhandled rejection: ${e.reason?.message ?? e.reason}`));

// ---------- scheduling ----------

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { enabled } = await chrome.storage.local.get("enabled");
  if (enabled === undefined) await chrome.storage.local.set({ enabled: true });
  await log("info", `extension ${reason}`);
  await scheduleNext();
});

chrome.runtime.onStartup.addListener(async () => {
  await log("info", "Chrome started");
  await scheduleNext();
});

async function scheduleNext() {
  const mins = rand([CONFIG.minIntervalMin, CONFIG.maxIntervalMin]);
  const when = Date.now() + mins * 60_000;
  await chrome.alarms.create(TICK, { when });
  await chrome.storage.local.set({ nextRun: when });
  await log("info", `next session scheduled for ${clock(when)} (in ${mins.toFixed(0)} min)`);
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === TICK) {
    await log("info", "timer fired");
    await scheduleNext();
    const { enabled } = await chrome.storage.local.get("enabled");
    if (!enabled) return log("warn", "skipped: extension is paused");
    if (!inActiveHours()) {
      const [start, end] = CONFIG.activeHours;
      return log("warn", `skipped: outside active hours (${start}:00–${end}:00)`);
    }
    await runSession();
  } else if (alarm.name.startsWith(CLOSE_PREFIX)) {
    const [winId, session] = alarm.name.slice(CLOSE_PREFIX.length).split(":");
    await closeWorker(Number(winId), session);
  }
});

chrome.windows.onRemoved.addListener(async (winId) => {
  const { workerWindow, workerSession } = await chrome.storage.session.get(["workerWindow", "workerSession"]);
  if (winId !== workerWindow) return;
  await chrome.storage.session.remove(["workerWindow", "workerSession"]);
  await log("warn", "worker window was closed early (by you or Chrome)", workerSession);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "runNow") {
    log("info", "manual run requested from popup").then(runSession).then(sendResponse);
    return true;
  }
  if (msg.type === "status") {
    status().then(sendResponse);
    return true;
  }
});

function inActiveHours() {
  const [start, end] = CONFIG.activeHours;
  const h = new Date().getHours();
  return h >= start && h < end;
}

async function status() {
  const [{ enabled }, tick, { workerWindow, workerSession }] = await Promise.all([
    chrome.storage.local.get("enabled"),
    chrome.alarms.get(TICK),
    chrome.storage.session.get(["workerWindow", "workerSession"]),
  ]);
  const closeAlarm = workerWindow ? (await chrome.alarms.getAll()).find((a) => a.name.startsWith(CLOSE_PREFIX + workerWindow + ":")) : null;
  return {
    enabled: !!enabled,
    activeHours: CONFIG.activeHours,
    inActiveHours: inActiveHours(),
    nextRun: tick?.scheduledTime ?? null,
    worker: workerWindow ? { session: workerSession, closesAt: closeAlarm?.scheduledTime ?? null } : null,
  };
}

// ---------- sessions ----------

async function runSession() {
  if (await workerBusy()) return log("warn", "skipped: previous session's window is still open");

  const session = Math.random().toString(36).slice(2, 6);
  const kinds = Object.entries(CONFIG.weights).flatMap(([k, w]) => Array(w).fill(k));
  const kind = pick(kinds);
  await log("info", `session started: ${kind}`, session);
  try {
    if (kind === "site") return await visitSite(session);
    if (kind === "youtube") return await watchYouTube(session);
    if (kind === "search") return await googleSearch(session);
  } catch (e) {
    return log("error", `session failed: ${e.message}`, session);
  }
}

async function visitSite(session) {
  const url = pick(CONFIG.sites);
  const { winId, tabId } = await openWorker(url, session);
  const dwell = rand(CONFIG.siteDwellSec);
  await waitForLoad(tabId, session);
  await logPage(tabId, session);
  await inject(tabId, browseLikeAHuman, [dwell], session, `scrolling for ${dwell.toFixed(0)}s`);
  await scheduleClose(winId, dwell + 10, session);
}

async function googleSearch(session) {
  const q = pick(CONFIG.googleSearches);
  const url = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  await log("info", `searching Google for "${q}"`, session);
  const { winId, tabId } = await openWorker(url, session);
  const dwell = rand(CONFIG.siteDwellSec);
  await waitForLoad(tabId, session);
  await logPage(tabId, session);

  const clicked = await inject(tabId, clickSearchResult, [], session);
  if (clicked) {
    await log("info", `clicked result: ${clicked}`, session);
    await sleep(4000);
    await waitForLoad(tabId, session);
    await logPage(tabId, session);
  } else {
    await log("warn", "no clickable search results found (consent page or CAPTCHA?)", session);
  }
  await inject(tabId, browseLikeAHuman, [dwell], session, `scrolling for ${dwell.toFixed(0)}s`);
  await scheduleClose(winId, dwell + 10, session);
}

async function watchYouTube(session) {
  const useChannel = CONFIG.youtubeChannels.length && Math.random() < 0.35;
  const label = useChannel ? pick(CONFIG.youtubeChannels) : pick(CONFIG.youtubeSearches);
  const listUrl = useChannel
    ? `https://www.youtube.com/${label}/videos`
    : `https://www.youtube.com/results?search_query=${encodeURIComponent(label)}`;
  await log("info", useChannel ? `opening channel ${label}` : `searching YouTube for "${label}"`, session);

  const { winId, tabId } = await openWorker(listUrl, session);
  await waitForLoad(tabId, session);
  await sleep(3000); // let YouTube render its results

  const links = await inject(
    tabId,
    () =>
      [...document.querySelectorAll('a[href*="/watch?v="]')]
        .map((a) => a.href.split("&")[0])
        .filter((h, i, all) => all.indexOf(h) === i)
        .slice(0, 6),
    [],
    session
  );
  if (!links?.length) {
    await log("warn", "no videos found on the page", session);
    return closeWorker(winId, session);
  }
  await log("info", `found ${links.length} candidate videos`, session);

  const video = pick(links);
  await chrome.tabs.update(tabId, { url: video });
  await waitForLoad(tabId, session);
  await sleep(3000);
  await logPage(tabId, session);

  const playback = await inject(
    tabId,
    async () => {
      const v = document.querySelector("video");
      if (!v) return "no <video> element";
      try {
        await v.play();
      } catch (e) {
        return `play() blocked: ${e.message}`;
      }
      return `playing (${Math.round(v.duration || 0)}s long, at ${Math.round(v.currentTime)}s)`;
    },
    [],
    session
  );
  await log(playback?.startsWith("playing") ? "info" : "warn", `video: ${playback}`, session);

  const mins = rand(CONFIG.watchMin);
  await scheduleClose(winId, mins * 60, session);
}

// ---------- worker window ----------

async function openWorker(url, session) {
  const { state, ...bounds } = CONFIG.window;
  const win = await chrome.windows.create({
    url,
    focused: false,
    type: "normal",
    ...(state === "minimized" ? { state } : bounds),
  });
  const tabId = win.tabs[0].id;
  await chrome.tabs.update(tabId, { muted: true });
  await chrome.storage.session.set({ workerWindow: win.id, workerSession: session });
  await log("info", `opened ${state === "minimized" ? "minimized" : `${bounds.width}×${bounds.height}`} window → ${url}`, session);
  return { winId: win.id, tabId };
}

async function workerBusy() {
  const { workerWindow } = await chrome.storage.session.get("workerWindow");
  if (!workerWindow) return false;
  try {
    await chrome.windows.get(workerWindow);
    return true;
  } catch {
    await chrome.storage.session.remove(["workerWindow", "workerSession"]);
    return false;
  }
}

async function scheduleClose(winId, seconds, session) {
  const when = Date.now() + Math.max(seconds, 30) * 1000;
  await chrome.alarms.create(`${CLOSE_PREFIX}${winId}:${session}`, { when });
  await log("info", `window will close at ${clock(when)}`, session);
}

async function closeWorker(winId, session) {
  // Clear state first so onRemoved doesn't report this as an early close.
  await chrome.storage.session.remove(["workerWindow", "workerSession"]);
  try {
    await chrome.windows.remove(winId);
    await log("info", "session finished, window closed", session);
  } catch {
    await log("info", "session finished (window was already gone)", session);
  }
}

function waitForLoad(tabId, session, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const done = (timedOut = false) => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      if (timedOut) log("warn", `page still loading after ${timeoutMs / 1000}s, continuing anyway`, session);
      else log("info", `page loaded in ${((Date.now() - started) / 1000).toFixed(1)}s`, session);
      resolve();
    };
    const onUpdated = (id, info) => id === tabId && info.status === "complete" && done();
    const timer = setTimeout(() => done(true), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((t) => t.status === "complete" && done()).catch(() => done());
  });
}

async function logPage(tabId, session) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await log("info", `on page: "${tab.title}" — ${tab.url}`, session);
  } catch (e) {
    await log("warn", `couldn't read tab: ${e.message}`, session);
  }
}

// Runs `func` in the page and returns its result; logs failures instead of hiding them.
async function inject(tabId, func, args, session, description) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    if (description) await log("info", description, session);
    return res?.result;
  } catch (e) {
    await log("error", `script injection failed${description ? ` (${description})` : ""}: ${e.message}`, session);
    return undefined;
  }
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
  if (!target) return null;
  target.click();
  return target.href;
}
