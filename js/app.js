/* Exam Study Manager — UI, persistence and Pomodoro timer. Scheduling lives in core.js. */
(function () {
  'use strict';

  const C = window.StudyCore;
  const STORAGE_KEY = 'exam-study-manager.v1';
  const MAX_CARD_MS = 5 * C.MINUTE;

  // ---------- persistence ----------

  const DEFAULT_SETTINGS = {
    examName: '',
    examDate: '',
    newPerDay: 20,
    examBufferDays: 2,
    typeAnswer: true,
    pomodoroWork: 25,
    pomodoroBreak: 5,
    pomodoroLongBreak: 15,
  };

  function emptyState() {
    return {
      version: 1,
      decks: [],
      cards: [],
      log: [],
      settings: { ...DEFAULT_SETTINGS },
      pomodoro: { day: '', completed: 0 },
      extraNew: { day: '', count: 0 },
    };
  }

  function normalize(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.cards)) {
      throw new Error('This file is not a Study Manager backup.');
    }
    const base = emptyState();
    return {
      ...base,
      decks: Array.isArray(data.decks) ? data.decks : [],
      cards: data.cards,
      log: Array.isArray(data.log) ? data.log : [],
      settings: { ...base.settings, ...(data.settings || {}) },
      pomodoro: { ...base.pomodoro, ...(data.pomodoro || {}) },
      extraNew: { ...base.extraNew, ...(data.extraNew || {}) },
    };
  }

  function load() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
      return raw ? normalize(JSON.parse(raw)) : emptyState();
    } catch (err) {
      console.error('Could not load saved data', err);
      // Keep the unreadable data so it is not lost when we save next.
      try { if (raw) localStorage.setItem(`${STORAGE_KEY}.corrupt-${Date.now()}`, raw); } catch (_) { /* ignore */ }
      return emptyState();
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      console.error(err);
      toast('Could not save — browser storage may be full. Export a backup from Settings.');
    }
  }

  let state = load();

  // ---------- helpers ----------

  const $ = (sel) => document.querySelector(sel);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
  }

  function toInt(v, fallback) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  function opts() {
    const s = state.settings;
    return {
      examDate: C.parseDate(s.examDate),
      newPerDay: toInt(s.newPerDay, 20),
      examBufferDays: toInt(s.examBufferDays, 2),
    };
  }

  function deck(id) {
    return state.decks.find((d) => d.id === id);
  }

  function deckName(id) {
    const d = deck(id);
    return d ? d.name : '(deleted deck)';
  }

  function queue(deckId, now) {
    return C.buildQueue(state.cards, now, opts(), {
      introducedToday: C.introducedToday(state.log, now),
      extraNew: state.extraNew.day === C.dayKey(now) ? state.extraNew.count : 0,
      deckId,
      seed: ui.session ? ui.session.seed : '',
    });
  }

  function shortDate(ts) {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function dueLabel(card, now) {
    if (card.state === 'new') return 'new';
    if (card.state !== 'review') return card.due <= now ? 'now' : `in ${C.formatDuration(card.due - now)}`;
    const d = C.daysBetween(now, card.due);
    if (d <= 0) return 'today';
    if (d === 1) return 'tomorrow';
    return `in ${d} days`;
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
  }

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---------- navigation ----------

  const ui = {
    view: 'dashboard',
    deckId: null,
    editingCardId: null,
    session: null,
    practice: null,
    refreshTimer: null,
  };

  function newSession(deckId) {
    return {
      deckId: deckId || null,
      seed: C.makeId(),
      currentId: null,
      revealed: false,
      attempt: '',
      shownAt: 0,
      undo: null,
      done: 0,
    };
  }

  function navigate(view, param) {
    clearTimeout(ui.refreshTimer);
    ui.view = view;
    ui.editingCardId = null;
    if (view === 'deck') ui.deckId = param;
    if (view === 'study') ui.session = newSession(param);
    if (view === 'practice') ui.practice = { stage: 'setup', deckId: param || '' };
    render();
    window.scrollTo(0, 0);
  }

  const views = {
    dashboard: renderDashboard,
    study: renderStudy,
    practice: renderPractice,
    decks: renderDecks,
    deck: renderDeck,
    stats: renderStats,
    settings: renderSettings,
    guide: renderGuide,
  };

  function render() {
    if (ui.view === 'study' && !ui.session) ui.session = newSession(null);
    if (ui.view === 'practice' && !ui.practice) ui.practice = { stage: 'setup', deckId: '' };
    if (ui.view === 'deck' && !deck(ui.deckId)) ui.view = 'decks';
    $('#app').innerHTML = views[ui.view]();
    const navView = ui.view === 'deck' ? 'decks' : ui.view;
    document.querySelectorAll('[data-nav]').forEach((b) => {
      b.classList.toggle('active', !!b.closest('.nav') && b.dataset.nav === navView);
    });
    const focusEl = $('[data-autofocus]');
    if (focusEl) focusEl.focus();
  }

  // ---------- dashboard ----------

  function renderExamPanel(now) {
    const s = state.settings;
    const exam = opts().examDate;
    const name = esc(s.examName || 'your exam');
    if (exam == null) {
      return `<section class="panel">
        <h2>No exam date set</h2>
        <p>Set your exam date in <a href="#" data-nav="settings">Settings</a>. The app will then make sure
        every card is reviewed before the exam and tell you how many new cards to learn each day.</p>
      </section>`;
    }
    const left = C.daysBetween(now, exam);
    let headline;
    if (left > 0) headline = `<div class="big-number">${left}</div><div>${left === 1 ? 'day' : 'days'} until ${name}</div>`;
    else if (left === 0) headline = `<div class="big-number">Today</div><div>${name} is today — good luck! Do a light review only.</div>`;
    else headline = `<div>${name} was on ${shortDate(exam)}. Set your next exam date in <a href="#" data-nav="settings">Settings</a>.</div>`;

    let advice = '';
    const buffer = toInt(s.examBufferDays, 2);
    if (left > buffer) advice = `New material until ${shortDate(C.addDays(exam, -buffer))}, then ${plural(buffer, 'day')} of review only.`;
    else if (left > 0) advice = 'Final stretch: focus on reviews, practice tests and the cards you keep forgetting.';
    return `<section class="panel">${headline}${advice ? `<p class="muted small" style="margin-top:.5em">${advice}</p>` : ''}</section>`;
  }

  function renderDashboard() {
    const now = Date.now();
    if (!state.cards.length) {
      return `${renderExamPanel(now)}
        <section class="panel empty">
          <h2>Welcome! Let's set up your material.</h2>
          <p class="muted">Make a deck for each topic of your exam, then add question/answer cards to it.</p>
          <div class="row" style="justify-content:center">
            <button class="primary" data-nav="decks">Create a deck</button>
            <button data-action="load-example">Load an example deck</button>
            <button data-nav="guide">How it works</button>
          </div>
        </section>`;
    }

    const q = queue(null, now);
    const learningTotal = q.learningDue.length + q.learningLater.length;
    const doneToday = state.log.filter((e) => e.ts >= C.startOfDay(now)).length;
    const unseen = state.cards.filter((c) => c.state === 'new').length;
    const dueNow = q.learningDue.length + q.mixed.length;
    const pomoToday = state.pomodoro.day === C.dayKey(now) ? state.pomodoro.completed : 0;

    let plan;
    if (!unseen) plan = 'You have seen every card at least once. Keep up with reviews and do practice tests.';
    else if (opts().examDate != null) plan = `${plural(unseen, 'unseen card')} left. To cover them all in time, learn at least <strong>${C.newCardQuota(unseen + C.introducedToday(state.log, now), 0, now, opts())}</strong> new cards per day.`;
    else plan = `${plural(unseen, 'unseen card')} left, introduced at ${opts().newPerDay} per day.`;

    const rows = state.decks.map((d) => {
      const cards = state.cards.filter((c) => c.deckId === d.id);
      const known = cards.filter((c) => c.state === 'review').length;
      const due = cards.filter((c) => (c.state === 'review' && c.due <= C.endOfDay(now)) || ((c.state === 'learning' || c.state === 'relearning') && c.due <= now)).length;
      const pct = cards.length ? Math.round((known / cards.length) * 100) : 0;
      return `<tr>
        <td><a href="#" data-action="open-deck" data-id="${d.id}">${esc(d.name)}</a></td>
        <td class="num">${cards.length}</td>
        <td class="num">${cards.filter((c) => c.state === 'new').length}</td>
        <td class="num">${due}</td>
        <td><div class="row"><div class="progress" style="flex:1"><div style="width:${pct}%"></div></div><span class="small muted">${pct}%</span></div></td>
        <td class="num"><button data-action="study-deck" data-id="${d.id}">Study</button></td>
      </tr>`;
    }).join('');

    return `${renderExamPanel(now)}
      <section class="panel">
        <div class="row spread">
          <h2>Today</h2>
          <span class="counts" title="Learning · Review · New">
            <span class="c-learn">${q.learningDue.length}</span>
            <span class="c-review">${q.reviewCount}</span>
            <span class="c-new">${q.newCount}</span>
          </span>
        </div>
        <div class="grid" style="margin:.5em 0 1em">
          <div class="stat"><span class="label">Due now</span><span class="value">${dueNow}</span></div>
          <div class="stat"><span class="label">In learning</span><span class="value">${learningTotal}</span></div>
          <div class="stat"><span class="label">Reviewed today</span><span class="value">${doneToday}</span></div>
          <div class="stat"><span class="label">Streak / Pomodoros</span><span class="value">${C.streak(state.log, now)}d / ${pomoToday}</span></div>
        </div>
        <p>${plan}</p>
        <div class="row">
          <button class="primary" data-nav="study" ${dueNow ? '' : 'disabled'}>${dueNow ? 'Start studying (all topics mixed)' : 'Nothing due right now 🎉'}</button>
          <button data-nav="practice">Take a practice test</button>
        </div>
      </section>
      <section class="panel">
        <h2>Topics</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Deck</th><th class="num">Cards</th><th class="num">Unseen</th><th class="num">Due</th><th>Learned</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </section>`;
  }

  // ---------- study session ----------

  function renderStudy() {
    const ses = ui.session;
    const now = Date.now();
    const o = opts();
    const q = queue(ses.deckId, now);
    let card = ses.currentId && state.cards.find((c) => c.id === ses.currentId);
    if (!card) {
      card = C.nextCard(q);
      ses.currentId = card ? card.id : null;
      ses.revealed = false;
      ses.attempt = '';
      ses.shownAt = now;
    }

    const title = ses.deckId ? esc(deckName(ses.deckId)) : 'All topics (interleaved)';
    const undoBtn = ses.undo ? '<button class="ghost" data-action="undo" title="Undo last answer (U)">↶ Undo</button>' : '';
    const header = `<div class="row spread" style="margin-bottom:.75em">
      <div><strong>${title}</strong> <span class="muted small">· ${plural(ses.done, 'card')} done</span></div>
      <div class="row">${undoBtn}
        <span class="counts" title="Learning · Review · New">
          <span class="c-learn">${q.learningDue.length}</span><span class="c-review">${q.reviewCount}</span><span class="c-new">${q.newCount}</span>
        </span>
      </div>
    </div>`;

    if (!card) {
      clearTimeout(ui.refreshTimer);
      let more = '';
      if (q.learningLater.length) {
        const wait = q.learningLater[0].due - now;
        more = `<p>${plural(q.learningLater.length, 'card')} still in learning — the next one comes back in ${C.formatDuration(wait)}.
          Take a short break; this page will continue automatically.</p>`;
        if (wait < C.HOUR) {
          ui.refreshTimer = setTimeout(() => { if (ui.view === 'study') render(); }, wait + 500);
        }
      }
      const unseen = state.cards.filter((c) => c.state === 'new' && (!ses.deckId || c.deckId === ses.deckId)).length;
      const extra = unseen ? `<p><button data-action="more-new">Learn ${Math.min(10, unseen)} more new cards</button></p>` : '';
      return `${header}<section class="panel empty">
        <h2>All done for now!</h2>
        ${more}${extra}
        <p class="muted">Spacing works because you come back later. Tomorrow's reviews will be ready tomorrow.</p>
        <div class="row" style="justify-content:center">
          <button data-nav="dashboard">Back to today</button>
          <button data-nav="practice">Practice test</button>
        </div>
      </section>`;
    }

    const typeAnswer = !!state.settings.typeAnswer;
    let body;
    if (!ses.revealed) {
      body = `${typeAnswer ? `<textarea id="attempt" data-autofocus placeholder="Recall the answer and write it down before revealing… (Enter to reveal, Shift+Enter for a new line)">${esc(ses.attempt)}</textarea>` : '<p class="muted">Say or think the answer before revealing it.</p>'}
        <div class="row" style="margin-top:.75em">
          <button class="primary" data-action="reveal" ${typeAnswer ? '' : 'data-autofocus'}>Show answer <kbd>${typeAnswer ? 'Enter' : 'Space'}</kbd></button>
        </div>`;
    } else {
      const grades = [1, 2, 3, 4].map((g) => `<button class="grade g${g}" data-action="grade" data-grade="${g}">
          <span>${C.GRADE_LABELS[g]}</span><small>${C.previewLabel(card, g, now, o)}</small><kbd>${g}</kbd></button>`).join('');
      body = `${ses.attempt.trim() ? `<div class="answer-block attempt"><h4>Your answer</h4><div class="pre">${esc(ses.attempt)}</div></div>` : ''}
        <div class="answer-block"><h4>Correct answer</h4><div class="pre">${esc(card.back)}</div></div>
        <p class="muted small" style="margin-top:1em">Be honest: how well did you recall it? <kbd>Space</kbd> = Good</p>
        <div class="grades">${grades}</div>`;
    }

    return `${header}<section class="panel study-card">
      <div class="row spread small muted"><span>${esc(deckName(card.deckId))}</span><span class="badge ${card.state}">${card.state}</span></div>
      <div class="front pre">${esc(card.front)}</div>
      ${body}
    </section>`;
  }

  function reveal() {
    const ses = ui.session;
    const ta = $('#attempt');
    if (ta) ses.attempt = ta.value;
    ses.revealed = true;
    render();
  }

  function grade(g) {
    const ses = ui.session;
    const card = state.cards.find((c) => c.id === ses.currentId);
    if (!card || !ses.revealed) return;
    const now = Date.now();
    const updated = C.review(card, g, now, opts());
    const idx = state.cards.indexOf(card);
    state.cards[idx] = updated;
    state.log.push({
      cardId: card.id,
      deckId: card.deckId,
      ts: now,
      grade: g,
      prevState: card.state,
      ms: Math.min(MAX_CARD_MS, now - ses.shownAt),
    });
    ses.undo = { card, logLength: state.log.length - 1 };
    ses.done++;
    ses.currentId = null;
    save();
    render();
  }

  function undo() {
    const ses = ui.session;
    if (!ses || !ses.undo) return;
    const { card, logLength } = ses.undo;
    const idx = state.cards.findIndex((c) => c.id === card.id);
    if (idx >= 0) state.cards[idx] = card;
    state.log.length = logLength;
    ses.undo = null;
    ses.done = Math.max(0, ses.done - 1);
    ses.currentId = card.id;
    ses.revealed = false;
    ses.attempt = '';
    ses.shownAt = Date.now();
    save();
    render();
  }

  // ---------- practice test ----------

  function deckOptions(selected) {
    return `<option value="">All topics</option>${state.decks.map((d) => (
      `<option value="${d.id}" ${d.id === selected ? 'selected' : ''}>${esc(d.name)}</option>`
    )).join('')}`;
  }

  function renderPractice() {
    const p = ui.practice;
    if (!state.cards.length) {
      return '<section class="panel empty"><h2>No cards yet</h2><p>Add some cards first.</p><button class="primary" data-nav="decks">Go to decks</button></section>';
    }

    if (p.stage === 'setup') {
      return `<section class="panel">
        <h1>Practice test</h1>
        <p class="muted">Testing yourself is one of the most effective ways to study. Questions are drawn at random,
        exam-style. This does <em>not</em> change your review schedule, but you can send missed cards back into today's reviews.</p>
        <form data-form="practice-start">
          <label for="p-deck">Topics</label>
          <select id="p-deck" name="deckId">${deckOptions(p.deckId)}</select>
          <label for="p-count">Number of questions</label>
          <input id="p-count" type="number" name="count" min="1" max="200" value="20">
          <label class="inline"><input type="checkbox" name="seenOnly"> Only cards I've already studied</label>
          <div class="row" style="margin-top:1em"><button class="primary" type="submit">Start test</button></div>
        </form>
      </section>`;
    }

    if (p.stage === 'run') {
      const item = p.items[p.index];
      const card = state.cards.find((c) => c.id === item.id);
      if (!card) { advancePractice(null); return renderPractice(); }
      const progress = `<div class="row spread small muted" style="margin-bottom:.5em">
        <span>Question ${p.index + 1} of ${p.items.length}</span><span>${p.items.filter((i) => i.correct).length} correct so far</span></div>`;
      let body;
      if (!p.revealed) {
        body = `<textarea id="attempt" data-autofocus placeholder="Write your answer… (Enter to check)">${esc(p.attempt)}</textarea>
          <div class="row" style="margin-top:.75em"><button class="primary" data-action="practice-reveal">Check answer <kbd>Enter</kbd></button></div>`;
      } else {
        body = `${p.attempt.trim() ? `<div class="answer-block attempt"><h4>Your answer</h4><div class="pre">${esc(p.attempt)}</div></div>` : ''}
          <div class="answer-block"><h4>Correct answer</h4><div class="pre">${esc(card.back)}</div></div>
          <div class="row" style="margin-top:1em">
            <button class="grade g1" data-action="practice-mark" data-correct="0">✗ I got it wrong <kbd>1</kbd></button>
            <button class="grade g3" data-action="practice-mark" data-correct="1">✓ I got it right <kbd>2</kbd></button>
          </div>`;
      }
      return `<section class="panel study-card">${progress}
        <div class="small muted">${esc(deckName(card.deckId))}</div>
        <div class="front pre">${esc(card.front)}</div>${body}</section>`;
    }

    // results
    const answered = p.items.filter((i) => i.correct !== null);
    const right = answered.filter((i) => i.correct).length;
    const missed = answered.filter((i) => !i.correct).map((i) => state.cards.find((c) => c.id === i.id)).filter(Boolean);
    const pct = answered.length ? Math.round((right / answered.length) * 100) : 0;
    const missedRows = missed.map((c) => `<tr><td class="pre">${esc(c.front)}</td><td class="pre">${esc(c.back)}</td></tr>`).join('');
    return `<section class="panel">
      <h1>Score: ${right} / ${answered.length} (${pct}%)</h1>
      ${missed.length ? `<p>Review these — understanding <em>why</em> you missed them is where the learning happens.</p>
        <div class="table-wrap"><table><thead><tr><th>Question</th><th>Answer</th></tr></thead><tbody>${missedRows}</tbody></table></div>
        <div class="row" style="margin-top:1em">
          ${p.requeued ? '<span class="muted">Missed cards added to today\'s reviews.</span>' : '<button class="primary" data-action="practice-requeue">Add missed cards to today\'s reviews</button>'}
        </div>` : '<p>Perfect score! 🎉</p>'}
      <div class="row" style="margin-top:1em">
        <button data-action="practice-again">New test</button>
        <button data-nav="dashboard">Back to today</button>
      </div>
    </section>`;
  }

  function startPractice(form) {
    const fd = new FormData(form);
    const deckId = fd.get('deckId') || '';
    const count = Math.max(1, toInt(fd.get('count'), 20));
    let pool = state.cards.filter((c) => !deckId || c.deckId === deckId);
    if (fd.get('seenOnly')) pool = pool.filter((c) => c.state !== 'new');
    if (!pool.length) { toast('No cards match those options.'); return; }
    ui.practice = {
      stage: 'run',
      deckId,
      items: shuffle(pool).slice(0, count).map((c) => ({ id: c.id, correct: null })),
      index: 0,
      revealed: false,
      attempt: '',
      requeued: false,
    };
    render();
  }

  function advancePractice(correct) {
    const p = ui.practice;
    p.items[p.index].correct = correct;
    p.index++;
    p.revealed = false;
    p.attempt = '';
    if (p.index >= p.items.length) p.stage = 'done';
    render();
  }

  function requeueMissed() {
    const p = ui.practice;
    const today = C.startOfDay(Date.now());
    const ids = new Set(p.items.filter((i) => i.correct === false).map((i) => i.id));
    for (const c of state.cards) {
      if (ids.has(c.id) && c.state === 'review' && c.due > today) c.due = today;
    }
    p.requeued = true;
    save();
    render();
  }

  // ---------- decks ----------

  function renderDecks() {
    const now = Date.now();
    const list = state.decks.map((d) => {
      const cards = state.cards.filter((c) => c.deckId === d.id);
      return `<tr>
        <td><a href="#" data-action="open-deck" data-id="${d.id}">${esc(d.name)}</a></td>
        <td class="num">${cards.length}</td>
        <td class="num">${cards.filter((c) => c.state === 'review' && c.due <= C.endOfDay(now)).length}</td>
        <td class="num"><div class="row" style="justify-content:flex-end">
          <button data-action="open-deck" data-id="${d.id}">Edit cards</button>
          <button data-action="study-deck" data-id="${d.id}">Study</button>
        </div></td>
      </tr>`;
    }).join('');

    return `<section class="panel">
        <h1>Decks</h1>
        <p class="muted">Make one deck per exam topic or chapter. In a normal study session cards from all decks are mixed together (interleaving).</p>
        ${state.decks.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Deck</th><th class="num">Cards</th><th class="num">Reviews due</th><th></th></tr></thead>
          <tbody>${list}</tbody></table></div>` : '<p>No decks yet.</p>'}
      </section>
      <section class="panel">
        <h2>New deck</h2>
        <form data-form="add-deck" class="row">
          <input type="text" name="name" placeholder="e.g. Chapter 3 — Cell biology" required style="flex:1;min-width:200px" ${state.decks.length ? '' : 'data-autofocus'}>
          <button class="primary" type="submit">Create</button>
        </form>
        <p class="small muted" style="margin-top:.75em">Or <a href="#" data-action="load-example">load an example deck</a> to try things out.</p>
      </section>`;
  }

  function renderDeck() {
    const d = deck(ui.deckId);
    const now = Date.now();
    const cards = state.cards.filter((c) => c.deckId === d.id).sort((a, b) => a.createdAt - b.createdAt);
    const rows = cards.map((c) => {
      if (c.id === ui.editingCardId) {
        return `<tr><td colspan="4"><form data-form="edit-card" data-id="${c.id}">
          <label>Question</label><textarea name="front" required data-autofocus>${esc(c.front)}</textarea>
          <label>Answer</label><textarea name="back" required>${esc(c.back)}</textarea>
          <div class="row" style="margin-top:.5em">
            <button class="primary" type="submit">Save</button>
            <button type="button" data-action="cancel-edit">Cancel</button>
            <button type="button" data-action="reset-card" data-id="${c.id}" title="Forget progress and treat as new">Reset progress</button>
          </div></form></td></tr>`;
      }
      return `<tr data-search="${esc((`${c.front} ${c.back}`).toLowerCase())}">
        <td class="pre">${esc(c.front)}</td>
        <td class="pre muted">${esc(c.back)}</td>
        <td><span class="badge ${c.state}">${c.state}</span><div class="small muted">${dueLabel(c, now)}${c.lapses ? ` · forgot ${c.lapses}×` : ''}</div></td>
        <td class="num"><button class="ghost" data-action="edit-card" data-id="${c.id}" title="Edit">✎</button><button class="ghost danger" data-action="delete-card" data-id="${c.id}" title="Delete">🗑</button></td>
      </tr>`;
    }).join('');

    return `<section class="panel">
        <div class="row spread">
          <h1>${esc(d.name)}</h1>
          <div class="row">
            <button class="primary" data-action="study-deck" data-id="${d.id}">Study this deck</button>
            <button data-action="practice-deck" data-id="${d.id}">Practice test</button>
          </div>
        </div>
        <p class="small"><a href="#" data-nav="decks">← All decks</a></p>
      </section>
      <section class="panel">
        <h2>Add a card</h2>
        <p class="small muted">Tips: one idea per card, phrase it as a question, write the answer in your own words. "Why" and "how" questions beat bare definitions.</p>
        <form data-form="add-card">
          <label for="front">Question</label>
          <textarea id="front" name="front" required data-autofocus placeholder="e.g. Why does the heart have a separate pulmonary circuit?"></textarea>
          <label for="back">Answer</label>
          <textarea id="back" name="back" required></textarea>
          <div class="row" style="margin-top:.75em"><button class="primary" type="submit">Add card</button><span class="small muted">Ctrl+Enter to add</span></div>
        </form>
        <details style="margin-top:1em">
          <summary>Bulk import</summary>
          <form data-form="bulk-import">
            <p class="small muted">One card per line: <code>question :: answer</code> or question and answer separated by a Tab (paste straight from a spreadsheet).</p>
            <textarea name="text" rows="8" placeholder="Capital of France :: Paris&#10;Powerhouse of the cell :: Mitochondria"></textarea>
            <div class="row" style="margin-top:.5em"><button type="submit">Import</button></div>
          </form>
        </details>
      </section>
      <section class="panel">
        <div class="row spread"><h2>${plural(cards.length, 'card')}</h2>
          <input type="search" id="card-search" placeholder="Search cards…" style="max-width:240px"></div>
        ${cards.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Question</th><th>Answer</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table></div>` : '<p class="muted">No cards yet.</p>'}
      </section>
      <section class="panel">
        <h2>Deck settings</h2>
        <form data-form="rename-deck" class="row">
          <input type="text" name="name" value="${esc(d.name)}" required style="flex:1;min-width:200px">
          <button type="submit">Rename</button>
          <button type="button" class="danger" data-action="delete-deck" data-id="${d.id}">Delete deck</button>
        </form>
      </section>`;
  }

  function parseBulk(text) {
    const cards = [];
    let skipped = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let i = line.indexOf('\t');
      let sepLen = 1;
      if (i < 0) { i = line.indexOf('::'); sepLen = 2; }
      const front = i < 0 ? '' : line.slice(0, i).trim();
      const back = i < 0 ? '' : line.slice(i + sepLen).trim();
      if (front && back) cards.push([front, back]);
      else skipped++;
    }
    return { cards, skipped };
  }

  const EXAMPLE_CARDS = [
    ['What is active recall?', 'Retrieving information from memory (answering a question) instead of re-reading it. The effort of retrieval strengthens the memory.'],
    ['What is spaced repetition?', 'Reviewing material at increasing intervals, just before you would forget it, instead of cramming it all at once.'],
    ['Why is re-reading notes a weak study method?', 'It creates an illusion of familiarity ("fluency") without testing whether you can actually produce the answer.'],
    ['What is interleaving?', 'Mixing different topics or problem types in one session, which trains you to choose the right approach — like in a real exam.'],
    ['What is the Pomodoro technique?', '25 minutes of focused work followed by a 5 minute break; a longer break after four rounds.'],
    ['What is the Feynman technique?', 'Explain a concept in simple words as if teaching a beginner; the gaps in your explanation show what you have not understood yet.'],
    ['Why is sleep important for exam preparation?', 'Memories are consolidated during sleep; sleeping after studying improves retention, and all-nighters hurt recall.'],
    ['What is the "testing effect"?', 'Taking practice tests improves long-term retention more than spending the same time restudying.'],
  ];

  function loadExample() {
    const now = Date.now();
    const d = { id: C.makeId(), name: 'Example: How to study', createdAt: now };
    state.decks.push(d);
    EXAMPLE_CARDS.forEach(([f, b], i) => state.cards.push(C.createCard(d.id, f, b, now + i)));
    save();
    navigate('deck', d.id);
    toast('Example deck added. Press "Study this deck" to try it.');
  }

  // ---------- stats ----------

  function bars(data, label) {
    const max = Math.max(1, ...data.map((d) => d.count));
    return `<div class="bars">${data.map((d) => `
      <div class="bar" title="${label(d.ts)}: ${d.count}">
        <span class="n">${d.count || ''}</span>
        <div class="fill" style="height:${(d.count / max) * 100}%"></div>
        <span class="d">${label(d.ts)}</span>
      </div>`).join('')}</div>`;
  }

  function renderStats() {
    const now = Date.now();
    const log = state.log;
    const ret = C.retention(log, now - 30 * C.DAY);
    const totalMs = log.reduce((s, e) => s + (e.ms || 0), 0);
    const counts = { new: 0, learning: 0, review: 0, mature: 0 };
    for (const c of state.cards) {
      if (c.state === 'new') counts.new++;
      else if (c.state === 'review') counts[c.interval >= 21 ? 'mature' : 'review']++;
      else counts.learning++;
    }
    const dayLabel = (ts) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'numeric' });
    const hardest = state.cards.filter((c) => c.lapses > 0).sort((a, b) => b.lapses - a.lapses || a.ease - b.ease).slice(0, 10);

    return `<section class="panel">
        <h1>Statistics</h1>
        <div class="grid">
          <div class="stat"><span class="label">Study streak</span><span class="value">${plural(C.streak(log, now), 'day')}</span></div>
          <div class="stat"><span class="label">Total reviews</span><span class="value">${log.length}</span></div>
          <div class="stat"><span class="label">Recall rate (30 days)</span><span class="value">${ret == null ? '—' : `${Math.round(ret * 100)}%`}</span></div>
          <div class="stat"><span class="label">Time on cards</span><span class="value">${Math.round(totalMs / C.HOUR * 10) / 10}h</span></div>
        </div>
        <p class="small muted" style="margin-top:1em">A recall rate around 85–90% is ideal. Much higher means you could space reviews further; much lower means cards may be too hard or too big — split them up.</p>
      </section>
      <section class="panel">
        <h2>Cards</h2>
        <div class="grid">
          <div class="stat"><span class="label c-new">Unseen</span><span class="value">${counts.new}</span></div>
          <div class="stat"><span class="label c-learn">Learning</span><span class="value">${counts.learning}</span></div>
          <div class="stat"><span class="label c-review">Young (&lt;21 days)</span><span class="value">${counts.review}</span></div>
          <div class="stat"><span class="label">Mature (21+ days)</span><span class="value">${counts.mature}</span></div>
        </div>
      </section>
      <section class="panel"><h2>Reviews — last 14 days</h2>${bars(C.reviewsPerDay(log, now, 14), dayLabel)}</section>
      <section class="panel"><h2>Upcoming reviews — next 14 days</h2>${bars(C.forecast(state.cards, now, 14), dayLabel)}</section>
      <section class="panel">
        <h2>Most forgotten cards</h2>
        ${hardest.length ? `<p class="small muted">These are your weak spots. Consider rewriting them, splitting them up, or adding a memory hook.</p>
          <div class="table-wrap"><table><thead><tr><th>Question</th><th>Deck</th><th class="num">Forgotten</th><th></th></tr></thead><tbody>
          ${hardest.map((c) => `<tr><td class="pre">${esc(c.front)}</td><td>${esc(deckName(c.deckId))}</td><td class="num">${c.lapses}×</td>
            <td class="num"><button class="ghost" data-action="goto-card" data-deck="${c.deckId}" data-id="${c.id}">Edit</button></td></tr>`).join('')}
          </tbody></table></div>` : '<p class="muted">Nothing yet — cards you forget after learning them show up here.</p>'}
      </section>`;
  }

  // ---------- settings ----------

  function renderSettings() {
    const s = state.settings;
    return `<section class="panel">
        <h1>Settings</h1>
        <form data-form="settings">
          <h2>Exam</h2>
          <label for="s-name">Exam name</label>
          <input id="s-name" type="text" name="examName" value="${esc(s.examName)}" placeholder="e.g. Biology final">
          <label for="s-date">Exam date</label>
          <input id="s-date" type="date" name="examDate" value="${esc(s.examDate)}">
          <label for="s-buffer">Review-only days before the exam</label>
          <input id="s-buffer" type="number" name="examBufferDays" min="0" max="30" value="${esc(s.examBufferDays)}">
          <p class="small muted">No new cards are introduced in these final days, so they're free for review and practice tests.</p>
          <label for="s-new">New cards per day (used when no exam date is set)</label>
          <input id="s-new" type="number" name="newPerDay" min="0" max="500" value="${esc(s.newPerDay)}">

          <h2 style="margin-top:1.2em">Studying</h2>
          <label class="inline"><input type="checkbox" name="typeAnswer" ${s.typeAnswer ? 'checked' : ''}> Type my answer before revealing (recommended — makes recall active)</label>

          <h2 style="margin-top:1.2em">Pomodoro (minutes)</h2>
          <div class="grid">
            <div><label for="s-pw">Focus</label><input id="s-pw" type="number" name="pomodoroWork" min="1" max="120" value="${esc(s.pomodoroWork)}"></div>
            <div><label for="s-pb">Short break</label><input id="s-pb" type="number" name="pomodoroBreak" min="1" max="60" value="${esc(s.pomodoroBreak)}"></div>
            <div><label for="s-pl">Long break</label><input id="s-pl" type="number" name="pomodoroLongBreak" min="1" max="60" value="${esc(s.pomodoroLongBreak)}"></div>
          </div>
          <div class="row" style="margin-top:1em"><button class="primary" type="submit">Save settings</button></div>
        </form>
      </section>
      <section class="panel">
        <h2>Your data</h2>
        <p class="small muted">Everything is stored in this browser only. Export a backup regularly, and use it to move to another device or browser.</p>
        <div class="row">
          <button data-action="export">Export backup</button>
          <button type="button" data-action="import">Import backup</button>
          <input type="file" id="import-file" accept="application/json,.json" hidden>
          <button class="danger" data-action="reset-all">Delete all data</button>
        </div>
      </section>`;
  }

  function saveSettings(form) {
    const fd = new FormData(form);
    const s = state.settings;
    s.examName = String(fd.get('examName') || '').trim();
    s.examDate = String(fd.get('examDate') || '');
    s.examBufferDays = toInt(fd.get('examBufferDays'), 2);
    s.newPerDay = toInt(fd.get('newPerDay'), 20);
    s.typeAnswer = !!fd.get('typeAnswer');
    s.pomodoroWork = Math.max(1, toInt(fd.get('pomodoroWork'), 25));
    s.pomodoroBreak = Math.max(1, toInt(fd.get('pomodoroBreak'), 5));
    s.pomodoroLongBreak = Math.max(1, toInt(fd.get('pomodoroLongBreak'), 15));
    save();
    if (!pomo.running) { pomo.remaining = pomoLength(pomo.mode); updatePomo(); }
    toast('Settings saved.');
    render();
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `study-backup-${C.dayKey(Date.now())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = normalize(JSON.parse(reader.result));
        if (!confirm(`Replace all current data with this backup (${plural(data.cards.length, 'card')})?`)) return;
        state = data;
        save();
        toast('Backup imported.');
        navigate('dashboard');
      } catch (err) {
        alert(`Import failed: ${err.message}`);
      }
    };
    reader.readAsText(file);
  }

  // ---------- guide ----------

  function renderGuide() {
    return `<section class="panel guide">
      <h1>How this app helps you study</h1>
      <p>Each feature is based on a learning technique with strong research behind it.</p>

      <h2>1. Active recall</h2>
      <p>You see only the question and have to <strong>produce</strong> the answer, ideally by typing it, before revealing it.
      Retrieving information strengthens memory far more than re-reading or highlighting does.</p>

      <h2>2. Spaced repetition</h2>
      <p>After you reveal the answer, rate how well you remembered it:</p>
      <ul>
        <li><strong>Again</strong> — you didn't remember it. You'll see it again in a few minutes.</li>
        <li><strong>Hard</strong> — you remembered it, but with real effort.</li>
        <li><strong>Good</strong> — you remembered it after a moment's thought.</li>
        <li><strong>Easy</strong> — you knew it instantly.</li>
      </ul>
      <p>Cards you know well come back after longer and longer gaps (1 day, 3 days, a week…). Cards you struggle with come back sooner.
      The scheduler is based on SM-2, the algorithm behind SuperMemo and Anki.</p>

      <h2>3. Planned around your exam</h2>
      <p>Once you set an exam date, no review is ever scheduled after it. Your unseen cards are spread over the days you have left,
      so you cover everything in time and still have a few review-only days at the end.</p>

      <h2>4. Interleaving</h2>
      <p>Normal study sessions mix cards from all your topics. It feels harder than doing one chapter at a time, but you learn more,
      and it's closer to what a real exam is like.</p>

      <h2>5. Practice tests</h2>
      <p>Take exam-style tests on random questions to check where you stand. Cards you get wrong can go straight back into today's reviews.</p>

      <h2>6. Pomodoro</h2>
      <p>Use the timer at the top: 25 minutes of focus, then a 5-minute break, and a longer break after four rounds. Breaks keep you fresh,
      and the timer makes it easier to get started.</p>

      <h2>Tips for good cards</h2>
      <ul>
        <li>Put one idea on each card. Split up long answers.</li>
        <li>Write cards in your own words, and only once you understand the material (try the Feynman technique: explain it simply).</li>
        <li>Ask "why" and "how", not only "what is".</li>
        <li>Grade yourself honestly. Pressing Good on a card you got wrong only fools the scheduler.</li>
        <li>Study a little every day. Doing your reviews daily matters more than long sessions.</li>
        <li>Sleep well, especially in the last days before the exam.</li>
      </ul>

      <h2>Keyboard shortcuts</h2>
      <ul>
        <li><kbd>Enter</kbd> in the answer box, or <kbd>Space</kbd>: show the answer</li>
        <li><kbd>1</kbd>–<kbd>4</kbd>: Again / Hard / Good / Easy. <kbd>Space</kbd>: Good</li>
        <li><kbd>U</kbd>: undo your last answer</li>
        <li><kbd>Ctrl</kbd>+<kbd>Enter</kbd>: add a card while editing a deck</li>
      </ul>
    </section>`;
  }

  // ---------- pomodoro ----------

  const pomo = { mode: 'work', running: false, endsAt: 0, remaining: 0, cycle: 0 };

  function pomoLength(mode) {
    const s = state.settings;
    const min = mode === 'work' ? s.pomodoroWork : mode === 'long' ? s.pomodoroLongBreak : s.pomodoroBreak;
    return Math.max(1, toInt(min, 25)) * C.MINUTE;
  }

  function pomoLeft() {
    return pomo.running ? Math.max(0, pomo.endsAt - Date.now()) : pomo.remaining;
  }

  function fmtClock(ms) {
    const total = Math.ceil(ms / 1000);
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }

  function updatePomo() {
    const left = pomoLeft();
    const label = pomo.mode === 'work' ? 'Focus' : pomo.mode === 'long' ? 'Long break' : 'Break';
    $('#pomo-time').textContent = fmtClock(left);
    $('#pomo-mode').textContent = label;
    $('#pomo-toggle').textContent = pomo.running ? 'Pause' : 'Start';
    $('#pomo').classList.toggle('running', pomo.running);
    $('#pomo').classList.toggle('break', pomo.mode !== 'work');
    document.title = pomo.running ? `${fmtClock(left)} · ${label}` : 'Exam Study Manager';
  }

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.35, 0.7].forEach((t) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.2, ctx.currentTime + t);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.3);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + t);
        osc.stop(ctx.currentTime + t + 0.3);
      });
    } catch (_) { /* audio unavailable */ }
  }

  function nextPhase(completed) {
    if (pomo.mode === 'work') {
      if (completed) {
        const today = C.dayKey(Date.now());
        if (state.pomodoro.day !== today) state.pomodoro = { day: today, completed: 0 };
        state.pomodoro.completed++;
        save();
      }
      pomo.cycle++;
      pomo.mode = pomo.cycle % 4 === 0 ? 'long' : 'break';
    } else {
      pomo.mode = 'work';
    }
    pomo.running = false;
    pomo.remaining = pomoLength(pomo.mode);
    updatePomo();
    if (ui.view === 'dashboard') render();
  }

  function pomoTick() {
    if (pomo.running && Date.now() >= pomo.endsAt) {
      const wasWork = pomo.mode === 'work';
      beep();
      nextPhase(true);
      toast(wasWork ? 'Focus session done — take a break! Stand up, stretch, look away from the screen.' : 'Break over — ready for another focus session?');
    }
    updatePomo();
  }

  function pomoToggle() {
    if (pomo.running) {
      pomo.remaining = pomoLeft();
      pomo.running = false;
    } else {
      pomo.endsAt = Date.now() + pomo.remaining;
      pomo.running = true;
    }
    updatePomo();
  }

  // ---------- events ----------

  document.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      e.preventDefault();
      if (!nav.disabled) navigate(nav.dataset.nav);
      return;
    }
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, id } = el.dataset;
    switch (action) {
      case 'reveal': reveal(); break;
      case 'grade': grade(Number(el.dataset.grade)); break;
      case 'undo': undo(); break;
      case 'more-new': {
        const today = C.dayKey(Date.now());
        if (state.extraNew.day !== today) state.extraNew = { day: today, count: 0 };
        state.extraNew.count += 10;
        save();
        render();
        break;
      }
      case 'open-deck': e.preventDefault(); navigate('deck', id); break;
      case 'study-deck': navigate('study', id); break;
      case 'practice-deck': navigate('practice', id); break;
      case 'load-example': e.preventDefault(); loadExample(); break;
      case 'edit-card': ui.editingCardId = id; render(); break;
      case 'cancel-edit': ui.editingCardId = null; render(); break;
      case 'goto-card': ui.view = 'deck'; ui.deckId = el.dataset.deck; ui.editingCardId = id; render(); break;
      case 'delete-card':
        if (confirm('Delete this card?')) {
          state.cards = state.cards.filter((c) => c.id !== id);
          save();
          render();
        }
        break;
      case 'reset-card': {
        const i = state.cards.findIndex((c) => c.id === id);
        if (i >= 0 && confirm('Reset this card to new? Its review history is kept in your stats.')) {
          const c = state.cards[i];
          state.cards[i] = { ...C.createCard(c.deckId, c.front, c.back, c.createdAt), id: c.id };
          ui.editingCardId = null;
          save();
          render();
        }
        break;
      }
      case 'delete-deck': {
        const n = state.cards.filter((c) => c.deckId === id).length;
        if (confirm(`Delete deck "${deckName(id)}" and its ${plural(n, 'card')}? This cannot be undone.`)) {
          state.decks = state.decks.filter((d) => d.id !== id);
          state.cards = state.cards.filter((c) => c.deckId !== id);
          save();
          navigate('decks');
        }
        break;
      }
      case 'practice-reveal': {
        const ta = $('#attempt');
        if (ta) ui.practice.attempt = ta.value;
        ui.practice.revealed = true;
        render();
        break;
      }
      case 'practice-mark': advancePractice(el.dataset.correct === '1'); break;
      case 'practice-requeue': requeueMissed(); break;
      case 'practice-again': ui.practice = { stage: 'setup', deckId: ui.practice.deckId }; render(); break;
      case 'export': exportData(); break;
      case 'import': $('#import-file').click(); break;
      case 'reset-all':
        if (prompt('This deletes ALL decks, cards and history. Type DELETE to confirm.') === 'DELETE') {
          state = emptyState();
          save();
          navigate('dashboard');
        }
        break;
      case 'pomo-toggle': pomoToggle(); break;
      case 'pomo-reset': pomo.running = false; pomo.remaining = pomoLength(pomo.mode); updatePomo(); break;
      case 'pomo-skip': nextPhase(false); break;
      default: break;
    }
  });

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    const fd = new FormData(form);
    switch (form.dataset.form) {
      case 'add-deck': {
        const name = String(fd.get('name') || '').trim();
        if (!name) return;
        const d = { id: C.makeId(), name, createdAt: Date.now() };
        state.decks.push(d);
        save();
        navigate('deck', d.id);
        break;
      }
      case 'rename-deck': {
        const name = String(fd.get('name') || '').trim();
        if (!name) return;
        deck(ui.deckId).name = name;
        save();
        toast('Deck renamed.');
        render();
        break;
      }
      case 'add-card': {
        const front = String(fd.get('front') || '').trim();
        const back = String(fd.get('back') || '').trim();
        if (!front || !back) return;
        state.cards.push(C.createCard(ui.deckId, front, back, Date.now()));
        save();
        toast('Card added.');
        render();
        break;
      }
      case 'edit-card': {
        const card = state.cards.find((c) => c.id === form.dataset.id);
        const front = String(fd.get('front') || '').trim();
        const back = String(fd.get('back') || '').trim();
        if (card && front && back) {
          card.front = front;
          card.back = back;
          save();
        }
        ui.editingCardId = null;
        render();
        break;
      }
      case 'bulk-import': {
        const { cards, skipped } = parseBulk(String(fd.get('text') || ''));
        const now = Date.now();
        cards.forEach(([f, b], i) => state.cards.push(C.createCard(ui.deckId, f, b, now + i)));
        save();
        toast(`Imported ${plural(cards.length, 'card')}${skipped ? `, skipped ${skipped} line(s) without a separator` : ''}.`);
        render();
        break;
      }
      case 'practice-start': startPractice(form); break;
      case 'settings': saveSettings(form); break;
      default: break;
    }
  });

  document.addEventListener('change', (e) => {
    if (e.target.id === 'import-file' && e.target.files[0]) {
      importData(e.target.files[0]);
      e.target.value = '';
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.id !== 'card-search') return;
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('tr[data-search]').forEach((tr) => {
      tr.hidden = q && !tr.dataset.search.includes(q);
    });
  });

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT';

    // Ctrl/Cmd+Enter submits the form being edited (e.g. add card).
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && t.form && t.form.dataset.form) {
      e.preventDefault();
      t.form.requestSubmit();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (ui.view === 'study' && ui.session && !typing && (e.key === 'u' || e.key === 'U') && ui.session.undo) {
      e.preventDefault();
      undo();
      return;
    }

    if (ui.view === 'study' && ui.session && ui.session.currentId) {
      const ses = ui.session;
      if (!ses.revealed) {
        if ((t.id === 'attempt' && e.key === 'Enter' && !e.shiftKey) || (!typing && e.key === ' ')) {
          e.preventDefault();
          reveal();
        }
      } else if (!typing) {
        if (['1', '2', '3', '4'].includes(e.key)) { e.preventDefault(); grade(Number(e.key)); }
        else if (e.key === ' ') { e.preventDefault(); grade(C.GOOD); }
      }
      return;
    }

    if (ui.view === 'practice' && ui.practice && ui.practice.stage === 'run') {
      const p = ui.practice;
      if (!p.revealed && t.id === 'attempt' && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        p.attempt = t.value;
        p.revealed = true;
        render();
      } else if (p.revealed && !typing && (e.key === '1' || e.key === '2')) {
        e.preventDefault();
        advancePractice(e.key === '2');
      }
    }
  });

  // Pick up changes made in another tab.
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY && e.newValue) {
      try {
        state = normalize(JSON.parse(e.newValue));
        if (ui.view !== 'study' && ui.view !== 'practice') render();
      } catch (_) { /* ignore */ }
    }
  });

  // ---------- start ----------

  pomo.remaining = pomoLength('work');
  updatePomo();
  setInterval(pomoTick, 1000);
  render();
})();
