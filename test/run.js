// Runs Code.gs against mocked Sheets, Calendar and trigger services.
// Usage: npm test
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const TZ = 'Europe/London';
const path = require('path');
const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'Code.gs'), 'utf8');

function makeEnv() {
  const rows = [];
  const props = {};
  const events = [];
  let triggers = [];
  let calCreated = 0;
  const range = (r, c, nr = 1, nc = 1) => ({
    getValues: () => rows.slice(r - 1, r - 1 + nr).map(row => Array.from({ length: nc }, (_, j) => row[c - 1 + j] ?? '')),
    setValue: v => { while (rows.length < r) rows.push([]); rows[r - 1][c - 1] = v; },
    sort: () => { const part = rows.splice(r - 1, nr); part.sort((a, b) => a[0] - b[0]); rows.splice(r - 1, 0, ...part); },
    setFontWeight() { return this; }, setNumberFormat() { return this; }
  });
  const sheet = {
    getName: () => 'Cycles', getParent: () => ss, getLastRow: () => rows.length,
    getRange: (a, ...rest) => typeof a === 'string' ? range(1, 1) : range(a, ...rest),
    appendRow: a => rows.push(a.slice()), deleteRow: r => rows.splice(r - 1, 1),
    setFrozenRows() {}, setColumnWidths() {}, setColumnWidth() {}, setName() { return sheet; }
  };
  const ss = {
    getSheetByName: n => n === 'Cycles' ? sheet : null, getSheets: () => [],
    insertSheet: () => sheet, setSpreadsheetTimeZone() {}, getSpreadsheetTimeZone: () => TZ, getUrl: () => 'https://sheet'
  };
  const fmtYMD = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const cal = {
    getId: () => 'cal1', getName: () => 'Cycle',
    getEvents: (s, e) => events.filter(ev => !ev.deleted && ev.start < e && ev.end > s).map(wrap),
    createAllDayEvent: (title, s, e) => { const ev = { title, start: s, end: e, tags: {}, reminders: [], allDay: true }; events.push(ev); return wrap(ev); },
    createEvent: (title, s, e) => { const ev = { title, start: s, end: e, tags: {}, reminders: [], allDay: false }; events.push(ev); return wrap(ev); }
  };
  function wrap(ev) {
    return {
      getTag: k => ev.tags[k] || null, setTag: (k, v) => { ev.tags[k] = v; }, setColor: c => { ev.color = c; },
      removeAllReminders: () => { ev.reminders = []; }, addPopupReminder: m => ev.reminders.push(m),
      deleteEvent: () => { ev.deleted = true; }
    };
  }
  const ctx = {
    console, Logger: { log: () => {} },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() {} },
    CalendarApp: {
      getCalendarById: id => (id === 'cal1' && calCreated ? cal : null),
      createCalendar: () => { calCreated++; return cal; },
      EventColor: { RED: '11', PALE_RED: '4', ORANGE: '6', PALE_GREEN: '2', GREEN: '10', GRAY: '8' }
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ScriptApp: {
      getProjectTriggers: () => triggers.map(t => ({ getHandlerFunction: () => t, _t: t })),
      deleteTrigger: t => { triggers = triggers.filter(x => x !== t._t); },
      newTrigger: name => { const b = { timeBased: () => b, everyDays: () => b, atHour: () => b, inTimezone: () => b, forSpreadsheet: () => b, onEdit: () => b, create: () => triggers.push(name) }; return b; }
    },
    HtmlService: {}, Session: { getScriptTimeZone: () => TZ }, Utilities: { formatDate: (d) => fmtYMD(d), sleep() {} },
    Map, Set, Date, Math, Object, String, Number, Array, Error, JSON
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { ctx, rows, events, calCreated: () => calCreated, triggers: () => triggers, live: () => events.filter(e => !e.deleted) };
}

const env = makeEnv();
const c = env.ctx;
let today = '2026-10-20';
c.todayDay_ = () => c.isoToDay_(today);

c.setup(); c.setup(); // twice: triggers and calendar must not duplicate
assert.deepStrictEqual(env.triggers().sort(), ['dailySync', 'onSheetEdit']);
assert.strictEqual(env.calCreated(), 1);
assert.strictEqual(env.live().length, 0);

c.logStart('2026-07-28'); c.logEnd('2026-08-01');
c.logStart('2026-08-25'); c.logEnd('2026-08-29');
c.logStart('2026-09-22');                // no end, will be auto-closed
let s = c.logStart('2026-10-19');
console.log('MSG:', s.message);
assert.match(s.message, /previous period had no end date/);
console.log('MODEL:', JSON.stringify(s.model));
assert.strictEqual(s.model.cycleLength, 28);       // gaps 28,28,27 -> median 28
assert.strictEqual(s.model.periodLength, 5);
assert.strictEqual(s.model.ongoing, true);
assert.strictEqual(s.model.nextStart, '2026-11-16');
assert.strictEqual(s.model.ovulation, '2026-11-02');
assert.strictEqual(s.model.fertileStart, '2026-10-28');
assert.strictEqual(s.model.fertileEnd, '2026-11-03');
const d = x => new Intl.DateTimeFormat('en-CA',{timeZone:TZ}).format(x);
const fmtEv = e => `${e.title.padEnd(22)} ${d(e.start)} -> ${d(new Date(e.end - 1))} rem=${JSON.stringify(e.reminders)}`;
console.log('EVENTS:\n' + env.live().sort((a,b)=>a.start-b.start).map(fmtEv).join('\n'));
assert.strictEqual(env.live().filter(e => e.title === 'Period').length, 4);
assert.strictEqual(env.live().filter(e => e.title === 'Period (predicted)').length, 6);
assert.strictEqual(env.live().filter(e => e.reminders.length && e.allDay).length, 1);
assert.deepStrictEqual(env.live().find(e => e.reminders.length && e.allDay).reminders, [7 * 1440 - 9 * 60, 2 * 1440 - 9 * 60]);
// nudge: period started 19 Oct, usual length 5 -> nudges 24 Oct and 26 Oct at 19:00
const nudges = env.live().filter(e => e.title === 'Log period end?');
console.log('NUDGES:', nudges.map(n => n.start.toString()));
assert.strictEqual(nudges.length, 2);
assert.deepStrictEqual(nudges.map(n => d(n.start)), ['2026-10-24', '2026-10-26']);
assert.ok(nudges.every(n => new Intl.DateTimeFormat('en-GB',{timeZone:TZ,hour:'2-digit',minute:'2-digit'}).format(n.start) === '19:00'));
assert.ok(nudges.every(n => JSON.stringify(n.reminders) === '[0]'));
// DST check: an event across the 25 Oct 2026 clock change keeps whole days
assert.ok(env.live().every(e => d(e.start) <= d(new Date(e.end - 1))));

// idempotent
const before = env.live().length;
let r = c.syncCalendar_();
assert.deepStrictEqual([r.created, r.deleted], [0, 0]);
assert.strictEqual(env.live().length, before);

// duplicate cleanup
const dup = env.live()[0]; env.events.push({ ...dup, tags: { ...dup.tags }, reminders: [] });
r = c.syncCalendar_(); assert.deepStrictEqual([r.created, r.deleted], [0, 1]);

// hand-made untagged event untouched
env.events.push({ title: 'Manual', start: new Date(2026, 9, 21), end: new Date(2026, 9, 22), tags: {}, reminders: [] });
c.syncCalendar_(); assert.ok(env.live().some(e => e.title === 'Manual'));

// validation
assert.throws(() => c.logStart('2026-10-20'), /only 1 day after/);
assert.throws(() => c.logEnd('2026-11-05'), /future/);
assert.throws(() => c.logStart('2026-02-30'), /not recognised/);
today = '2026-11-10';
assert.throws(() => c.logEnd('2026-11-05'), /18 days long/);
s = c.logEnd('2026-10-23');
assert.strictEqual(s.model.ongoing, false);
assert.strictEqual(env.live().filter(e => e.title === 'Log period end?').length, 0);
console.log('NORMAL DAY STATE:', JSON.stringify(s.model));

// late period
today = '2026-11-20';
s = c.getState(); c.syncCalendar_();
console.log('LATE:', JSON.stringify({ late: s.model.late, daysLate: s.model.daysLate, next: s.model.nextStart }));
assert.strictEqual(s.model.late, true); assert.strictEqual(s.model.daysLate, 4);
assert.ok(env.live().some(e => e.title === 'Period due'));
assert.strictEqual(env.live().filter(e => e.reminders.length && e.allDay).length, 0);
s = c.logStart('2026-11-20');
assert.strictEqual(env.live().filter(e => e.title === 'Period due').length, 0);
assert.strictEqual(s.model.ongoing, true);

// sheet edited by hand: UK text date plus a bad row
env.rows.push(['3/6/2026', '7/6/2026', '']); env.rows.push(['rubbish', '', '']);
s = c.getState();
console.log('WARNINGS:', s.warnings);
assert.strictEqual(s.warnings.length, 1);
assert.ok(s.history.length <= 8);
assert.ok(s.history.some(h => h.start === '2026-06-03'));

// delete
s = c.deleteCycle('2026-11-20');
assert.ok(!s.history.some(h => h.start === '2026-11-20'));
r = c.syncCalendar_({ full: true });
console.log('FULL REBUILD:', r.created, 'added', r.deleted, 'removed');
r = c.syncCalendar_({ full: true });
assert.deepStrictEqual([r.created, r.deleted], [0, 0]);

// empty sheet
const env2 = makeEnv(); env2.ctx.todayDay_ = () => env2.ctx.isoToDay_('2026-10-20');
env2.ctx.setup(); const s2 = env2.ctx.getState();
assert.strictEqual(s2.model, null); assert.strictEqual(env2.live().length, 0);

// single start only -> default 28
const env3 = makeEnv(); env3.ctx.todayDay_ = () => env3.ctx.isoToDay_('2026-10-20');
env3.ctx.setup(); const s3 = env3.ctx.logStart('2026-10-10');
assert.strictEqual(s3.model.cycleLength, 28); assert.strictEqual(s3.model.cycleSamples, 0);
assert.strictEqual(s3.model.nextStart, '2026-11-07');

console.log('\nALL TESTS PASSED');
