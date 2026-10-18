const $ = (id) => document.getElementById(id);
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

function until(ms) {
  const s = Math.max(0, Math.round((ms - Date.now()) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function runningText(w) {
  const last = w.step >= w.total;
  const wait = w.nextStepAt ? `, ${last ? "ends" : "next step"} in ${until(w.nextStepAt)}` : "";
  return `session #${w.session}, step ${w.step}/${w.total} (${w.current})${wait}`;
}

async function renderStatus() {
  const s = await chrome.runtime.sendMessage({ type: "status" });
  $("enabled").checked = s.enabled;
  const [start, end] = s.activeHours;
  const lines = [
    `<b>State:</b> ${s.enabled ? "enabled" : '<span class="warn-text">paused</span>'}`,
    `<b>Active hours:</b> ${start}:00–${end}:00 ${s.inActiveHours ? "(now inside)" : '<span class="warn-text">(now outside — sessions will be skipped)</span>'}`,
    `<b>Next session:</b> ${s.nextRun ? `${clock(s.nextRun)} (in ${until(s.nextRun)})` : '<span class="warn-text">none scheduled</span>'}`,
    `<b>Running now:</b> ${s.worker ? runningText(s.worker) : "nothing"}`,
  ];
  $("status").innerHTML = lines.join("<br>");
}

async function renderLog() {
  const { history = [] } = await chrome.storage.local.get("history");
  const onlyProblems = $("onlyProblems").checked;
  const entries = onlyProblems ? history.filter((e) => e.level !== "info") : history;
  if (!entries.length) {
    $("history").innerHTML = `<li class="empty">${onlyProblems ? "No warnings or errors." : "Nothing logged yet."}</li>`;
    return;
  }
  $("history").replaceChildren(
    ...entries.map(({ at, level, message, session }, i) => {
      const li = document.createElement("li");
      li.className = level;
      // Visually separate each session's group of lines.
      if (session && entries[i + 1]?.session !== session) li.classList.add("new-session");
      const time = document.createElement("time");
      time.textContent = clock(at);
      li.append(time);
      if (session) {
        const sid = document.createElement("span");
        sid.className = "sid";
        sid.textContent = `#${session}`;
        li.append(sid);
      }
      li.append(message);
      return li;
    })
  );
}

$("enabled").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ enabled: e.target.checked });
  renderStatus();
});

$("run").addEventListener("click", async () => {
  $("run").disabled = true;
  await chrome.runtime.sendMessage({ type: "runNow" });
  $("run").disabled = false;
});

$("clear").addEventListener("click", () => chrome.storage.local.set({ history: [] }));
$("onlyProblems").addEventListener("change", renderLog);

// Live updates: new log lines appear as they're written; countdowns tick.
chrome.storage.onChanged.addListener((changes) => {
  if (changes.history) renderLog();
  if (changes.enabled || changes.nextRun) renderStatus();
});
setInterval(renderStatus, 1000);

renderStatus();
renderLog();
