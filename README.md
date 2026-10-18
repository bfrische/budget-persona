# Budget Persona

A Chrome extension that, every 20–60 minutes during waking hours, opens a small muted window in the corner and does one of:

- **Browses a budget site** (Dollar Tree, Aldi, r/povertyfinance, coupon sites…) — scrolls around, sometimes clicks a link.
- **Watches a frugal YouTube video** for 4–12 minutes (from a search like "struggle meals" or a listed channel).
- **Runs a money-saving Google search** and reads one of the top results.

Then it closes the window. It runs in your real Chrome profile, so Google, YouTube, Reddit and ad networks see it as you.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick this `budget-persona` folder
4. Pin the extension and click it to see the log, pause it, or run a session now

## Customize

Edit `config.js` (sites, searches, channels, timing, active hours), then hit the reload icon on the extension's card in `chrome://extensions`.

## Seeing what it's doing

Click the extension icon. The popup shows:

- **Status:** enabled or paused, whether you're inside the active hours, a countdown to the next session, and what's running right now.
- **Live log:** every step of every session (window opened, page loaded, page title, video playing or blocked, window closed), grouped by session ID. Warnings are yellow and errors are red. Tick "Only warnings & errors" to filter.

The same lines also go to the service worker console: in `chrome://extensions`, click **service worker** on the Budget Persona card.

If nothing seems to happen, check the log for `skipped: outside active hours` or `skipped: extension is paused`. Remember the first session runs 20–60 minutes after install, so use **Run a session now** to test.

## Notes

- Stay signed in to Google/YouTube in this Chrome profile, or the watch/search history won't attach to your account.
- Chrome must be open for it to run.
- Subscribing to a few budget channels by hand and setting interests directly at myadcenter.google.com strengthens the signal a lot.
