# Cycle Tracker

Inspiration from other people who have been frustrated with Flo and just want something easy to track and set up.

A private period tracker that runs entirely inside your own Google account. You log periods from a simple page on your phone, the data lives in a Google Sheet you own, and periods, predictions, fertile windows and reminders appear on a Google Calendar you can share with a partner.

There are no subscriptions, no adverts, no third-party servers and no account to create. It takes about 15 minutes to set up.

## What it does

- **One-tap logging**: "Period started today" and "Period ended today", plus a date picker for anything you missed.
- **Predictions**: the next six periods, based on the median of your last six cycles.
- **Fertile window and ovulation estimates**: optional, and easy to switch off.
- **Calendar events** on a dedicated calendar, colour-coded, so your main calendar is never touched.
- **Reminders**: pop-ups 7 and 2 days before the next predicted period, and an evening "Log period end?" nudge if you forget to log an end date.
- **Late periods**: a "Period due" event that moves forward each day until you log a start.
- **Your data is a spreadsheet**: one row per period. Edit it directly, export it, or keep it forever.

## How it works

| Part | What it is |
|---|---|
| Google Sheet (`Cycles` tab) | The source of truth: Start, End, Note |
| Web app | A private page on your phone's home screen. Only you can open it. |
| Google Calendar (`Cycle`) | Generated from the sheet. Shareable read-only with anyone you choose. |

Logging saves to the sheet straight away, and the page updates in a second or two. The calendar then updates in the background, shown as "Updating calendar…" at the top of the page, and you can keep logging while it runs. As a backstop, each save also schedules a one-off catch-up a couple of minutes later, in case the page is closed first. The calendar is also refreshed whenever you edit the sheet, and once a day. Each event the script creates carries a private tag, so a sync only adds or removes what changed. Anything you add to that calendar by hand is left alone.

## Setup

Do this on a computer, signed in to the Google account that should own the tracker.

### 1. Create the sheet and add the code

1. Create a new Google Sheet ([sheets.new](https://sheets.new)) and call it `Cycle Tracker`.
2. In the sheet, open **Extensions > Apps Script**. The project must be created from the sheet like this, not from script.google.com.
3. Rename the project to `Cycle Tracker`. This is the name you'll see on the permission screen.
4. Replace the contents of `Code.gs` with [`Code.gs`](Code.gs) from this repo.
5. Click **+ > HTML**, name it `Index`, and replace its contents with [`Index.html`](Index.html).
6. Check **Project Settings** (the cog) **> Time zone** is your own. Dates and reminders use it.
7. Save.

### 2. Run setup

1. In the function dropdown at the top of the editor, choose **`setup`**. The dropdown defaults to `doGet`, which does nothing visible, so make sure it says `setup`.
2. Click **Run** and sign in.
3. Google warns that it "hasn't verified this app". That's because it's your own script, not a published app. Click **Advanced**, then **Go to Cycle Tracker (unsafe)**.
4. Allow the permissions:
   - **This spreadsheet only.** The code is marked `@OnlyCurrentDoc`, so it can't see your other files.
   - **Google Calendar.** Apps Script has no narrower calendar permission. The code only writes to the `Cycle` calendar it creates, and only deletes events it tagged itself.
   - **Run when you're not present**, for the daily refresh.

The log should end with `Setup complete. Calendar "Cycle" ready.`

`setup` is safe to run again. It reuses the calendar and replaces the triggers rather than duplicating them.

### 3. Deploy the page

1. Go to **Deploy > New deployment**, click the cog and choose **Web app**.
2. Set **Execute as: Me** and **Who has access: Only myself**.
3. Click **Deploy** and copy the URL ending in `/exec`.

### 4. Add your history

Two or more past start dates are enough for predictions. Three to six are better. There are two ways to add them:

- **On the page:** open "Log a different date", pick each past start, oldest first, and tap **Log start**. Add **Log end** where you know it.
- **In the sheet:** type dates into the `Cycles` tab, Start in column A and End in column B. Both `2026-09-22` and `22/09/2026` work.

Rough dates are fine. A single odd month barely moves the median, and gaps outside 15 to 60 days are ignored as probable missed entries.

**Coming from another app?** Most period apps will export your data on request (often via their help or support section). Copy the start and end dates into the sheet.

### 5. Put it on your phone

**Android (Chrome):** open the `/exec` URL, then **⋮ > Add to home screen** and choose **Create shortcut**. Don't choose **Install**: Apps Script pages can't be installed as apps, and Chrome will say the app couldn't be installed.

**iPhone (Safari):** open the `/exec` URL, then **Share > Add to Home Screen**.

For an at-a-glance view, add your phone's Google Calendar widget and show the `Cycle` calendar.

### 6. Share the calendar (optional)

In Google Calendar on a computer:
1. Go to **Settings**, then under "Settings for my calendars" choose **Cycle**.
2. Under **Share with specific people**, add the other person and choose **See all event details** (or **See only free/busy**).

Reminders set by the script fire for the owner only. The other person can set their own notifications on their copy of the calendar.

## Using it

| To | Do |
|---|---|
| Log a period starting today | **Period started today** |
| Log that it finished | **Period ended today**. This becomes the highlighted button while a period is in progress. |
| Log a missed date | **Log a different date**, then **Log start** or **Log end** |
| Fix a mistake | Edit the row in the sheet, or use **Remove** in the history list |
| Refresh the calendar now | **Sync calendar now** at the bottom of the page |

The first calendar update after backfilling several months can take a minute, because each event is a separate Calendar call. That happens in the background; the page stays usable.

**If you forget an end date,** a "Log period end?" pop-up appears at 19:00 the day after your usual last day, and again two days later. Logging the next start also fills in a sensible end for the previous one, and tells you so.

## How the estimates work

- **Cycle length**: the median of the last six gaps between start dates, ignoring gaps outside 15 to 60 days. If fewer than two starts are logged, it uses 28 days.
- **Period length**: the median of the last six logged durations. If no end dates are logged, it uses 5 days.
- **Ovulation**: the next predicted start minus 14 days.
- **Fertile window**: from five days before the estimated ovulation to one day after.

This is the traditional calendar method. It's useful for "roughly when", but **it is not reliable for avoiding pregnancy**, and it isn't medical advice. If something about your cycle worries you, talk to a doctor.

## Settings

Everything is in the `CONFIG` block at the top of `Code.gs`. After changing anything, see [Updating](#updating).

| Setting | Default | What it does |
|---|---|---|
| `CALENDAR_NAME` | `Cycle` | Name of the calendar created by `setup` |
| `SHOW_FERTILITY` | `true` | Set to `false` to hide fertile window and ovulation everywhere |
| `LABELS` | Period, Period (predicted)… | Event titles. Use something discreet if the calendar shows on shared screens. |
| `REMINDER_DAYS_BEFORE` | `[7, 2]` | Pop-ups before the next predicted period: up to 5, each 1 to 28 days. `[]` switches them off. |
| `REMINDER_HOUR` | `9` | Time of day for those pop-ups |
| `LOG_END_NUDGE` | `true` | Evening pop-up if a period is still open past its usual length |
| `LOG_END_NUDGE_HOUR` | `19` | Time of that nudge |
| `PREDICT_CYCLES` | `6` | How many future periods appear |
| `CYCLES_TO_AVERAGE` | `6` | How many recent cycles feed the median |
| `FAVICON_URL` | icon in this repo | Page icon. Use `''` for none. |

After changing `LABELS` or editing old rows, run **`rebuildCalendar`** once.

## Updating

Triggers and editor runs use the saved code; the web page uses the deployed version. So every update is three steps:

1. Paste in the new code and save.
2. Run **`sync`** once from the editor.
3. Go to **Deploy > Manage deployments**, click the pencil, set **Version: New version**, then **Deploy**.

Editing the existing deployment keeps your `/exec` URL. Choosing "New deployment" creates a new URL, and your home-screen shortcut stops working.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `setup` says the script must be attached to the sheet | The project was created at script.google.com. Open the sheet, go to **Extensions > Apps Script**, and paste the files there. |
| The page won't load on your phone and mentions authorisation or "unable to open file" | Long-standing Apps Script quirk when the browser is signed into more than one Google account. Make the tracker's account the only or first account, or add `?authuser=1` (or `0`, `2`…) to the URL. |
| "The Cycle calendar was not found" | The calendar was deleted. Run `setup` again to recreate it, then re-share it. |
| Calendar stops updating | Check **Triggers** and **Executions** in the editor. Running `setup` reinstates the triggers. A `backstopSync` trigger appearing briefly after each save is normal: it removes itself once it has run. |
| "Saved, but the calendar update failed" | The entry is safe in the sheet. The backstop and daily syncs retry, or tap **Sync calendar now**. |
| A yellow box on the page about a row | A date in the sheet couldn't be read. Fix the row it names. |
| An email titled "Summary of failures for Google Apps Script" | Usually a temporary Google hiccup. The daily sync retries. If it keeps happening, check **Executions** for the error. |

## Removing it

1. Run `removeTriggers` from the editor.
2. Delete the `Cycle` calendar in Google Calendar settings.
3. Delete the sheet, which also deletes the script.
4. Remove its access under **Google Account > Security > Your connections to third-party apps & services**.

## Development

The logic can be tested without Google, against mocked Sheets, Calendar and trigger services:

```
npm test
```

This needs Node 18 or later and has no dependencies.

## Prior art

The approach of keeping the data in a spreadsheet and writing to a dedicated calendar owes a lot to [Aliza Aufrichtig's Sheets period tracker](https://www.alizaaufrichtig.com/period-tracker) and her write-up [Why I Built My Own Period Tracking App](https://www.recurse.com/still-computing/issue-3).

## Licence

[MIT](LICENSE)
