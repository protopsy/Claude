const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core.js');
const P = require('../js/planner.js');

const TODAY = new Date(2026, 9, 5, 9, 0).getTime();
const day = (n) => C.addDays(TODAY, n);
const iso = (ts) => C.dayKey(ts);
const mat = (o) => ({ id: 'm', subject: 'S', name: 'Book', pages: 100, rounds: 1, start: iso(day(0)), end: iso(day(9)), done: 0, ...o });

test('pages are spread evenly over the window, starting today', () => {
  const s = P.scheduleMaterial(mat(), { log: {} }, TODAY);
  assert.equal(s.length, 10);
  assert.deepEqual(s.map((x) => x.to - x.from), Array(10).fill(10));
  assert.equal(s[0].ts, day(0));
  assert.equal(s[9].to, 100);
});

test('rounds multiply the work and labels show the round', () => {
  const m = mat({ pages: 50, rounds: 2 });
  const s = P.scheduleMaterial(m, { log: {} }, TODAY);
  assert.equal(s[s.length - 1].to, 100);
  assert.equal(P.rangeLabel(m, 0, 10), '1회독 p.1–10');
  assert.equal(P.rangeLabel(m, 45, 60), '1회독 p.46 → 2회독 p.10');
  assert.equal(P.rangeLabel(mat(), 9, 10), 'p.10');
});

test("logging today's pages keeps today's target and moves later days on", () => {
  const m = mat({ done: 25 });
  const plan = { log: { [iso(TODAY)]: { m: 25 } } };
  const s = P.scheduleMaterial(m, plan, TODAY);
  assert.deepEqual([s[0].from, s[0].to], [0, 10]); // target unchanged
  assert.equal(s[1].from, 25); // tomorrow continues after what was actually read
  assert.equal(s[s.length - 1].to, 100);
});

test('missed work is re-spread over the remaining days', () => {
  // window started 5 days ago, nothing read: 100 pages over the 5 days left
  const m = mat({ start: iso(day(-5)), end: iso(day(4)) });
  const s = P.scheduleMaterial(m, { log: {} }, TODAY);
  assert.equal(s.length, 5);
  assert.equal(s[0].to - s[0].from, 20);
});

test('future windows start on their start date; overdue work lands today', () => {
  const later = P.scheduleMaterial(mat({ start: iso(day(3)), end: iso(day(4)) }), { log: {} }, TODAY);
  assert.equal(later[0].ts, day(3));
  const over = P.scheduleMaterial(mat({ start: iso(day(-9)), end: iso(day(-1)), done: 60 }), { log: {} }, TODAY);
  assert.equal(over.length, 1);
  assert.equal(over[0].overdue, true);
  assert.deepEqual([over[0].from, over[0].to], [60, 100]);
  assert.deepEqual(P.scheduleMaterial(mat({ done: 100 }), { log: {} }, TODAY), []);
});

test('calendar combines materials and shows logged pages on past days', () => {
  const a = mat({ id: 'a' });
  const b = mat({ id: 'b', pages: 50 });
  const plan = { materials: [a, b], log: { [iso(day(-1))]: { a: 12 } } };
  const cal = P.buildCalendar(plan, TODAY);
  assert.equal(P.dayTotal(cal.get(iso(TODAY))), 15);
  const past = cal.get(iso(day(-1)));
  assert.equal(past[0].past, true);
  assert.equal(P.dayTotal(past), 12);
});

test('default plan follows the OT period strategy and fits before the exam', () => {
  const exam = new Date(2027, 0, 14).getTime();
  const ms = P.defaultMaterials(exam, TODAY);
  assert.equal(ms.length, P.DENTAL_DEFAULTS.length);
  for (const m of ms) {
    assert.ok(m.start >= iso(TODAY) && m.end >= m.start && m.end < iso(exam), `${m.name} ${m.start}~${m.end}`);
  }
  const labels = P.milestones(exam, 2).map((x) => `${iso(x.ts)} ${x.label}`);
  assert.ok(labels.includes('2027-01-14 국가고시'));
  assert.ok(labels.includes('2027-01-07 총족 배포(예상)'));
});

test('read ranges come back after 1 day, 1 week and 3 weeks, pulled in before the exam', () => {
  const m = mat();
  const rv = P.reviewTasks([{ day: iso(TODAY), m, from: 0, to: 14 }], day(100));
  assert.deepEqual(rv.map((t) => t.due), [iso(day(1)), iso(day(7)), iso(day(21))]);
  // exam in 10 days: the 3-week review moves to the day before the exam
  const late = P.reviewTasks([{ day: iso(TODAY), m, from: 0, to: 14 }], day(10));
  assert.deepEqual(late.map((t) => t.due), [iso(day(1)), iso(day(7)), iso(day(9))]);
  // read the day before the exam: nothing left to schedule
  assert.equal(P.reviewTasks([{ day: iso(day(9)), m, from: 0, to: 5 }], day(10)).length, 0);
});

test('past-question sessions: midway and end, plus a start session for 교정/보존', () => {
  const q = P.quizTasks([mat({ id: 'a' }), mat({ id: 'b', subject: '치과교정학' }), mat({ id: 'c', subject: '전과목' })]);
  assert.deepEqual(q.filter((t) => t.m.id === 'a').map((t) => t.kind), ['mid', 'end']);
  assert.deepEqual(q.filter((t) => t.m.id === 'b').map((t) => t.kind), ['start', 'mid', 'end']);
  assert.equal(q.filter((t) => t.m.id === 'c').length, 0);
});

test("today's tasks: due and overdue reviews until checked, recall for ranges read today", () => {
  const m = mat({ done: 20 });
  const plan = {
    materials: [m],
    log: { [iso(day(-1))]: { m: 10 }, [iso(TODAY)]: { m: 10 } },
    ranges: { [iso(day(-1))]: { m: [0, 10] }, [iso(day(-8))]: { m: [0, 0] }, [iso(TODAY)]: { m: [10, 20] } },
    checks: {},
  };
  let t = P.todayTasks(plan, TODAY, day(100));
  assert.equal(t.reviews.length, 1);
  assert.equal(t.reviews[0].ago, 1);
  assert.equal(t.recalls.length, 1);
  assert.deepEqual([t.recalls[0].from, t.recalls[0].to], [10, 20]);
  assert.equal(t.reading.length, 1);

  const checkedKey = t.reviews[0].key;
  plan.checks[checkedKey] = iso(TODAY);
  t = P.todayTasks(plan, TODAY, day(100));
  assert.equal(t.reviews[0].done, true); // still listed today, shown as done
  t = P.todayTasks(plan, day(1), day(100));
  assert.ok(!t.reviews.some((r) => r.key === checkedKey)); // gone the next day
  assert.ok(t.reviews.some((r) => r.readDay === iso(TODAY))); // today's reading is due tomorrow

  // an unchecked review stays as overdue
  delete plan.checks[`rv|${iso(day(-1))}|m|1`];
  t = P.todayTasks(plan, day(2), day(100));
  assert.equal(t.reviews[0].overdue, true);
});

test('calendar extras project reviews from planned reading', () => {
  const m = mat();
  const plan = { materials: [m], log: {}, ranges: {}, checks: {} };
  const cal = P.buildCalendar(plan, TODAY);
  const ex = P.calendarExtras(plan, cal, TODAY, day(100));
  // planned reading on day 1 -> review on day 2
  assert.ok(ex.get(iso(day(2))).reviews.some((r) => r.readDay === iso(day(1))));
  assert.ok(ex.get(iso(day(9))).quizzes.some((q) => q.kind === 'end'));
});
