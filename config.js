// Edit these lists freely, then click "Reload" on chrome://extensions.

export const CONFIG = {
  // Random gap between sessions, in minutes.
  minIntervalMin: 20,
  maxIntervalMin: 60,

  // Only run between these local hours (24h clock). [9, 23] = 9am–11pm.
  activeHours: [9, 23],

  // Each session runs this many steps back to back in the same window.
  stepsPerSession: [3, 6],

  // Hard cap on one session's length; anything still running after this is closed.
  maxSessionMin: 90,

  // Relative odds of each kind of step.
  weights: { site: 4, youtube: 4, search: 2 },

  // How long to linger on a site / search page, in seconds.
  siteDwellSec: [45, 150],

  // How long to watch a YouTube video, in minutes. Longer watch time = stronger signal.
  watchMin: [4, 12],

  // The worker window opens unfocused in a corner so it doesn't steal your screen.
  // "minimized" hides it entirely, but Chrome may throttle video playback there.
  window: { state: "normal", width: 520, height: 420, left: 0, top: 0 },

  sites: [
    "https://www.dollartree.com",
    "https://www.dollargeneral.com",
    "https://www.familydollar.com",
    "https://www.aldi.us",
    "https://www.walmart.com/search?q=rollback",
    "https://www.budgetbytes.com",
    "https://www.thekrazycouponlady.com",
    "https://slickdeals.net",
    "https://www.thepennyhoarder.com",
    "https://www.reddit.com/r/Frugal/",
    "https://www.reddit.com/r/povertyfinance/",
    "https://www.reddit.com/r/EatCheapAndHealthy/",
    "https://www.reddit.com/r/budgetfood/",
    "https://www.freecycle.org",
    "https://www.goodwill.org",
    "https://www.findhelp.org",
  ],

  // YouTube searches; a random video from the top results gets watched.
  youtubeSearches: [
    "dollar tree haul",
    "struggle meals",
    "extreme budget meals",
    "$1 meals",
    "aldi haul on a budget",
    "cheap meal prep for the week",
    "how to live on a tight budget",
    "frugal living tips",
    "thrift store haul",
    "how to save money on groceries",
    "living paycheck to paycheck tips",
  ],

  // Optional: specific channels (handle form, e.g. "@BudgetBytes").
  // One of the latest uploads from the channel's Videos tab gets watched.
  youtubeChannels: [
    "@BudgetBytes",
  ],

  // Google searches. Deliberately avoids loan/credit terms, which attract predatory ads.
  googleSearches: [
    "cheap meals for a week",
    "dollar store deals this week",
    "free things to do this weekend",
    "cheapest phone plan",
    "how to lower electric bill",
    "used cars under 5000",
    "best coupon apps",
    "cheap apartments near me",
    "how to stretch a paycheck",
    "aldi weekly ad",
    "thrift stores near me",
  ],
};
