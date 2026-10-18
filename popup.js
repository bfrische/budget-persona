const $ = (id) => document.getElementById(id);
const fmt = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

async function render() {
  const { enabled, nextRun, history = [] } = await chrome.storage.local.get(["enabled", "nextRun", "history"]);
  $("enabled").checked = !!enabled;
  $("next").textContent = enabled && nextRun ? `Next session around ${fmt(nextRun)}` : "Paused";
  $("history").replaceChildren(
    ...history.map(({ at, message }) => {
      const li = document.createElement("li");
      const time = document.createElement("time");
      time.textContent = fmt(at);
      li.append(time, message);
      return li;
    })
  );
}

$("enabled").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ enabled: e.target.checked });
  render();
});

$("run").addEventListener("click", async () => {
  $("run").disabled = true;
  await chrome.runtime.sendMessage({ type: "runNow" });
  $("run").disabled = false;
  render();
});

render();
