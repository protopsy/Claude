const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core.js');

const NOW = new Date(2026, 9, 4, 10, 0, 0).getTime(); // 4 Oct 2026, 10:00 local
const day = (n) => C.addDays(NOW, n);

function reviewCard(interval, ease = 2.5) {
  return Object.assign(C.createCard('d1', 'Q', 'A', NOW), {
    state: 'review', interval, ease, due: NOW,
  });
}

test('new card walks through learning steps then graduates', () => {
  let c = C.createCard('d1', 'Q', 'A', NOW);
  c = C.review(c, C.GOOD, NOW);
  assert.equal(c.state, 'learning');
  assert.equal(c.due, NOW + 10 * C.MINUTE);
  c = C.review(c, C.GOOD, NOW);
  assert.equal(c.state, 'review');
  assert.equal(c.interval, 1);
  assert.equal(c.due, day(1));
});

test('Again during learning resets to the first step', () => {
  let c = C.review(C.createCard('d1', 'Q', 'A', NOW), C.GOOD, NOW);
  c = C.review(c, C.AGAIN, NOW);
  assert.equal(c.step, 0);
  assert.equal(c.due, NOW + C.MINUTE);
});

test('Easy on a new card graduates straight to the easy interval', () => {
  const c = C.review(C.createCard('d1', 'Q', 'A', NOW), C.EASY, NOW);
  assert.equal(c.state, 'review');
  assert.equal(c.interval, 4);
});

test('review intervals grow and are ordered Hard < Good < Easy', () => {
  const c = reviewCard(10);
  const hard = C.review(c, C.HARD, NOW);
  const good = C.review(c, C.GOOD, NOW);
  const easy = C.review(c, C.EASY, NOW);
  assert.equal(hard.interval, 12);
  assert.equal(good.interval, 25);
  assert.equal(easy.interval, 33);
  assert.ok(hard.ease < 2.5 && easy.ease > 2.5);
});

test('forgetting a review card sends it to relearning with a shorter interval', () => {
  let c = C.review(reviewCard(10), C.AGAIN, NOW);
  assert.equal(c.state, 'relearning');
  assert.equal(c.lapses, 1);
  assert.equal(c.interval, 5);
  assert.ok(Math.abs(c.ease - 2.3) < 1e-9);
  c = C.review(c, C.GOOD, NOW + 10 * C.MINUTE);
  assert.equal(c.state, 'review');
  assert.equal(c.interval, 5);
});

test('ease never drops below the minimum', () => {
  let c = reviewCard(10, 1.35);
  c = C.review(c, C.AGAIN, NOW);
  assert.equal(c.ease, 1.3);
});

test('review() does not mutate its input and rejects invalid grades', () => {
  const c = reviewCard(10);
  const copy = { ...c };
  C.review(c, C.GOOD, NOW);
  assert.deepEqual(c, copy);
  assert.throws(() => C.review(c, 5, NOW), RangeError);
});

test('intervals are capped so the next review lands before the exam', () => {
  const examDate = day(7);
  const c = C.review(reviewCard(10), C.GOOD, NOW, { examDate });
  assert.equal(c.interval, 6);
  assert.ok(c.due < examDate);
  // exam tomorrow: still review at least one day out
  assert.equal(C.capToExam(30, NOW, day(1)), 1);
  // exam passed: no cap
  assert.equal(C.capToExam(30, NOW, day(-3)), 30);
});

test('new-card quota spreads material evenly before the exam buffer', () => {
  // 10 days to exam, 2 buffer days -> 8 days to introduce 80 cards
  assert.equal(C.newCardQuota(80, 0, NOW, { examDate: day(10), examBufferDays: 2, newPerDay: 0 }), 10);
  // already introduced 4 today
  assert.equal(C.newCardQuota(76, 4, NOW, { examDate: day(10), examBufferDays: 2, newPerDay: 0 }), 6);
  // the daily setting wins when it is higher than the exam pace
  assert.equal(C.newCardQuota(148, 0, NOW, { examDate: day(101), examBufferDays: 2, newPerDay: 20 }), 20);
  assert.equal(C.newCardQuota(800, 0, NOW, { examDate: day(10), examBufferDays: 2, newPerDay: 20 }), 100);
  // inside the buffer: everything remaining
  assert.equal(C.newCardQuota(30, 0, NOW, { examDate: day(2), examBufferDays: 2 }), 30);
  // no exam: fixed daily limit
  assert.equal(C.newCardQuota(500, 5, NOW, { newPerDay: 20 }), 15);
});

test('new cards are interleaved across decks', () => {
  const mk = (deck, t) => Object.assign(C.createCard(deck, 'Q', 'A', NOW + t), {});
  const cards = [mk('a', 1), mk('a', 2), mk('a', 3), mk('b', 4), mk('b', 5)];
  assert.deepEqual(C.interleaveNew(cards).map((c) => c.deckId), ['a', 'b', 'a', 'b', 'a']);
});

test('queue: due learning first, then reviews/new mixed, respecting quota and deck filter', () => {
  const learning = Object.assign(C.createCard('a', 'L', 'A', NOW), { state: 'learning', due: NOW - 1 });
  const later = Object.assign(C.createCard('a', 'L2', 'A', NOW), { state: 'learning', due: NOW + C.HOUR });
  const due = Object.assign(reviewCard(3), { deckId: 'b', due: day(0) });
  const notDue = Object.assign(reviewCard(3), { due: day(2) });
  const news = Array.from({ length: 5 }, (_, i) => C.createCard('a', `N${i}`, 'A', NOW + i));
  const cards = [learning, later, due, notDue, ...news];

  const q = C.buildQueue(cards, NOW, { newPerDay: 3 }, { seed: 's' });
  assert.equal(C.nextCard(q), learning);
  assert.equal(q.learningLater.length, 1);
  assert.equal(q.reviewCount, 1);
  assert.equal(q.newCount, 3);
  assert.equal(q.mixed.length, 4);

  const qa = C.buildQueue(cards, NOW, { newPerDay: 3 }, { deckId: 'b' });
  assert.equal(qa.reviewCount, 1);
  assert.equal(qa.newCount, 0);
});

test('stats: retention, streak and forecast', () => {
  const log = [
    { ts: NOW, grade: 3, prevState: 'review' },
    { ts: NOW, grade: 1, prevState: 'review' },
    { ts: NOW, grade: 3, prevState: 'new' },
    { ts: day(-1) + 1000, grade: 3, prevState: 'review' },
    { ts: day(-3) + 1000, grade: 3, prevState: 'review' },
  ];
  assert.equal(C.retention(log, day(0)), 0.5);
  assert.equal(C.retention([], 0), null);
  assert.equal(C.streak(log, NOW), 2);
  assert.equal(C.introducedToday(log, NOW), 1);

  const cards = [
    Object.assign(reviewCard(1), { due: day(-2) }),
    Object.assign(reviewCard(1), { due: day(1) }),
    C.createCard('d1', 'Q', 'A', NOW),
  ];
  assert.deepEqual(C.forecast(cards, NOW, 3).map((d) => d.count), [1, 1, 0]);
});

test('formatting helpers', () => {
  assert.equal(C.formatDuration(10 * C.MINUTE), '10분');
  assert.equal(C.formatDuration(3 * C.HOUR), '3시간');
  assert.equal(C.formatDays(45), '1.5개월');
  assert.equal(C.parseDate('2026-10-14'), new Date(2026, 9, 14).getTime());
  assert.equal(C.parseDate('nope'), null);
  assert.equal(C.previewLabel(C.createCard('d', 'Q', 'A', NOW), C.AGAIN, NOW), '1분');
});

test('cloze: one card per blank, hints, and full sentence on the back', () => {
  const cards = C.clozeCards('GI는 {{불소}}를 방출하고 치질과 {{화학결합::결합 방식}}한다');
  assert.equal(cards.length, 2);
  assert.equal(cards[0][0], 'GI는 [ ? ]를 방출하고 치질과 화학결합한다');
  assert.equal(cards[0][1], '불소\n\nGI는 불소를 방출하고 치질과 화학결합한다');
  assert.equal(cards[1][0], 'GI는 불소를 방출하고 치질과 [ 결합 방식 ]한다');
  assert.ok(cards[1][1].startsWith('화학결합\n\n'));
  assert.equal(C.hasCloze('no blanks'), false);
});

test('parseCardLines handles separators, cloze lines, comments and bad lines', () => {
  const { cards, skipped } = C.parseCardLines([
    '# 섹션 제목',
    'Q1 :: A1',
    'Q2\tA2',
    '{{아말감}}은 수은 합금이다',
    '',
    'no separator here',
  ].join('\n'));
  assert.deepEqual(cards.map((c) => c[0]), ['Q1', 'Q2', '[ ? ]은 수은 합금이다']);
  assert.equal(skipped, 1);
});

test('built-in draft decks parse completely', () => {
  const presets = require('../js/decks.js');
  assert.ok(presets.length >= 1);
  for (const p of presets) {
    const { cards, skipped } = C.parseCardLines(p.text);
    assert.equal(skipped, 0, `${p.key} has lines without a separator`);
    assert.ok(cards.length >= 100, `${p.key} has ${cards.length} cards`);
    for (const [f, b] of cards) assert.ok(f && b);
  }
});
