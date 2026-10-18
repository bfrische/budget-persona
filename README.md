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

## Notes

- Stay signed in to Google/YouTube in this Chrome profile, or the watch/search history won't attach to your account.
- Chrome must be open for it to run.
- Subscribing to a few budget channels by hand and setting interests directly at myadcenter.google.com strengthens the signal a lot.
