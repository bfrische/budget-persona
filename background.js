import { CONFIG } from "./config.js";

const TICK = "tick";
const STEP_PREFIX = "step:";
const MAX_LOG = 300;

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = ([min, max]) => min + Math.random() * (max - min);
const randInt = ([min, max]) => Math.floor(min + Math.random() * (max - min + 1));
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
    await startSession();
  } else if (alarm.name.startsWith(STEP_PREFIX)) {
    await runSteps(alarm.name.slice(STEP_PREFIX.length));
  }
});

chrome.windows.onRemoved.addListener(async (winId) => {
  const { worker } = await chrome.storage.session.get("worker");
  if (!worker || winId !== worker.winId) return;
  await chrome.storage.session.remove("worker");
  await chrome.alarms.clear(STEP_PREFIX + worker.session);
  await log("warn", `worker window was closed early at step ${worker.index}/${worker.steps.length} (by you or Chrome)`, worker.session);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "runNow") {
    log("info", "manual run requested from popup").then(startSession).then(sendResponse);
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
  const [{ enabled }, tick, { worker }] = await Promise.all([
    chrome.storage.local.get("enabled"),
    chrome.alarms.get(TICK),
    chrome.storage.session.get("worker"),
  ]);
  const stepAlarm = worker ? await chrome.alarms.get(STEP_PREFIX + worker.session) : null;
  return {
    enabled: !!enabled,
    activeHours: CONFIG.activeHours,
    inActiveHours: inActiveHours(),
    nextRun: tick?.scheduledTime ?? null,
    worker: worker
      ? {
          session: worker.session,
          step: worker.index,
          total: worker.steps.length,
          current: worker.steps[worker.index - 1] ?? null,
          nextStepAt: stepAlarm?.scheduledTime ?? null,
        }
      : null,
  };
}

// ---------- sessions ----------

// A session opens one window and runs several steps in it back to back.
// Progress lives in chrome.storage.session so it survives the service worker
// being shut down between steps; each step's dwell time is an alarm.

async function startSession() {
  if (await workerBusy()) return log("warn", "skipped: a session is already running");

  const session = Math.random().toString(36).slice(2, 6);
  const kinds = Object.entries(CONFIG.weights).flatMap(([k, w]) => Array(w).fill(k));
  const steps = Array.from({ length: randInt(CONFIG.stepsPerSession) }, () => pick(kinds));
  await log("info", `session started with ${steps.length} steps: ${steps.join(" → ")}`, session);

  const { winId, tabId } = await openWorker(session);
  await chrome.storage.session.set({ worker: { session, winId, tabId, steps, index: 0 } });
  await runSteps(session);
}

// Runs steps until one needs to dwell (then sets an alarm and returns),
// or until there are none left (then closes the window).
async function runSteps(session) {
  while (true) {
    const { worker } = await chrome.storage.session.get("worker");
    if (!worker || worker.session !== session) return; // window was closed or session replaced

    if (worker.index >= worker.steps.length) return closeWorker(worker);

    const kind = worker.steps[worker.index];
    worker.index += 1;
    await chrome.storage.session.set({ worker });
    await log("info", `step ${worker.index}/${worker.steps.length}: ${kind}`, session);

    let seconds = 0;
    try {
      seconds = await STEPS[kind](worker.tabId, session);
    } catch (e) {
      await log("error", `step failed: ${e.message} — moving on`, session);
    }

    // Alarms can't fire sooner than 30s; anything shorter just moves straight on.
    if (seconds >= 30) {
      const when = Date.now() + seconds * 1000;
      await chrome.alarms.create(STEP_PREFIX + session, { when });
      const next = worker.index < worker.steps.length ? `next step at ${clock(when)}` : `session ends at ${clock(when)}`;
      return log("info", `staying ${(seconds / 60).toFixed(1)} min — ${next}`, session);
    }
  }
}

const STEPS = { site: visitSite, search: googleSearch, youtube: watchYouTube };

// Each step navigates the worker tab and returns how many seconds to stay.

async function visitSite(tabId, session) {
  const url = pick(CONFIG.sites);
  await navigate(tabId, url, session);
  const dwell = rand(CONFIG.siteDwellSec);
  await inject(tabId, browseLikeAHuman, [dwell], session, `scrolling around for ${dwell.toFixed(0)}s`);
  return dwell;
}

async function googleSearch(tabId, session) {
  const q = pick(CONFIG.googleSearches);
  await log("info", `searching Google for "${q}"`, session);
  await navigate(tabId, `https://www.google.com/search?q=${encodeURIComponent(q)}`, session);

  const loaded = waitForComplete(tabId, session);
  const clicked = await inject(tabId, clickSearchResult, [], session);
  if (clicked) {
    await log("info", `clicked result: ${clicked}`, session);
    await loaded;
    await logPage(tabId, session);
  } else {
    loaded.cancel();
    await log("warn", "no clickable search results found (consent page or CAPTCHA?)", session);
  }

  const dwell = rand(CONFIG.siteDwellSec);
  await inject(tabId, browseLikeAHuman, [dwell], session, `scrolling around for ${dwell.toFixed(0)}s`);
  return dwell;
}

async function watchYouTube(tabId, session) {
  const useChannel = CONFIG.youtubeChannels.length && Math.random() < 0.35;
  const label = useChannel ? pick(CONFIG.youtubeChannels) : pick(CONFIG.youtubeSearches);
  const listUrl = useChannel
    ? `https://www.youtube.com/${label}/videos`
    : `https://www.youtube.com/results?search_query=${encodeURIComponent(label)}`;
  await log("info", useChannel ? `opening channel ${label}` : `searching YouTube for "${label}"`, session);

  await navigate(tabId, listUrl, session);
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
    await log("warn", "no videos found on the page — skipping", session);
    return 0;
  }
  await log("info", `found ${links.length} candidate videos`, session);

  await navigate(tabId, pick(links), session);
  await sleep(3000);

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

  return rand(CONFIG.watchMin) * 60;
}

// ---------- worker window ----------

async function openWorker(session) {
  const { state, ...bounds } = CONFIG.window;
  const win = await chrome.windows.create({
    url: "about:blank",
    focused: false,
    type: "normal",
    ...(state === "minimized" ? { state } : bounds),
  });
  const tabId = win.tabs[0].id;
  await chrome.tabs.update(tabId, { muted: true });
  await log("info", `opened ${state === "minimized" ? "minimized" : `${bounds.width}×${bounds.height}`} muted window`, session);
  return { winId: win.id, tabId };
}

async function workerBusy() {
  const { worker } = await chrome.storage.session.get("worker");
  if (!worker) return false;
  try {
    await chrome.windows.get(worker.winId);
    return true;
  } catch {
    await chrome.storage.session.remove("worker");
    return false;
  }
}

async function closeWorker(worker) {
  // Clear state first so onRemoved doesn't report this as an early close.
  await chrome.storage.session.remove("worker");
  await chrome.windows.remove(worker.winId).catch(() => {});
  await log("info", `session finished after ${worker.steps.length} steps, window closed`, worker.session);
}

async function navigate(tabId, url, session) {
  const loaded = waitForComplete(tabId, session);
  await chrome.tabs.update(tabId, { url });
  await loaded;
  await logPage(tabId, session);
}

// Resolves on the tab's next "complete" event. Attach it *before* triggering
// navigation, otherwise the previous page's "complete" state counts.
function waitForComplete(tabId, session, timeoutMs = 30_000) {
  let finish;
  const started = Date.now();
  const promise = new Promise((resolve) => {
    finish = (outcome) => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      if (outcome === "loaded") log("info", `page loaded in ${((Date.now() - started) / 1000).toFixed(1)}s`, session);
      if (outcome === "timeout") log("warn", `page still loading after ${timeoutMs / 1000}s, continuing anyway`, session);
      resolve();
    };
  });
  const onUpdated = (id, info) => id === tabId && info.status === "complete" && finish("loaded");
  const timer = setTimeout(() => finish("timeout"), timeoutMs);
  chrome.tabs.onUpdated.addListener(onUpdated);
  promise.cancel = () => finish("cancelled");
  return promise;
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
