/**
 * Cycle Tracker
 * https://github.com/samcaesar-ai/cycle-tracker  (MIT licence)
 *
 * A private period and cycle tracker that lives in a Google Sheet, is logged
 * from a private web app, and writes periods and estimates to a dedicated
 * Google Calendar.
 *
 * Source of truth: the "Cycles" sheet, one row per period (Start, End, Note).
 * The calendar is generated from the sheet, so correct dates in the sheet,
 * never in the calendar (calendar edits are overwritten on the next sync).
 *
 * @OnlyCurrentDoc
 */

const CONFIG = {
  CALENDAR_NAME: 'Cycle',
  SHEET_NAME: 'Cycles',

  // Prediction
  CYCLES_TO_AVERAGE: 6,         // most recent cycle lengths used for the median
  DEFAULT_CYCLE_LENGTH: 28,     // used until two starts are logged
  DEFAULT_PERIOD_LENGTH: 5,     // used until an end date is logged
  MIN_VALID_CYCLE: 15,          // cycle lengths outside this range are ignored,
  MAX_VALID_CYCLE: 60,          // they are usually a missed or mistyped entry
  MAX_PERIOD_LENGTH: 14,
  MIN_DAYS_BETWEEN_STARTS: 10,
  LUTEAL_DAYS: 14,              // ovulation estimate = next start minus this
  FERTILE_DAYS_BEFORE: 5,
  FERTILE_DAYS_AFTER: 1,
  PREDICT_CYCLES: 6,

  // Calendar
  SHOW_FERTILITY: true,         // false hides fertile window and ovulation everywhere
  HISTORY_DAYS: 400,            // routine syncs leave logged periods older than this alone
  REMINDER_DAYS_BEFORE: [7, 2], // pop-ups before the next predicted period; [] switches them off (max 5, up to 28 days)
  REMINDER_HOUR: 9,             // time of day for those pop-ups
  LOG_END_NUDGE: true,          // evening pop-up if a period is still open past its usual length
  LOG_END_NUDGE_HOUR: 19,
  FAVICON_URL: 'https://raw.githubusercontent.com/samcaesar-ai/cycle-tracker/main/icon.png', // '' for none
  DAILY_SYNC_HOUR: 5,
  WRITE_PAUSE_MS: 120,          // small pause between calendar writes to stay under rate limits
  LABELS: {
    period: 'Period',
    predicted: 'Period (predicted)',
    due: 'Period due',
    fertile: 'Fertile window (est.)',
    ovulation: 'Ovulation (est.)',
    nudge: 'Log period end?'
  }
};

const TAG_KEY = 'cycleTracker';
const DAY_MS = 86400000;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ------------------------------------------------------------------ */
/* Web app                                                             */
/* ------------------------------------------------------------------ */

function doGet() {
  const out = HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Cycle')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
  if (CONFIG.FAVICON_URL) out.setFaviconUrl(CONFIG.FAVICON_URL);
  return out;
}

/** Current state for the page. */
function getState() {
  const ss = getSpreadsheet_();
  const read = readCycles_();
  const today = todayDay_();
  const model = buildModel_(read.cycles, today);
  const history = read.cycles.map((c, i) => {
    const next = read.cycles[i + 1];
    return {
      start: dayToIso_(c.start),
      end: c.end == null ? null : dayToIso_(c.end),
      periodDays: c.end == null ? null : c.end - c.start + 1,
      cycleDays: next ? next.start - c.start : null
    };
  }).slice(-8).reverse();

  return {
    today: dayToIso_(today),
    model: model ? serialiseModel_(model, today) : null,
    history: history,
    warnings: read.warnings,
    showFertility: CONFIG.SHOW_FERTILITY,
    sheetUrl: ss.getUrl(),
    message: null
  };
}

/** Log the first day of a period. isoDate is yyyy-MM-dd, defaults to today. */
function logStart(isoDate) {
  return mutate_(() => {
    const day = validateInputDate_(isoDate);
    const cycles = readCycles_().cycles;
    const model = buildModel_(cycles, todayDay_());
    const periodLength = model ? model.periodLength : CONFIG.DEFAULT_PERIOD_LENGTH;

    if (cycles.some(c => c.start === day)) {
      throw new Error('A period start is already logged for ' + humanDay_(day) + '.');
    }
    const inside = cycles.find(c => c.end != null && day >= c.start && day <= c.end);
    if (inside) {
      throw new Error(humanDay_(day) + ' falls inside the period logged from ' +
        humanDay_(inside.start) + ' to ' + humanDay_(inside.end) + '. Correct it in the sheet if that period is wrong.');
    }
    const prev = cycles.filter(c => c.start < day).pop();
    const next = cycles.find(c => c.start > day);
    if (prev && day - prev.start < CONFIG.MIN_DAYS_BETWEEN_STARTS) {
      throw new Error('That is only ' + daysText_(day - prev.start) + ' after the start logged on ' +
        humanDay_(prev.start) + '. If that period has finished, log an end date instead. If a date is wrong, correct it in the sheet.');
    }
    if (next && next.start - day < CONFIG.MIN_DAYS_BETWEEN_STARTS) {
      throw new Error('That is only ' + daysText_(next.start - day) + ' before the start logged on ' +
        humanDay_(next.start) + '. If a date is wrong, correct it in the sheet.');
    }

    const sheet = getSheet_();
    let message = 'Period start logged for ' + humanDay_(day) + '.';
    if (prev && prev.end == null) {
      const assumedEnd = Math.min(prev.start + periodLength - 1, day - 1);
      sheet.getRange(prev.row, 2).setValue(dayToDate_(assumedEnd));
      message += ' The previous period had no end date, so it has been set to ' +
        humanDay_(assumedEnd) + '. Change it in the sheet if that is wrong.';
    }
    sheet.appendRow([dayToDate_(day), '', '']);
    sortSheet_();
    return message;
  });
}

/** Log the last day of the most recent period starting on or before isoDate. */
function logEnd(isoDate) {
  return mutate_(() => {
    const day = validateInputDate_(isoDate);
    const cycles = readCycles_().cycles;
    const target = cycles.filter(c => c.start <= day).pop();
    if (!target) {
      throw new Error('There is no period start on or before ' + humanDay_(day) + '. Log a start first.');
    }
    const length = day - target.start + 1;
    if (length > CONFIG.MAX_PERIOD_LENGTH) {
      throw new Error('That would make the period starting ' + humanDay_(target.start) + ' ' + length +
        ' days long. Check the date, or log a new start first.');
    }
    getSheet_().getRange(target.row, 2).setValue(dayToDate_(day));
    return 'Period end logged for ' + humanDay_(day) + ' (' + daysText_(length) + ').';
  });
}

/** Remove the period that starts on isoStart. */
function deleteCycle(isoStart) {
  return mutate_(() => {
    const day = validateInputDate_(isoStart);
    const target = readCycles_().cycles.find(c => c.start === day);
    if (!target) throw new Error('No period starting ' + humanDay_(day) + ' was found.');
    getSheet_().deleteRow(target.row);
    return 'Removed the period starting ' + humanDay_(day) + '.';
  });
}

/** Manual "sync now" from the page. */
function syncNow() {
  return withLock_(30000, () => {
    const result = syncCalendar_();
    const state = getState();
    state.message = 'Calendar updated: ' + result.created + ' added, ' + result.deleted + ' removed.';
    return state;
  });
}

/* ------------------------------------------------------------------ */
/* Editor functions (run from the Apps Script editor)                  */
/* ------------------------------------------------------------------ */

/** One-off setup. Safe to run again: it reuses the sheet, calendar and triggers. */
function setup() {
  const ss = getSpreadsheet_();
  ss.setSpreadsheetTimeZone(tz_());

  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    const blank = ss.getSheets().find(s => s.getLastRow() === 0 && /^(Sheet|Ark)\s?1$/i.test(s.getName()));
    sheet = blank ? blank.setName(CONFIG.SHEET_NAME) : ss.insertSheet(CONFIG.SHEET_NAME, 0);
  }
  if (sheet.getLastRow() === 0) sheet.appendRow(['Start', 'End', 'Note']);
  sheet.setFrozenRows(1);
  sheet.getRange('A1:C1').setFontWeight('bold');
  sheet.getRange('A2:B').setNumberFormat('ddd d mmm yyyy');
  sheet.setColumnWidths(1, 2, 140);
  sheet.setColumnWidth(3, 280);

  const props = PropertiesService.getScriptProperties();
  const existingId = props.getProperty('CALENDAR_ID');
  let cal = existingId ? CalendarApp.getCalendarById(existingId) : null;
  if (!cal) {
    cal = CalendarApp.createCalendar(CONFIG.CALENDAR_NAME, {
      summary: 'Generated by the Cycle Tracker sheet. Correct dates in the sheet; edits made here are overwritten.'
    });
    props.setProperty('CALENDAR_ID', cal.getId());
  }

  installTriggers_(ss);
  const result = syncCalendar_({ full: true });
  Logger.log('Setup complete. Calendar "%s" ready. %s events added, %s removed.',
    cal.getName(), result.created, result.deleted);
  result.warnings.forEach(w => Logger.log('Warning: ' + w));
}

/** Routine sync, for running by hand. */
function sync() {
  withLock_(30000, () => {
    const r = syncCalendar_();
    Logger.log('%s added, %s removed.', r.created, r.deleted);
    r.warnings.forEach(w => Logger.log('Warning: ' + w));
  });
}

/** Full sync including all history. Use after changing LABELS or editing old rows. */
function rebuildCalendar() {
  withLock_(60000, () => {
    const r = syncCalendar_({ full: true });
    Logger.log('%s added, %s removed.', r.created, r.deleted);
  });
}

/** Removes this project's triggers (for uninstalling). */
function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (['dailySync', 'onSheetEdit'].indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  Logger.log('Triggers removed.');
}

/* ------------------------------------------------------------------ */
/* Trigger handlers                                                    */
/* ------------------------------------------------------------------ */

function dailySync() {
  withLock_(60000, () => syncCalendar_());
}

function onSheetEdit(e) {
  if (e && e.range && e.range.getSheet().getName() !== CONFIG.SHEET_NAME) return;
  // If something else holds the lock, skip: the daily sync will catch up.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    syncCalendar_();
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* Model                                                               */
/* ------------------------------------------------------------------ */

function buildModel_(cycles, today) {
  if (!cycles.length) return null;

  const gaps = [];
  for (let i = 1; i < cycles.length; i++) {
    const gap = cycles[i].start - cycles[i - 1].start;
    if (gap >= CONFIG.MIN_VALID_CYCLE && gap <= CONFIG.MAX_VALID_CYCLE) gaps.push(gap);
  }
  const recentGaps = gaps.slice(-CONFIG.CYCLES_TO_AVERAGE);
  const cycleLength = recentGaps.length ? Math.round(median_(recentGaps)) : CONFIG.DEFAULT_CYCLE_LENGTH;

  const durations = cycles
    .filter(c => c.end != null)
    .map(c => c.end - c.start + 1)
    .filter(d => d >= 1 && d <= CONFIG.MAX_PERIOD_LENGTH)
    .slice(-CONFIG.CYCLES_TO_AVERAGE);
  const periodLength = durations.length ? Math.round(median_(durations)) : CONFIG.DEFAULT_PERIOD_LENGTH;

  const last = cycles[cycles.length - 1];
  const ongoing = last.end == null && today - last.start < CONFIG.MAX_PERIOD_LENGTH;
  let lastEnd;
  if (last.end != null) {
    lastEnd = last.end;
  } else if (ongoing) {
    lastEnd = Math.min(Math.max(today, last.start + periodLength - 1), last.start + CONFIG.MAX_PERIOD_LENGTH - 1);
  } else {
    lastEnd = last.start + periodLength - 1;
  }

  const rawNext = last.start + cycleLength;
  const late = !ongoing && rawNext < today;
  const nextStart = late ? today : rawNext;

  const upcoming = [];
  for (let i = 0; i < CONFIG.PREDICT_CYCLES; i++) {
    const start = nextStart + i * cycleLength;
    const ovulation = start - CONFIG.LUTEAL_DAYS;
    upcoming.push({
      start: start,
      end: start + periodLength - 1,
      ovulation: ovulation,
      fertileStart: ovulation - CONFIG.FERTILE_DAYS_BEFORE,
      fertileEnd: ovulation + CONFIG.FERTILE_DAYS_AFTER
    });
  }

  return {
    cycleLength: cycleLength,
    cycleSamples: recentGaps.length,
    periodLength: periodLength,
    periodSamples: durations.length,
    lastStart: last.start,
    lastEnd: lastEnd,
    ongoing: ongoing,
    cycleDay: today - last.start + 1,
    late: late,
    daysLate: late ? today - rawNext : 0,
    nextStart: nextStart,
    upcoming: upcoming
  };
}

function serialiseModel_(m, today) {
  const cur = m.upcoming[0];
  return {
    cycleLength: m.cycleLength,
    cycleSamples: m.cycleSamples,
    periodLength: m.periodLength,
    periodSamples: m.periodSamples,
    lastStart: dayToIso_(m.lastStart),
    cycleDay: m.cycleDay,
    ongoing: m.ongoing,
    late: m.late,
    daysLate: m.daysLate,
    nextStart: dayToIso_(m.nextStart),
    daysUntilNext: m.nextStart - today,
    fertileStart: dayToIso_(cur.fertileStart),
    fertileEnd: dayToIso_(cur.fertileEnd),
    ovulation: dayToIso_(cur.ovulation),
    fertileCurrentOrAhead: cur.fertileEnd >= today,
    inFertileWindow: today >= cur.fertileStart && today <= cur.fertileEnd
  };
}

/* ------------------------------------------------------------------ */
/* Calendar sync                                                       */
/* ------------------------------------------------------------------ */

function planEvents_(cycles, model, today, windowStart) {
  const L = CONFIG.LABELS;
  const events = [];
  const last = cycles[cycles.length - 1];

  cycles.forEach(c => {
    if (c.start < windowStart) return;
    let end = c.end;
    if (end == null) end = (c === last) ? model.lastEnd : c.start + model.periodLength - 1;
    events.push({ kind: 'period', title: L.period, start: c.start, end: end, reminder: false });
  });
  if (!model) return events;

  // While a period is open, an evening nudge the day after its usual last day,
  // and again two days later. Both vanish as soon as an end date is logged.
  if (model.ongoing && CONFIG.LOG_END_NUDGE) {
    [model.periodLength, model.periodLength + 2].forEach(offset => {
      if (offset >= CONFIG.MAX_PERIOD_LENGTH) return;
      const day = model.lastStart + offset;
      events.push({ kind: 'nudge', title: L.nudge, start: day, end: day, timed: true, reminder: false });
    });
  }

  model.upcoming.forEach((p, i) => {
    if (CONFIG.SHOW_FERTILITY && p.fertileEnd >= today) {
      events.push({ kind: 'fertile', title: L.fertile, start: p.fertileStart, end: p.fertileEnd, reminder: false });
      events.push({ kind: 'ovulation', title: L.ovulation, start: p.ovulation, end: p.ovulation, reminder: false });
    }
    const isDue = i === 0 && model.late;
    events.push({
      kind: isDue ? 'due' : 'predicted',
      title: isDue ? L.due : L.predicted,
      start: p.start,
      end: p.end,
      reminder: i === 0 && !model.late && reminderDays_().length > 0
    });
  });
  return events;
}

function eventKey_(e) {
  let extra = e.reminder ? 'r' + reminderDays_().join('-') + '@' + CONFIG.REMINDER_HOUR : 'r0';
  if (e.timed) extra = 'h' + CONFIG.LOG_END_NUDGE_HOUR;
  return [e.kind, dayToIso_(e.start), dayToIso_(e.end), e.title, extra].join('|');
}

/** Reminder days as a clean list: whole days from 1 to 28, largest first, at most 5. */
function reminderDays_() {
  const raw = [].concat(CONFIG.REMINDER_DAYS_BEFORE || []);
  const days = raw.map(Number).filter(d => Number.isInteger(d) && d >= 1 && d <= 28);
  return days.filter((d, i) => days.indexOf(d) === i).sort((a, b) => b - a).slice(0, 5);
}

/**
 * Diff-based sync: events the tracker created carry a private tag holding
 * their key. Wanted events that already exist are left alone, unwanted or
 * duplicate ones are deleted, missing ones are created. Untagged events
 * (anything added by hand) are never touched.
 */
function syncCalendar_(opts) {
  opts = opts || {};
  const cal = getCalendar_();
  const read = readCycles_();
  const cycles = read.cycles;
  const today = todayDay_();
  const model = buildModel_(cycles, today);

  let windowStart = today - CONFIG.HISTORY_DAYS;
  if (opts.full && cycles.length) windowStart = Math.min(windowStart, cycles[0].start);
  const windowEnd = today + (CONFIG.PREDICT_CYCLES + 1) * CONFIG.MAX_VALID_CYCLE;

  const wanted = new Map();
  planEvents_(cycles, model, today, windowStart).forEach(e => wanted.set(eventKey_(e), e));

  let created = 0;
  let deleted = 0;
  const kept = new Set();

  cal.getEvents(dayToDate_(windowStart), dayToDate_(windowEnd)).forEach(ev => {
    const key = ev.getTag(TAG_KEY);
    if (!key) return;
    const startIso = key.split('|')[1];
    if (!startIso || isoToDay_(startIso) < windowStart) return;
    if (wanted.has(key) && !kept.has(key)) {
      kept.add(key);
      return;
    }
    ev.deleteEvent();
    deleted++;
    Utilities.sleep(CONFIG.WRITE_PAUSE_MS);
  });

  wanted.forEach((e, key) => {
    if (kept.has(key)) return;
    let ev;
    if (e.timed) {
      const at = dayToDate_(e.start);
      at.setHours(CONFIG.LOG_END_NUDGE_HOUR, 0, 0, 0);
      ev = cal.createEvent(e.title, at, new Date(at.getTime() + 15 * 60000), { description: describe_(e, model) });
    } else {
      ev = cal.createAllDayEvent(e.title, dayToDate_(e.start), dayToDate_(e.end + 1), { description: describe_(e, model) });
    }
    ev.setTag(TAG_KEY, key);
    ev.setColor(colourFor_(e.kind));
    ev.removeAllReminders();
    if (e.timed) {
      ev.addPopupReminder(0);
    } else if (e.reminder) {
      // All-day reminders count back from midnight at the start of the event day.
      reminderDays_().forEach(d => ev.addPopupReminder(d * 1440 - CONFIG.REMINDER_HOUR * 60));
    }
    created++;
    Utilities.sleep(CONFIG.WRITE_PAUSE_MS);
  });

  return { created: created, deleted: deleted, warnings: read.warnings, model: model };
}

function describe_(e, model) {
  if (e.kind === 'period') return 'Logged in the Cycle Tracker sheet.';
  if (e.kind === 'nudge') return 'If the period has finished, log the end date on the Cycle page. This reminder disappears once an end date is logged.';
  const basis = model.cycleSamples
    ? 'Estimate based on a median cycle of ' + model.cycleLength + ' days from the last ' + model.cycleSamples + ' cycle(s).'
    : 'Estimate based on a default ' + model.cycleLength + '-day cycle until more history is logged.';
  if (e.kind === 'fertile' || e.kind === 'ovulation') {
    return basis + ' Calendar-method estimate only, not reliable for avoiding pregnancy.';
  }
  return basis;
}

function colourFor_(kind) {
  const C = CalendarApp.EventColor;
  return {
    period: C.RED,
    predicted: C.PALE_RED,
    due: C.ORANGE,
    fertile: C.PALE_GREEN,
    ovulation: C.GREEN,
    nudge: C.GRAY
  }[kind];
}

/* ------------------------------------------------------------------ */
/* Sheet access                                                        */
/* ------------------------------------------------------------------ */

function getSpreadsheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('This script must be attached to the Cycle Tracker sheet (Extensions > Apps Script).');
  return ss;
}

function getSheet_() {
  const sheet = getSpreadsheet_().getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) throw new Error('The "' + CONFIG.SHEET_NAME + '" sheet is missing. Run setup() from the script editor.');
  return sheet;
}

function getCalendar_() {
  const id = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
  const cal = id ? CalendarApp.getCalendarById(id) : null;
  if (!cal) throw new Error('The Cycle calendar was not found. Run setup() from the script editor to recreate it.');
  return cal;
}

function readCycles_() {
  const sheet = getSheet_();
  const tz = sheet.getParent().getSpreadsheetTimeZone();
  const today = todayDay_();
  const warnings = [];
  const cycles = [];
  const lastRow = sheet.getLastRow();

  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, 3).getValues().forEach((r, i) => {
      const row = i + 2;
      if (isBlank_(r[0]) && isBlank_(r[1])) return;
      const start = parseCell_(r[0], tz);
      if (start == null) {
        warnings.push('Row ' + row + ': the start date is not recognised, so the row is ignored.');
        return;
      }
      if (start > today) {
        warnings.push('Row ' + row + ': the start date is in the future, so the row is ignored.');
        return;
      }
      let end = isBlank_(r[1]) ? null : parseCell_(r[1], tz);
      if (!isBlank_(r[1]) && end == null) {
        warnings.push('Row ' + row + ': the end date is not recognised, so it is treated as blank.');
      }
      if (end != null && end < start) {
        warnings.push('Row ' + row + ': the end date is before the start, so it is treated as blank.');
        end = null;
      }
      if (end != null && end - start + 1 > CONFIG.MAX_PERIOD_LENGTH) {
        warnings.push('Row ' + row + ': that period is over ' + CONFIG.MAX_PERIOD_LENGTH + ' days long, so its end date is ignored.');
        end = null;
      }
      cycles.push({ row: row, start: start, end: end, note: r[2] });
    });
  }

  cycles.sort((a, b) => a.start - b.start);
  const unique = [];
  cycles.forEach(c => {
    if (unique.length && unique[unique.length - 1].start === c.start) {
      warnings.push('Row ' + c.row + ': duplicate start date, so the row is ignored.');
      return;
    }
    unique.push(c);
  });
  return { cycles: unique, warnings: warnings };
}

function sortSheet_() {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow > 2) sheet.getRange(2, 1, lastRow - 1, 3).sort({ column: 1, ascending: true });
}

function installTriggers_(ss) {
  removeTriggers();
  ScriptApp.newTrigger('dailySync').timeBased().everyDays(1)
    .atHour(CONFIG.DAILY_SYNC_HOUR).inTimezone(tz_()).create();
  ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(ss).onEdit().create();
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function mutate_(fn) {
  return withLock_(30000, () => {
    const message = fn();
    SpreadsheetApp.flush();
    let syncWarning = null;
    try {
      syncCalendar_();
    } catch (err) {
      syncWarning = 'Saved to the sheet, but the calendar update failed (' + err.message + '). The daily sync will retry.';
    }
    const state = getState();
    state.message = message;
    if (syncWarning) state.warnings.unshift(syncWarning);
    return state;
  });
}

function withLock_(waitMs, fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs)) throw new Error('Another update is running. Try again in a moment.');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function validateInputDate_(iso) {
  const today = todayDay_();
  if (iso == null || iso === '') return today;
  const s = String(iso).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || dayToIso_(isoToDay_(s)) !== s) {
    throw new Error('That date was not recognised.');
  }
  const day = isoToDay_(s);
  if (day > today) throw new Error('That date is in the future.');
  if (day < today - 3650) throw new Error('That date is more than ten years ago.');
  return day;
}

function parseCell_(v, tz) {
  if (isBlank_(v)) return null;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? null : dateToDay_(v, tz);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return safeDay_(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);   // UK order: d/m/yyyy
  if (m) return safeDay_(m[3], m[2], m[1]);
  return null;
}

function safeDay_(y, m, d) {
  const iso = y + '-' + pad2_(m) + '-' + pad2_(d);
  const day = isoToDay_(iso);
  return dayToIso_(day) === iso ? day : null;
}

function isBlank_(v) {
  return v === '' || v === null || v === undefined;
}

function median_(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function daysText_(n) {
  return n + (n === 1 ? ' day' : ' days');
}

function pad2_(n) {
  return ('0' + Number(n)).slice(-2);
}

/* Dates are handled internally as whole day numbers (days since 1970-01-01),
   which avoids time zone and daylight saving drift in the arithmetic. */

function isoToDay_(iso) {
  const p = iso.split('-').map(Number);
  return Math.round(Date.UTC(p[0], p[1] - 1, p[2]) / DAY_MS);
}

function dayToIso_(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/** Midnight local (script time zone) Date for writing to the sheet or calendar. */
function dayToDate_(n) {
  const p = dayToIso_(n).split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}

function dateToDay_(date, tz) {
  return isoToDay_(Utilities.formatDate(date, tz || tz_(), 'yyyy-MM-dd'));
}

function todayDay_() {
  return dateToDay_(new Date(), tz_());
}

/** The project's own time zone (Project Settings > Time zone), so it works anywhere. */
function tz_() {
  return Session.getScriptTimeZone();
}

function humanDay_(n) {
  const d = new Date(n * DAY_MS);
  const thisYear = new Date(todayDay_() * DAY_MS).getUTCFullYear();
  const year = d.getUTCFullYear() === thisYear ? '' : ' ' + d.getUTCFullYear();
  return DOW[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + year;
}
