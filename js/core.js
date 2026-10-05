/*
 * Study Manager core: scheduling (spaced repetition), session queues and statistics.
 *
 * Pure functions only — no DOM, no storage — so it runs in the browser and in Node tests.
 * The scheduler is a variant of SM-2 (the algorithm behind SuperMemo/Anki) with one addition:
 * when an exam date is set, review intervals are capped so every card is seen again before
 * the exam.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StudyCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  const AGAIN = 1;
  const HARD = 2;
  const GOOD = 3;
  const EASY = 4;
  const GRADE_LABELS = { 1: '다시', 2: '어려움', 3: '알맞음', 4: '쉬움' };

  const DEFAULTS = {
    learningSteps: [1, 10], // minutes between first-time recall attempts
    relearnSteps: [10], // minutes before a forgotten card is retried
    graduatingInterval: 1, // days, after passing all learning steps
    easyInterval: 4, // days, when a new card is marked Easy
    startingEase: 2.5,
    minEase: 1.3,
    hardFactor: 1.2,
    easyBonus: 1.3,
    lapseFactor: 0.5, // a forgotten card's interval is multiplied by this
    newPerDay: 20, // used when no exam date is set
    examBufferDays: 2, // days before the exam reserved for review only (no new cards)
    examDate: null, // timestamp (local midnight) of the exam day
  };

  // ---------- dates ----------

  function startOfDay(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function endOfDay(ts) {
    const d = new Date(ts);
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  }

  function addDays(ts, n) {
    const d = new Date(startOfDay(ts));
    d.setDate(d.getDate() + n);
    return d.getTime();
  }

  /** Whole calendar days from a to b (DST-safe). */
  function daysBetween(a, b) {
    return Math.round((startOfDay(b) - startOfDay(a)) / DAY);
  }

  /** Parses "YYYY-MM-DD" into a local-midnight timestamp, or null. */
  function parseDate(str) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str || '');
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  }

  function dayKey(ts) {
    const d = new Date(ts);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  }

  // ---------- cards & scheduling ----------

  function makeId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function createCard(deckId, front, back, now) {
    return {
      id: makeId(),
      deckId,
      front,
      back,
      createdAt: now,
      state: 'new', // new | learning | review | relearning
      due: now,
      interval: 0, // days
      ease: DEFAULTS.startingEase,
      step: 0,
      reps: 0,
      lapses: 0,
      lastReview: null,
    };
  }

  /** Caps an interval (days) so the next review lands before the exam. */
  function capToExam(interval, now, examDate) {
    if (examDate == null) return interval;
    const left = daysBetween(now, examDate);
    if (left < 1) return interval; // exam is today or over
    return Math.min(interval, Math.max(1, left - 1));
  }

  function graduate(c, interval, now, o) {
    c.state = 'review';
    c.step = 0;
    c.interval = Math.max(1, capToExam(Math.round(interval), now, o.examDate));
    c.due = addDays(now, c.interval);
    return c;
  }

  /**
   * Applies a recall grade (1 Again, 2 Hard, 3 Good, 4 Easy) and returns the updated card.
   * The input card is not modified.
   */
  function review(card, grade, now, options) {
    if (![AGAIN, HARD, GOOD, EASY].includes(grade)) throw new RangeError('grade must be 1-4');
    const o = Object.assign({}, DEFAULTS, options);
    const c = Object.assign({}, card, { reps: (card.reps || 0) + 1, lastReview: now });

    if (c.state === 'review') {
      if (grade === AGAIN) {
        c.lapses = (c.lapses || 0) + 1;
        c.ease = Math.max(o.minEase, c.ease - 0.2);
        c.interval = Math.max(1, Math.round(c.interval * o.lapseFactor));
        c.state = 'relearning';
        c.step = 0;
        c.due = now + o.relearnSteps[0] * MINUTE;
        return c;
      }
      const ivl = c.interval;
      const hard = Math.max(Math.round(ivl * o.hardFactor), ivl + 1);
      const good = Math.max(Math.round(ivl * c.ease), hard + 1);
      const easy = Math.max(Math.round(ivl * c.ease * o.easyBonus), good + 1);
      if (grade === HARD) c.ease = Math.max(o.minEase, c.ease - 0.15);
      if (grade === EASY) c.ease += 0.15;
      return graduate(c, grade === HARD ? hard : grade === GOOD ? good : easy, now, o);
    }

    // new, learning or relearning: short, minute-based steps
    const relearning = c.state === 'relearning';
    const steps = relearning ? o.relearnSteps : o.learningSteps;
    if (c.state === 'new') {
      c.state = 'learning';
      c.step = 0;
    }
    const step = Math.min(c.step, steps.length - 1);

    if (grade === AGAIN) {
      c.step = 0;
      c.due = now + steps[0] * MINUTE;
    } else if (grade === HARD) {
      const delay = (steps[step] + (steps[step + 1] !== undefined ? steps[step + 1] : steps[step])) / 2;
      c.step = step;
      c.due = now + delay * MINUTE;
    } else if (grade === GOOD) {
      c.step = step + 1;
      if (c.step >= steps.length) return graduate(c, relearning ? c.interval : o.graduatingInterval, now, o);
      c.due = now + steps[c.step] * MINUTE;
    } else {
      return graduate(c, relearning ? c.interval + 1 : o.easyInterval, now, o);
    }
    return c;
  }

  // ---------- formatting ----------

  function formatDays(d) {
    if (d < 30) return `${d}일`;
    if (d < 365) return `${+(d / 30).toFixed(1)}개월`;
    return `${+(d / 365).toFixed(1)}년`;
  }

  function formatDuration(ms) {
    const m = Math.round(ms / MINUTE);
    if (m < 60) return `${Math.max(1, m)}분`;
    const h = Math.round(ms / HOUR);
    if (h < 24) return `${h}시간`;
    return formatDays(Math.round(ms / DAY));
  }

  /** Short label for when a card would next be shown after the given grade. */
  function previewLabel(card, grade, now, options) {
    const next = review(card, grade, now, options);
    return next.state === 'review' ? formatDays(next.interval) : formatDuration(next.due - now);
  }

  // ---------- queues ----------

  /** FNV-1a hash, used for a stable per-session shuffle. */
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  /**
   * How many new cards to introduce today. With an exam date, the unseen material is spread
   * evenly over the days left before the review-only buffer; otherwise the fixed daily limit.
   */
  function newCardQuota(newRemaining, introducedToday, now, options) {
    const o = Object.assign({}, DEFAULTS, options);
    if (o.examDate == null) return Math.max(0, o.newPerDay - introducedToday);
    const daysLeft = daysBetween(now, o.examDate) - o.examBufferDays;
    const total = newRemaining + introducedToday;
    const perDay = daysLeft <= 1 ? total : Math.ceil(total / daysLeft);
    return Math.max(0, perDay - introducedToday);
  }

  /** New cards in round-robin order across decks, oldest first within each deck. */
  function interleaveNew(cards) {
    const byDeck = new Map();
    for (const c of [...cards].sort((a, b) => a.createdAt - b.createdAt)) {
      if (!byDeck.has(c.deckId)) byDeck.set(c.deckId, []);
      byDeck.get(c.deckId).push(c);
    }
    const lists = [...byDeck.values()];
    const out = [];
    for (let i = 0; out.length < cards.length; i++) {
      for (const list of lists) if (i < list.length) out.push(list[i]);
    }
    return out;
  }

  /**
   * Builds today's study queue.
   * Learning cards come first when due; reviews and new cards are shuffled together so
   * topics are interleaved rather than studied in blocks.
   */
  function buildQueue(cards, now, options, ctx) {
    const o = Object.assign({}, DEFAULTS, options);
    const { introducedToday = 0, extraNew = 0, deckId = null, seed = '' } = ctx || {};
    const pool = deckId ? cards.filter((c) => c.deckId === deckId) : cards;
    const eod = endOfDay(now);

    const learning = pool
      .filter((c) => c.state === 'learning' || c.state === 'relearning')
      .sort((a, b) => a.due - b.due);
    const reviews = pool.filter((c) => c.state === 'review' && c.due <= eod);
    const allNew = cards.filter((c) => c.state === 'new').length;
    const quota = newCardQuota(allNew, introducedToday, now, o) + extraNew;
    const news = interleaveNew(pool.filter((c) => c.state === 'new')).slice(0, quota);

    const mixed = [...reviews, ...news].sort((a, b) => hash(a.id + seed) - hash(b.id + seed));
    return {
      learningDue: learning.filter((c) => c.due <= now),
      learningLater: learning.filter((c) => c.due > now),
      mixed,
      reviewCount: reviews.length,
      newCount: news.length,
      quota,
    };
  }

  function nextCard(queue) {
    return queue.learningDue[0] || queue.mixed[0] || null;
  }

  // ---------- statistics ----------

  function introducedToday(log, now) {
    const start = startOfDay(now);
    return log.filter((e) => e.ts >= start && e.prevState === 'new').length;
  }

  /** Share of reviews of already-learned cards that were recalled (grade >= Hard). */
  function retention(log, since) {
    const rel = log.filter((e) => e.ts >= since && e.prevState === 'review');
    if (!rel.length) return null;
    return rel.filter((e) => e.grade > AGAIN).length / rel.length;
  }

  /** Consecutive days with at least one review, ending today (or yesterday). */
  function streak(log, now) {
    const days = new Set(log.map((e) => dayKey(e.ts)));
    let day = startOfDay(now);
    if (!days.has(dayKey(day))) day = addDays(day, -1);
    let n = 0;
    while (days.has(dayKey(day))) {
      n++;
      day = addDays(day, -1);
    }
    return n;
  }

  function reviewsPerDay(log, now, days) {
    const counts = new Map();
    for (const e of log) counts.set(dayKey(e.ts), (counts.get(dayKey(e.ts)) || 0) + 1);
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const ts = addDays(now, -i);
      out.push({ ts, count: counts.get(dayKey(ts)) || 0 });
    }
    return out;
  }

  /** Review cards due on each of the next `days` days (today includes overdue). */
  function forecast(cards, now, days) {
    const out = [];
    for (let i = 0; i < days; i++) out.push({ ts: addDays(now, i), count: 0 });
    for (const c of cards) {
      if (c.state !== 'review') continue;
      const i = Math.max(0, daysBetween(now, c.due));
      if (i < days) out[i].count++;
    }
    return out;
  }

  return {
    MINUTE, HOUR, DAY, AGAIN, HARD, GOOD, EASY, GRADE_LABELS, DEFAULTS,
    startOfDay, endOfDay, addDays, daysBetween, parseDate, dayKey, makeId,
    createCard, capToExam, review, previewLabel, formatDays, formatDuration,
    newCardQuota, interleaveNew, buildQueue, nextCard,
    introducedToday, retention, streak, reviewsPerDay, forecast,
  };
});
