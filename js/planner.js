/*
 * Study planner: spreads reading material (pages × rounds) over date windows and works out
 * what to read each day. Pure functions (no DOM, no storage) so they run in Node tests too.
 *
 * A material's progress is a single number, `done`: pages read across all rounds. Today's
 * target is the remaining work divided evenly over the days left in its window, so a missed
 * day is automatically spread over the days that remain.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.StudyPlanner = factory(root.StudyCore);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  /**
   * Default plan from the 79회 OT guide's period strategy (기간별 전략) and recommended materials.
   * Dates are D-days before the exam; page counts are placeholders for the student to correct.
   * [subject, material, pages, rounds, startD, endD, group]
   */
  const DENTAL_DEFAULTS = [
    ['치과재료학', '경희치재', 250, 2, 101, 65, '초반'],
    ['영상치의학', '교과서 1~13장 (이론)', 200, 1, 101, 70, '초반'],
    ['구강악안면외과학', '퍼플외과 (일반외과·악성)', 300, 1, 101, 60, '초반'],
    ['구강병리학', '테마병리', 150, 2, 101, 60, '초반'],
    ['치과교정학', '옳소교정', 250, 1, 101, 60, '초반'],
    ['치주과학', '치주대마왕', 350, 2, 101, 35, '초반'],
    ['소아치과학', '소맥', 300, 1, 80, 40, '중반'],
    ['치과보철학', '골드크라운 · olleh RPD', 350, 1, 80, 40, '중반'],
    ['치과보존학', 'all in one (수복)', 200, 1, 80, 50, '중반'],
    ['구강내과학', '단내지존', 120, 2, 80, 50, '중반'],
    ['구강생물학', '생맥 (최신 5개년 기출)', 250, 1, 80, 40, '중반'],
    ['구강보건학', '보석건틀렛', 150, 2, 60, 25, '후반'],
    ['보건의약관계법규', '법규王', 150, 2, 60, 14, '후반'],
    ['전과목', '라플 1회독', 1500, 1, 65, 30, '라플'],
    ['전과목', '라플 · 단권화 자료 반복', 1500, 2, 29, 3, '복습'],
  ];

  function isoDate(ts) {
    return C.dayKey(ts);
  }

  function defaultMaterials(examTs, todayTs) {
    const today = C.startOfDay(todayTs);
    return DENTAL_DEFAULTS.map(([subject, name, pages, rounds, startD, endD, group]) => {
      const start = Math.max(today, C.addDays(examTs, -startD));
      const end = Math.max(start, C.addDays(examTs, -endD));
      return {
        id: C.makeId(),
        subject,
        name,
        group,
        pages,
        rounds,
        start: isoDate(start),
        end: isoDate(end),
        done: 0,
        estimated: true,
      };
    });
  }

  function totalPages(m) {
    return Math.max(0, m.pages | 0) * Math.max(1, m.rounds | 0);
  }

  function loggedOn(plan, key, id) {
    return ((plan.log || {})[key] || {})[id] || 0;
  }

  /** Converts "pages done so far" into a round and page number (1-based). */
  function position(m, p) {
    const round = Math.max(1, Math.ceil(p / m.pages));
    return { round, page: p - (round - 1) * m.pages };
  }

  /** Human label for reading pages (from, to], e.g. "2회독 p.41–70". */
  function rangeLabel(m, from, to) {
    if (!m.pages || to <= from) return '';
    const a = position(m, from + 1);
    const b = position(m, to);
    const r = (round) => (m.rounds > 1 ? `${round}회독 ` : '');
    if (a.round === b.round) {
      return a.page === b.page ? `${r(a.round)}p.${a.page}` : `${r(a.round)}p.${a.page}–${b.page}`;
    }
    return `${r(a.round)}p.${a.page} → ${r(b.round)}p.${b.page}`;
  }

  /**
   * Day-by-day reading slices for one material from today onward:
   * [{ ts, from, to, overdue }] where (from, to] are cumulative page positions.
   */
  function scheduleMaterial(m, plan, todayTs) {
    const today = C.startOfDay(todayTs);
    const total = totalPages(m);
    const start = C.parseDate(m.start);
    const end = C.parseDate(m.end);
    if (!total || start == null || end == null) return [];

    const base = m.done - loggedOn(plan, C.dayKey(today), m.id); // done before today
    if (base >= total) return [];

    if (end < today) {
      return [{ ts: today, from: base, to: total, overdue: true }];
    }
    const first = Math.max(start, today);
    const days = Math.max(1, C.daysBetween(first, end) + 1);
    const out = [];
    let pos = base;
    let i = 0;
    if (first === today) {
      const to = Math.min(total, base + Math.max(1, Math.round((total - base) / days)));
      out.push({ ts: today, from: base, to, overdue: false });
      pos = Math.max(to, Math.min(total, m.done));
      i = 1;
    }
    const left = total - pos;
    const n = days - i;
    for (let k = 0; k < n && left > 0; k++) {
      const from = pos + Math.round((left * k) / n);
      const to = pos + Math.round((left * (k + 1)) / n);
      if (to > from) out.push({ ts: C.addDays(first, i + k), from, to, overdue: false });
    }
    return out;
  }

  /**
   * Map of dayKey -> [{ m, from, to, pages, overdue }] for today onward, plus logged pages for
   * past days: [{ m, pages, past: true }].
   */
  function buildCalendar(plan, todayTs) {
    const map = new Map();
    const add = (key, item) => {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    };
    const todayKey = C.dayKey(todayTs);
    for (const m of plan.materials || []) {
      for (const s of scheduleMaterial(m, plan, todayTs)) {
        add(C.dayKey(s.ts), { m, from: s.from, to: s.to, pages: s.to - s.from, overdue: s.overdue });
      }
    }
    for (const [key, entries] of Object.entries(plan.log || {})) {
      if (key >= todayKey) continue;
      for (const m of plan.materials || []) {
        if (entries[m.id]) add(key, { m, pages: entries[m.id], past: true });
      }
    }
    return map;
  }

  function dayTotal(items) {
    return (items || []).reduce((s, it) => s + (it.pages || 0), 0);
  }

  /** Fixed milestones from the OT guide, relative to the exam date. */
  function milestones(examTs, bufferDays) {
    const list = [
      { ts: C.addDays(examTs, -65), label: '라플 배포(예상)' },
      { ts: C.addDays(examTs, -20), label: '찌라시 시작(예상)' },
      { ts: C.addDays(examTs, -7), label: '총족 배포(예상)' },
      { ts: examTs, label: '국가고시', exam: true },
    ];
    for (let d = 1; d <= bufferDays; d++) list.push({ ts: C.addDays(examTs, -d), label: '복습 전용', buffer: true });
    return list;
  }

  return {
    DENTAL_DEFAULTS, defaultMaterials, totalPages, loggedOn, position, rangeLabel,
    scheduleMaterial, buildCalendar, dayTotal, milestones,
  };
});
