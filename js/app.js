/* 시험 공부 매니저 (Exam Study Manager) — UI, persistence and Pomodoro timer. Scheduling lives in core.js. */
(function () {
  'use strict';

  const C = window.StudyCore;
  const PRESETS = window.StudyPresets || [];
  const P = window.StudyPlanner;
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
      plan: null,
    };
  }

  function normalize(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.cards)) {
      throw new Error('시험 공부 매니저 백업 파일이 아닙니다.');
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
      plan: data.plan && Array.isArray(data.plan.materials) ? { log: {}, ranges: {}, checks: {}, capacity: 100, ...data.plan } : null,
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
      toast('저장하지 못했습니다. 브라우저 저장 공간이 가득 찼을 수 있습니다. 설정에서 백업을 내보내 주세요.');
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

  const STATE_LABELS = { new: '새 카드', learning: '학습 중', relearning: '재학습', review: '복습' };

  function stateLabel(state) {
    return STATE_LABELS[state] || state;
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
    return d ? d.name : '(삭제된 덱)';
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
    return new Date(ts).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });
  }

  function dueLabel(card, now) {
    if (card.state === 'new') return '아직 안 봄';
    if (card.state !== 'review') return card.due <= now ? '지금' : `${C.formatDuration(card.due - now)} 후`;
    const d = C.daysBetween(now, card.due);
    if (d <= 0) return '오늘';
    if (d === 1) return '내일';
    return `${d}일 후`;
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
  }

  // In-page dialogs: confirm()/prompt()/alert() are blocked when the app runs embedded (e.g. as a Claude artifact).
  let pendingConfirm = null;

  function showModal(html) {
    const m = $('#modal');
    m.innerHTML = `<div class="modal-box" role="dialog" aria-modal="true">${html}</div>`;
    m.hidden = false;
    const f = m.querySelector('[data-autofocus]');
    if (f) f.focus();
  }

  function closeModal() {
    const m = $('#modal');
    m.hidden = true;
    m.innerHTML = '';
    pendingConfirm = null;
  }

  function askConfirm(message, okLabel, onOk) {
    showModal(`<p>${esc(message)}</p>
      <div class="row modal-actions">
        <button data-action="modal-cancel">취소</button>
        <button class="primary" data-action="modal-ok" data-autofocus>${esc(okLabel)}</button>
      </div>`);
    pendingConfirm = onOk;
  }

  function copyText(text, textarea) {
    const fallback = () => {
      if (textarea) { textarea.focus(); textarea.select(); }
      toast('자동 복사가 막혀 있습니다. 선택된 내용을 Ctrl+C(휴대폰은 길게 눌러 복사)로 복사하세요.');
    };
    try {
      navigator.clipboard.writeText(text).then(() => toast('복사했습니다. 메모장 등에 붙여넣어 저장하세요.'), fallback);
    } catch (_) {
      fallback();
    }
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
    planMonth: null,
    planDay: null,
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
    if (view === 'plan') { ui.planMonth = null; ui.planDay = null; }
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
    plan: renderPlan,
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
    const name = esc(s.examName || '시험');
    if (exam == null) {
      return `<section class="panel">
        <h2>시험 날짜가 설정되지 않았습니다</h2>
        <p><a href="#" data-nav="settings">설정</a>에서 시험 날짜를 입력하세요. 모든 카드를 시험 전에 복습하도록
        일정을 짜고, 하루에 새 카드를 몇 장씩 공부해야 하는지 알려 드립니다.</p>
      </section>`;
    }
    const left = C.daysBetween(now, exam);
    let headline;
    if (left > 0) headline = `<div class="big-number">D-${left}</div><div>${name}까지 ${left}일 남았습니다</div>`;
    else if (left === 0) headline = `<div class="big-number">D-Day</div><div>오늘은 ${name} 날입니다. 행운을 빕니다! 가볍게 복습만 하세요.</div>`;
    else headline = `<div>${name}은(는) ${shortDate(exam)}에 끝났습니다. 다음 시험 날짜를 <a href="#" data-nav="settings">설정</a>에서 입력하세요.</div>`;

    let advice = '';
    const buffer = toInt(s.examBufferDays, 2);
    if (left > buffer) advice = `${shortDate(C.addDays(exam, -buffer))}까지 새 내용을 공부하고, 이후 ${buffer}일은 복습만 합니다.`;
    else if (left > 0) advice = '마지막 단계입니다. 복습, 모의 테스트, 자주 잊는 카드에 집중하세요.';
    return `<section class="panel">${headline}${advice ? `<p class="muted small" style="margin-top:.5em">${advice}</p>` : ''}</section>`;
  }

  function renderDashboard() {
    const now = Date.now();
    if (!state.cards.length) {
      return `${renderExamPanel(now)}${renderTodo(now)}
        <section class="panel empty">
          <h2>환영합니다! 공부할 내용을 준비해 볼까요?</h2>
          <p class="muted">시험 과목(단원)마다 덱을 하나씩 만들고, 그 안에 질문/답 카드를 추가하세요.</p>
          <div class="row" style="justify-content:center">
            <button class="primary" data-nav="decks">덱 만들기</button>
            <button data-action="load-example">예제 덱 불러오기</button>
            <button data-nav="guide">사용법</button>
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
    if (!unseen) plan = '모든 카드를 한 번 이상 공부했습니다. 매일 복습하고 모의 테스트를 풀어 보세요.';
    else if (opts().examDate != null) {
      const pace = C.newCardQuota(unseen + C.introducedToday(state.log, now), 0, now, { ...opts(), newPerDay: 0 });
      const daily = Math.max(pace, opts().newPerDay);
      plan = `아직 보지 않은 카드가 ${unseen}장 남았습니다. 시험 전에 모두 끝내려면 하루 최소 ${pace}장이 필요하고, 지금 설정으로는 하루 <strong>${daily}장</strong>씩 새로 나옵니다.`;
    }
    else plan = `아직 보지 않은 카드가 ${unseen}장 남았습니다. 하루에 ${opts().newPerDay}장씩 새로 나옵니다.`;

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
        <td class="num"><button data-action="study-deck" data-id="${d.id}">학습</button></td>
      </tr>`;
    }).join('');

    return `${renderExamPanel(now)}${renderTodo(now)}
      <section class="panel">
        <div class="row spread">
          <h2>카드 현황</h2>
          <span class="counts" title="학습 중 · 복습 · 새 카드">
            <span class="c-learn">${q.learningDue.length}</span>
            <span class="c-review">${q.reviewCount}</span>
            <span class="c-new">${q.newCount}</span>
          </span>
        </div>
        <div class="grid" style="margin:.5em 0 1em">
          <div class="stat"><span class="label">지금 할 카드</span><span class="value">${dueNow}</span></div>
          <div class="stat"><span class="label">학습 중</span><span class="value">${learningTotal}</span></div>
          <div class="stat"><span class="label">오늘 공부한 카드</span><span class="value">${doneToday}</span></div>
          <div class="stat"><span class="label">연속 학습 / 뽀모도로</span><span class="value">${C.streak(state.log, now)}일 / ${pomoToday}회</span></div>
        </div>
        <p>${plan}</p>
        <div class="row">
          <button class="primary" data-nav="study" ${dueNow ? '' : 'disabled'}>${dueNow ? '학습 시작 (전체 과목 섞어서)' : '지금은 할 카드가 없습니다 🎉'}</button>
          <button data-nav="practice">모의 테스트 보기</button>
        </div>
      </section>
      <section class="panel">
        <h2>과목별 현황</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>덱</th><th class="num">카드</th><th class="num">안 본 카드</th><th class="num">할 카드</th><th>익힌 비율</th><th></th></tr></thead>
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

    const title = ses.deckId ? esc(deckName(ses.deckId)) : '전체 과목 (섞어서)';
    const undoBtn = ses.undo ? '<button class="ghost" data-action="undo" title="마지막 답 되돌리기 (U)">↶ 되돌리기</button>' : '';
    const header = `<div class="row spread" style="margin-bottom:.75em">
      <div><strong>${title}</strong> <span class="muted small">· ${ses.done}장 완료</span></div>
      <div class="row">${undoBtn}
        <span class="counts" title="학습 중 · 복습 · 새 카드">
          <span class="c-learn">${q.learningDue.length}</span><span class="c-review">${q.reviewCount}</span><span class="c-new">${q.newCount}</span>
        </span>
      </div>
    </div>`;

    if (!card) {
      clearTimeout(ui.refreshTimer);
      let more = '';
      if (q.learningLater.length) {
        const wait = q.learningLater[0].due - now;
        more = `<p>아직 학습 중인 카드가 ${q.learningLater.length}장 있습니다. 다음 카드는 ${C.formatDuration(wait)} 후에 다시 나옵니다.
          잠깐 쉬세요. 때가 되면 이 페이지가 자동으로 이어집니다.</p>`;
        if (wait < C.HOUR) {
          ui.refreshTimer = setTimeout(() => { if (ui.view === 'study') render(); }, wait + 500);
        }
      }
      const unseen = state.cards.filter((c) => c.state === 'new' && (!ses.deckId || c.deckId === ses.deckId)).length;
      const extra = unseen ? `<p><button data-action="more-new">새 카드 ${Math.min(10, unseen)}장 더 공부하기</button></p>` : '';
      return `${header}<section class="panel empty">
        <h2>지금 할 카드는 모두 끝났습니다!</h2>
        ${more}${extra}
        <p class="muted">간격을 두고 다시 보는 것이 핵심입니다. 내일 복습할 카드는 내일 나옵니다.</p>
        <div class="row" style="justify-content:center">
          <button data-nav="dashboard">오늘 화면으로</button>
          <button data-nav="practice">모의 테스트</button>
        </div>
      </section>`;
    }

    const typeAnswer = !!state.settings.typeAnswer;
    let body;
    if (!ses.revealed) {
      body = `${typeAnswer ? `<textarea id="attempt" data-autofocus placeholder="정답을 보기 전에 기억나는 대로 답을 적어 보세요… (Enter: 정답 보기, Shift+Enter: 줄바꿈)">${esc(ses.attempt)}</textarea>` : '<p class="muted">정답을 보기 전에 답을 말하거나 떠올려 보세요.</p>'}
        <div class="row" style="margin-top:.75em">
          <button class="primary" data-action="reveal" ${typeAnswer ? '' : 'data-autofocus'}>정답 보기 <kbd>${typeAnswer ? 'Enter' : 'Space'}</kbd></button>
        </div>`;
    } else {
      const grades = [1, 2, 3, 4].map((g) => `<button class="grade g${g}" data-action="grade" data-grade="${g}">
          <span>${C.GRADE_LABELS[g]}</span><small>${C.previewLabel(card, g, now, o)}</small><kbd>${g}</kbd></button>`).join('');
      body = `${ses.attempt.trim() ? `<div class="answer-block attempt"><h4>내 답</h4><div class="pre">${esc(ses.attempt)}</div></div>` : ''}
        <div class="answer-block"><h4>정답</h4><div class="pre">${esc(card.back)}</div></div>
        <p class="muted small" style="margin-top:1em">솔직하게 평가하세요. 얼마나 잘 기억했나요? <kbd>Space</kbd> = 알맞음</p>
        <div class="grades">${grades}</div>`;
    }

    return `${header}<section class="panel study-card">
      <div class="row spread small muted"><span>${esc(deckName(card.deckId))}</span><span class="badge ${card.state}">${stateLabel(card.state)}</span></div>
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
    return `<option value="">전체 과목</option>${state.decks.map((d) => (
      `<option value="${d.id}" ${d.id === selected ? 'selected' : ''}>${esc(d.name)}</option>`
    )).join('')}`;
  }

  function renderPractice() {
    const p = ui.practice;
    if (!state.cards.length) {
      return '<section class="panel empty"><h2>아직 카드가 없습니다</h2><p>먼저 카드를 추가하세요.</p><button class="primary" data-nav="decks">덱으로 가기</button></section>';
    }

    if (p.stage === 'setup') {
      return `<section class="panel">
        <h1>모의 테스트</h1>
        <p class="muted">스스로 시험을 보는 것은 가장 효과적인 공부법 중 하나입니다. 실제 시험처럼 문제가 무작위로 나옵니다.
        복습 일정은 바뀌지 <em>않지만</em>, 틀린 카드는 오늘 복습 목록에 다시 넣을 수 있습니다.</p>
        <form data-form="practice-start">
          <label for="p-deck">과목</label>
          <select id="p-deck" name="deckId">${deckOptions(p.deckId)}</select>
          <label for="p-count">문제 수</label>
          <input id="p-count" type="number" name="count" min="1" max="200" value="20">
          <label class="inline"><input type="checkbox" name="seenOnly"> 이미 공부한 카드만</label>
          <div class="row" style="margin-top:1em"><button class="primary" type="submit">테스트 시작</button></div>
        </form>
      </section>`;
    }

    if (p.stage === 'run') {
      const item = p.items[p.index];
      const card = state.cards.find((c) => c.id === item.id);
      if (!card) { advancePractice(null); return renderPractice(); }
      const progress = `<div class="row spread small muted" style="margin-bottom:.5em">
        <span>${p.items.length}문제 중 ${p.index + 1}번</span><span>지금까지 ${p.items.filter((i) => i.correct).length}개 정답</span></div>`;
      let body;
      if (!p.revealed) {
        body = `<textarea id="attempt" data-autofocus placeholder="답을 적어 보세요… (Enter: 정답 확인)">${esc(p.attempt)}</textarea>
          <div class="row" style="margin-top:.75em"><button class="primary" data-action="practice-reveal">정답 확인 <kbd>Enter</kbd></button></div>`;
      } else {
        body = `${p.attempt.trim() ? `<div class="answer-block attempt"><h4>내 답</h4><div class="pre">${esc(p.attempt)}</div></div>` : ''}
          <div class="answer-block"><h4>정답</h4><div class="pre">${esc(card.back)}</div></div>
          <div class="row" style="margin-top:1em">
            <button class="grade g1" data-action="practice-mark" data-correct="0">✗ 틀렸어요 <kbd>1</kbd></button>
            <button class="grade g3" data-action="practice-mark" data-correct="1">✓ 맞혔어요 <kbd>2</kbd></button>
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
      <h1>점수: ${right} / ${answered.length} (${pct}%)</h1>
      ${missed.length ? `<p>틀린 문제를 다시 보세요. <em>왜</em> 틀렸는지 이해하는 순간 실력이 늡니다.</p>
        <div class="table-wrap"><table><thead><tr><th>질문</th><th>정답</th></tr></thead><tbody>${missedRows}</tbody></table></div>
        <div class="row" style="margin-top:1em">
          ${p.requeued ? '<span class="muted">틀린 카드를 오늘 복습 목록에 넣었습니다.</span>' : '<button class="primary" data-action="practice-requeue">틀린 카드를 오늘 복습에 추가</button>'}
        </div>` : '<p>만점입니다! 🎉</p>'}
      <div class="row" style="margin-top:1em">
        <button data-action="practice-again">새 테스트</button>
        <button data-nav="dashboard">오늘 화면으로</button>
      </div>
    </section>`;
  }

  function startPractice(form) {
    const fd = new FormData(form);
    const deckId = fd.get('deckId') || '';
    const count = Math.max(1, toInt(fd.get('count'), 20));
    let pool = state.cards.filter((c) => !deckId || c.deckId === deckId);
    if (fd.get('seenOnly')) pool = pool.filter((c) => c.state !== 'new');
    if (!pool.length) { toast('조건에 맞는 카드가 없습니다.'); return; }
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
          <button data-action="open-deck" data-id="${d.id}">카드 편집</button>
          <button data-action="study-deck" data-id="${d.id}">학습</button>
        </div></td>
      </tr>`;
    }).join('');

    return `<section class="panel">
        <h1>덱</h1>
        <p class="muted">시험 과목이나 단원마다 덱을 하나씩 만드세요. 일반 학습에서는 모든 덱의 카드가 섞여서 나옵니다(교차 학습).</p>
        ${state.decks.length ? `<div class="table-wrap"><table>
          <thead><tr><th>덱</th><th class="num">카드</th><th class="num">오늘 복습</th><th></th></tr></thead>
          <tbody>${list}</tbody></table></div>` : '<p>아직 덱이 없습니다.</p>'}
      </section>
      <section class="panel">
        <h2>새 덱</h2>
        <form data-form="add-deck" class="row">
          <input type="text" name="name" placeholder="예: 3단원 — 세포 생물학" required style="flex:1;min-width:200px" ${state.decks.length ? '' : 'data-autofocus'}>
          <button class="primary" type="submit">만들기</button>
        </form>
        <p class="small muted" style="margin-top:.75em">먼저 써 보고 싶다면 <a href="#" data-action="load-example">예제 덱을 불러오세요</a>.</p>
      </section>
      ${renderPresets()}`;
  }

  function presetCount(p) {
    return C.parseCardLines(p.text).cards.length;
  }

  function renderPresets() {
    if (!PRESETS.length) return '';
    const items = PRESETS.map((p) => {
      const added = state.decks.find((d) => d.presetKey === p.key);
      return `<div class="preset">
        <div class="preset-head"><strong>${esc(p.name)}</strong><span class="muted small">카드 ${presetCount(p)}장</span></div>
        <p class="small muted">${esc(p.note)}</p>
        ${added
          ? `<button data-action="open-deck" data-id="${added.id}">추가됨 · 덱 열기</button>`
          : `<button class="primary" data-action="add-preset" data-key="${esc(p.key)}">덱에 추가</button>`}
      </div>`;
    }).join('');
    return `<section class="panel">
      <h2>초안 덱</h2>
      <p class="small muted">공식 출제 목차를 기준으로 Claude가 만든 초안입니다. <strong>틀린 내용이 있을 수 있으니</strong> 소책자나 라플을 읽을 때 해당 카드를 책과 비교해 고치거나(✎) 지우세요(🗑). 책이 항상 우선입니다.</p>
      <div class="preset-list">${items}</div>
    </section>`;
  }

  function addPreset(key) {
    const p = PRESETS.find((x) => x.key === key);
    if (!p || state.decks.some((d) => d.presetKey === key)) return;
    const now = Date.now();
    const d = { id: C.makeId(), name: p.name, createdAt: now, presetKey: p.key };
    state.decks.push(d);
    const { cards } = C.parseCardLines(p.text);
    cards.forEach(([f, b], i) => state.cards.push(C.createCard(d.id, f, b, now + i)));
    save();
    navigate('deck', d.id);
    toast(`${p.name} 덱에 카드 ${cards.length}장을 추가했습니다.`);
  }

  function renderDeck() {
    const d = deck(ui.deckId);
    const now = Date.now();
    const cards = state.cards.filter((c) => c.deckId === d.id).sort((a, b) => a.createdAt - b.createdAt);
    const rows = cards.map((c) => {
      if (c.id === ui.editingCardId) {
        return `<tr><td colspan="4"><form data-form="edit-card" data-id="${c.id}">
          <label>질문</label><textarea name="front" required data-autofocus>${esc(c.front)}</textarea>
          <label>정답</label><textarea name="back" required>${esc(c.back)}</textarea>
          <div class="row" style="margin-top:.5em">
            <button class="primary" type="submit">저장</button>
            <button type="button" data-action="cancel-edit">취소</button>
            <button type="button" data-action="reset-card" data-id="${c.id}" title="진도를 지우고 새 카드로 되돌립니다">진도 초기화</button>
          </div></form></td></tr>`;
      }
      return `<tr data-search="${esc((`${c.front} ${c.back}`).toLowerCase())}">
        <td class="pre">${esc(c.front)}</td>
        <td class="pre muted">${esc(c.back)}</td>
        <td><span class="badge ${c.state}">${stateLabel(c.state)}</span><div class="small muted">${dueLabel(c, now)}${c.lapses ? ` · ${c.lapses}번 잊음` : ''}</div></td>
        <td class="num"><button class="ghost" data-action="edit-card" data-id="${c.id}" title="편집">✎</button><button class="ghost danger" data-action="delete-card" data-id="${c.id}" title="삭제">🗑</button></td>
      </tr>`;
    }).join('');

    return `<section class="panel">
        <div class="row spread">
          <h1>${esc(d.name)}</h1>
          <div class="row">
            <button class="primary" data-action="study-deck" data-id="${d.id}">이 덱 학습하기</button>
            <button data-action="practice-deck" data-id="${d.id}">모의 테스트</button>
          </div>
        </div>
        <p class="small"><a href="#" data-nav="decks">← 전체 덱</a></p>
      </section>
      <section class="panel">
        <h2>카드 추가</h2>
        <p class="small muted">팁: 카드 한 장에 한 가지 내용만, 질문 형태로, 정답은 내 말로 적으세요. 단순 정의보다 "왜?", "어떻게?" 질문이 더 효과적입니다.</p>
        <p class="small muted"><strong>빈칸 카드:</strong> 책 문장을 그대로 적고 외울 부분만 <code>{{ }}</code>로 감싸면 정답 칸은 비워도 됩니다. 빈칸마다 카드가 한 장씩 생깁니다.<br>예: <code>글래스아이오노머는 {{불소}}를 방출하고 치질과 {{화학결합}}한다</code></p>
        <form data-form="add-card">
          <label for="front">질문 또는 빈칸 문장</label>
          <textarea id="front" name="front" required data-autofocus placeholder="예: Angle Class II 부정교합의 기준은?"></textarea>
          <label for="back">정답 <span class="muted small">(빈칸 카드는 비워도 됨)</span></label>
          <textarea id="back" name="back"></textarea>
          <div class="row" style="margin-top:.75em"><button class="primary" type="submit">카드 추가</button><span class="small muted">Ctrl+Enter로 추가</span></div>
        </form>
        <details style="margin-top:1em">
          <summary>한꺼번에 가져오기</summary>
          <form data-form="bulk-import">
            <p class="small muted">한 줄에 카드 한 장: <code>질문 :: 정답</code>, 질문과 정답을 Tab으로 구분(스프레드시트에서 두 열 복사), 또는 <code>{{ }}</code> 빈칸 문장. <code>#</code>으로 시작하는 줄은 무시합니다.</p>
            <textarea name="text" rows="8" placeholder="Black 분류 Class II 와동의 위치는? :: 구치부 인접면&#10;아말감의 상 중 가장 약한 것은 {{γ₂}}이다"></textarea>
            <div class="row" style="margin-top:.5em"><button type="submit">가져오기</button></div>
          </form>
        </details>
      </section>
      <section class="panel">
        <div class="row spread"><h2>카드 ${cards.length}장</h2>
          <input type="search" id="card-search" placeholder="카드 검색…" style="max-width:240px"></div>
        ${cards.length ? `<div class="table-wrap"><table>
          <thead><tr><th>질문</th><th>정답</th><th>상태</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table></div>` : '<p class="muted">아직 카드가 없습니다.</p>'}
      </section>
      <section class="panel">
        <h2>덱 설정</h2>
        <form data-form="rename-deck" class="row">
          <input type="text" name="name" value="${esc(d.name)}" required style="flex:1;min-width:200px">
          <button type="submit">이름 바꾸기</button>
          <button type="button" class="danger" data-action="delete-deck" data-id="${d.id}">덱 삭제</button>
        </form>
      </section>`;
  }

  const EXAMPLE_CARDS = [
    ['능동적 회상(active recall)이란?', '다시 읽는 대신 기억에서 정보를 꺼내는 것(질문에 답하기). 꺼내려고 애쓰는 과정이 기억을 강화한다.'],
    ['간격 반복(spaced repetition)이란?', '한꺼번에 몰아서 외우지 않고, 잊어버리기 직전에 점점 긴 간격으로 다시 복습하는 것.'],
    ['노트를 다시 읽는 것이 왜 약한 공부법일까?', '익숙하다는 착각(유창성 착각)만 줄 뿐, 실제로 답을 떠올릴 수 있는지는 확인하지 못하기 때문.'],
    ['교차 학습(interleaving)이란?', '한 번에 여러 과목이나 문제 유형을 섞어 공부하는 것. 실제 시험처럼 알맞은 풀이법을 고르는 연습이 된다.'],
    ['뽀모도로 기법이란?', '25분 집중하고 5분 쉬기를 반복하고, 4번마다 길게 쉬는 시간 관리법.'],
    ['파인만 기법이란?', '초보자에게 가르치듯 쉬운 말로 개념을 설명하는 것. 설명이 막히는 부분이 아직 이해하지 못한 부분이다.'],
    ['시험 준비에서 잠이 중요한 이유는?', '자는 동안 기억이 굳어진다. 공부 후 잠을 자면 오래 기억하고, 밤샘은 기억을 떠올리는 능력을 떨어뜨린다.'],
    ['시험 효과(testing effect)란?', '같은 시간 동안 다시 공부하는 것보다 모의 테스트를 보는 편이 오래 기억하는 데 더 효과적이라는 현상.'],
  ];

  function loadExample() {
    const now = Date.now();
    const d = { id: C.makeId(), name: '예제: 공부법', createdAt: now };
    state.decks.push(d);
    EXAMPLE_CARDS.forEach(([f, b], i) => state.cards.push(C.createCard(d.id, f, b, now + i)));
    save();
    navigate('deck', d.id);
    toast('예제 덱을 추가했습니다. "이 덱 학습하기"를 눌러 시작해 보세요.');
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
    const dayLabel = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; };
    const hardest = state.cards.filter((c) => c.lapses > 0).sort((a, b) => b.lapses - a.lapses || a.ease - b.ease).slice(0, 10);

    return `<section class="panel">
        <h1>통계</h1>
        <div class="grid">
          <div class="stat"><span class="label">연속 학습일</span><span class="value">${C.streak(log, now)}일</span></div>
          <div class="stat"><span class="label">전체 복습 횟수</span><span class="value">${log.length}</span></div>
          <div class="stat"><span class="label">기억률 (최근 30일)</span><span class="value">${ret == null ? '—' : `${Math.round(ret * 100)}%`}</span></div>
          <div class="stat"><span class="label">카드 학습 시간</span><span class="value">${Math.round(totalMs / C.HOUR * 10) / 10}시간</span></div>
        </div>
        <p class="small muted" style="margin-top:1em">기억률은 85~90% 정도가 가장 좋습니다. 훨씬 높다면 복습 간격을 더 늘려도 되고, 훨씬 낮다면 카드가 너무 어렵거나 큰 것이니 나눠 보세요.</p>
      </section>
      <section class="panel">
        <h2>카드 현황</h2>
        <div class="grid">
          <div class="stat"><span class="label c-new">안 본 카드</span><span class="value">${counts.new}</span></div>
          <div class="stat"><span class="label c-learn">학습 중</span><span class="value">${counts.learning}</span></div>
          <div class="stat"><span class="label c-review">익히는 중 (21일 미만)</span><span class="value">${counts.review}</span></div>
          <div class="stat"><span class="label">완전히 익힘 (21일 이상)</span><span class="value">${counts.mature}</span></div>
        </div>
      </section>
      <section class="panel"><h2>최근 14일 복습량</h2>${bars(C.reviewsPerDay(log, now, 14), dayLabel)}</section>
      <section class="panel"><h2>앞으로 14일 복습 예정</h2>${bars(C.forecast(state.cards, now, 14), dayLabel)}</section>
      <section class="panel">
        <h2>가장 자주 잊는 카드</h2>
        ${hardest.length ? `<p class="small muted">약점인 카드입니다. 다시 쓰거나, 나누거나, 외우기 쉬운 연상법을 붙여 보세요.</p>
          <div class="table-wrap"><table><thead><tr><th>질문</th><th>덱</th><th class="num">잊은 횟수</th><th></th></tr></thead><tbody>
          ${hardest.map((c) => `<tr><td class="pre">${esc(c.front)}</td><td>${esc(deckName(c.deckId))}</td><td class="num">${c.lapses}번</td>
            <td class="num"><button class="ghost" data-action="goto-card" data-deck="${c.deckId}" data-id="${c.id}">편집</button></td></tr>`).join('')}
          </tbody></table></div>` : '<p class="muted">아직 없습니다. 익힌 뒤에 잊어버린 카드가 여기에 표시됩니다.</p>'}
      </section>`;
  }

  // ---------- settings ----------

  function renderSettings() {
    const s = state.settings;
    return `<section class="panel">
        <h1>설정</h1>
        <form data-form="settings">
          <h2>시험</h2>
          <label for="s-name">시험 이름</label>
          <input id="s-name" type="text" name="examName" value="${esc(s.examName)}" placeholder="예: 생물 기말고사">
          <label for="s-date">시험 날짜</label>
          <input id="s-date" type="date" name="examDate" value="${esc(s.examDate)}">
          <label for="s-buffer">시험 직전 복습 전용 기간 (일)</label>
          <input id="s-buffer" type="number" name="examBufferDays" min="0" max="30" value="${esc(s.examBufferDays)}">
          <p class="small muted">이 기간에는 새 카드가 나오지 않아 복습과 모의 테스트에만 집중할 수 있습니다.</p>
          <label for="s-new">하루 새 카드 수</label>
          <input id="s-new" type="number" name="newPerDay" min="0" max="500" value="${esc(s.newPerDay)}">
          <p class="small muted">시험 전에 모든 카드를 끝내기에 부족하면 자동으로 늘어납니다. 복습이 너무 많아지면 줄이세요.</p>

          <h2 style="margin-top:1.2em">학습</h2>
          <label class="inline"><input type="checkbox" name="typeAnswer" ${s.typeAnswer ? 'checked' : ''}> 정답을 보기 전에 내 답을 직접 입력하기 (추천: 능동적으로 떠올리게 됩니다)</label>

          <h2 style="margin-top:1.2em">뽀모도로 (분)</h2>
          <div class="grid">
            <div><label for="s-pw">집중</label><input id="s-pw" type="number" name="pomodoroWork" min="1" max="120" value="${esc(s.pomodoroWork)}"></div>
            <div><label for="s-pb">짧은 휴식</label><input id="s-pb" type="number" name="pomodoroBreak" min="1" max="60" value="${esc(s.pomodoroBreak)}"></div>
            <div><label for="s-pl">긴 휴식</label><input id="s-pl" type="number" name="pomodoroLongBreak" min="1" max="60" value="${esc(s.pomodoroLongBreak)}"></div>
          </div>
          <div class="row" style="margin-top:1em"><button class="primary" type="submit">설정 저장</button></div>
        </form>
      </section>
      <section class="panel">
        <h2>내 데이터</h2>
        <p class="small muted">모든 데이터는 지금 쓰고 있는 이 브라우저에만 저장됩니다. 정기적으로 백업을 내보내고, 다른 기기나 브라우저로 옮길 때도 이 백업을 사용하세요.</p>
        <div class="row">
          <button data-action="export">백업 내보내기</button>
          <button type="button" data-action="import-paste">백업 붙여넣어 가져오기</button>
          <button type="button" data-action="import">백업 파일 가져오기</button>
          <input type="file" id="import-file" accept="application/json,.json" hidden>
          <button class="danger" data-action="reset-all">모든 데이터 삭제</button>
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
    toast('설정을 저장했습니다.');
    render();
  }

  function backupFileName() {
    return `study-backup-${C.dayKey(Date.now())}.json`;
  }

  function exportData() {
    showModal(`<h2>백업 내보내기</h2>
      <p class="small muted">아래 내용을 복사해 메모장, 카카오톡 나와의 채팅 등에 저장해 두세요. 나중에 "백업 붙여넣어 가져오기"로 그대로 복원할 수 있습니다.</p>
      <textarea id="backup-text" rows="8" readonly>${esc(JSON.stringify(state))}</textarea>
      <div class="row modal-actions">
        <button data-action="modal-cancel">닫기</button>
        <button data-action="export-file">파일로 저장</button>
        <button class="primary" data-action="export-copy" data-autofocus>복사</button>
      </div>
      <p class="small muted">"파일로 저장"은 index.html을 브라우저에서 직접 열었을 때만 동작합니다.</p>`);
  }

  function exportFile() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = backupFileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function restoreFromText(text) {
    let data;
    try {
      data = normalize(JSON.parse(text));
    } catch (err) {
      toast(`가져오지 못했습니다. 백업 내용 전체를 빠짐없이 붙여넣었는지 확인하세요. (${err.message})`);
      return;
    }
    askConfirm(`현재 데이터를 모두 이 백업(카드 ${data.cards.length}장)으로 바꿀까요?`, '바꾸기', () => {
      state = data;
      save();
      toast('백업을 가져왔습니다.');
      navigate('dashboard');
    });
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => restoreFromText(String(reader.result));
    reader.readAsText(file);
  }

  function importPaste() {
    showModal(`<h2>백업 붙여넣어 가져오기</h2>
      <p class="small muted">"백업 내보내기"로 복사해 둔 내용을 아래에 붙여넣으세요.</p>
      <textarea id="paste-text" rows="8" data-autofocus></textarea>
      <div class="row modal-actions">
        <button data-action="modal-cancel">취소</button>
        <button class="primary" data-action="import-paste-go">가져오기</button>
      </div>`);
  }

  // ---------- study planner ----------

  function subjectDot(subject) {
    let h = 0;
    for (const ch of String(subject)) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `<span class="dot" style="--h:${h}" aria-hidden="true"></span>`;
  }

  function mdLabel(ts) {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  function planCapacity() {
    return Math.max(1, toInt(state.plan && state.plan.capacity, 100));
  }

  function createPlan() {
    const exam = opts().examDate;
    if (exam == null) return;
    state.plan = { materials: P.defaultMaterials(exam, Date.now()), log: {}, ranges: {}, checks: {}, capacity: 100 };
    ui.planMonth = null;
    ui.planDay = null;
    save();
    render();
    toast('OT 자료의 기간별 전략으로 기본 계획을 만들었습니다. 쪽수는 책을 보고 고쳐 주세요.');
  }

  function setLogged(id, value) {
    const m = state.plan.materials.find((x) => x.id === id);
    if (!m) return;
    const key = C.dayKey(Date.now());
    const old = P.loggedOn(state.plan, key, id);
    const base = m.done - old; // pages read before today
    const v = Math.max(0, Math.min(toInt(value, 0), P.totalPages(m) - base));
    m.done = base + v;
    if (!state.plan.log[key]) state.plan.log[key] = {};
    if (!state.plan.ranges[key]) state.plan.ranges[key] = {};
    if (v) {
      state.plan.log[key][id] = v;
      state.plan.ranges[key][id] = [base, base + v];
    } else {
      delete state.plan.log[key][id];
      delete state.plan.ranges[key][id];
    }
    save();
    render();
  }

  // ---------- today's to-do list ----------

  const REVIEW_MINUTES = 5;

  function checkBox(done, action, key, label, disabled) {
    if (!action) {
      return `<span class="check${done ? ' on' : ''}" role="img" aria-label="${done ? '완료' : '미완료'}"></span>`;
    }
    return `<button class="check${done ? ' on' : ''}" role="checkbox" aria-checked="${done}" aria-label="${esc(label)}"
      data-action="${action}" data-key="${esc(key)}" ${disabled ? 'disabled' : ''}></button>`;
  }

  function agoLabel(n) {
    if (n === 1) return '어제';
    if (n === 7) return '1주 전';
    if (n === 21) return '3주 전';
    return `${n}일 전`;
  }

  function todoStep(no, title, meta, hint, items) {
    return `<div class="todo-step">
      <h3><span class="step-no">${no}</span>${title}${meta ? ` <span class="muted small">${meta}</span>` : ''}</h3>
      ${hint ? `<p class="small muted todo-hint">${hint}</p>` : ''}
      <ul class="todo-list">${items}</ul>
    </div>`;
  }

  function renderTodo(now) {
    const key = C.dayKey(now);
    const exam = opts().examDate;
    const hasCards = state.cards.length > 0;
    const t = state.plan && exam != null ? P.todayTasks(state.plan, now, exam) : null;
    const steps = [];
    let done = 0;
    let total = 0;
    const tick = (isDone) => { total++; if (isDone) done++; };

    // 1. flashcards (spaced repetition)
    if (hasCards) {
      const q = queue(null, now);
      const left = q.learningDue.length + q.mixed.length;
      const studied = state.log.filter((e) => e.ts >= C.startOfDay(now)).length;
      tick(left === 0);
      const body = left
        ? `<strong>카드 ${left}장</strong> <span class="muted small">학습 중 ${q.learningDue.length} · 복습 ${q.reviewCount} · 새 카드 ${q.newCount}</span>
           <div><button class="primary" data-nav="study">학습 시작</button></div>`
        : `<strong>오늘 카드 끝</strong> <span class="muted small">${studied}장 공부함${q.learningLater.length ? ` · 학습 중 ${q.learningLater.length}장은 잠시 후 다시 나옴` : ''}</span>`;
      steps.push(['카드 복습', `약 ${Math.max(1, Math.round(left * 0.3))}분`, '잊을 때쯤 다시 나오는 카드입니다. 가장 먼저, 매일 끝내세요.',
        `<li class="todo${left ? '' : ' done'}">${checkBox(left === 0)}<div class="todo-body">${body}</div></li>`]);
    }

    if (t) {
      // 2. spaced review of ranges read earlier
      if (t.reviews.length) {
        const items = t.reviews.map((r) => {
          tick(r.done);
          return `<li class="todo${r.done ? ' done' : ''}">${checkBox(r.done, 'task-toggle', r.key, `${r.m.subject} 범위 복습`)}
            <div class="todo-body"><div>${subjectDot(r.m.subject)}<strong>${esc(r.m.subject)}</strong> <span class="muted">${esc(r.m.name)}</span> · ${P.rangeLabel(r.m, r.from, r.to)}</div>
              <div class="small muted">${agoLabel(r.ago)} 읽은 범위${r.overdue ? ' · <span class="warn">밀림</span>' : ''}</div></div></li>`;
        }).join('');
        steps.push(['지난 범위 복습', `${t.reviews.length}개 · 약 ${t.reviews.length * REVIEW_MINUTES}분`,
          '책을 펴기 전에 목차와 소제목만 보고 내용을 떠올려 보세요. 막힌 부분만 다시 훑습니다.', items]);
      }

      // 3. new reading, each followed by recall (active recall)
      if (t.reading.length) {
        const items = t.reading.map((it) => {
          const logged = P.loggedOn(state.plan, key, it.m.id);
          const isDone = logged >= it.pages;
          const rc = t.recalls.find((x) => x.m.id === it.m.id);
          tick(isDone);
          tick(rc && rc.done);
          const recallLine = rc
            ? `<div class="recall-line${rc.done ? ' done' : ''}">${checkBox(rc.done, 'task-toggle', rc.key, `${it.m.subject} 떠올리기`)}
                <span>떠올리기${rc.done ? ' 완료' : ''}</span>${rc.done ? '' : `<button data-action="recall-open" data-id="${it.m.id}">책 덮고 떠올리기</button>`}</div>`
            : '<div class="recall-line pending"><span class="check" aria-hidden="true"></span><span class="small muted">읽은 뒤 떠올리기</span></div>';
          return `<li class="todo${isDone && rc && rc.done ? ' done' : ''}">${checkBox(isDone)}
            <div class="todo-body">
              <div>${subjectDot(it.m.subject)}<strong>${esc(it.m.subject)}</strong> <span class="muted">${esc(it.m.name)}</span>${it.overdue ? ' <span class="badge overdue">기간 지남</span>' : ''}</div>
              <div class="small">${P.rangeLabel(it.m, it.from, it.to)} <span class="muted">· ${it.pages}쪽</span></div>
              <div class="plan-item-log">
                <input type="number" class="plan-log" id="log-${it.m.id}" data-id="${it.m.id}" min="0" inputmode="numeric" value="${logged}" aria-label="${esc(it.m.subject)} 오늘 읽은 쪽수">
                <span class="small muted">/ ${it.pages}쪽</span>
                <button data-action="plan-done" data-id="${it.m.id}" data-pages="${it.pages}" ${isDone ? 'class="is-done"' : ''}>${isDone ? '✓ 다 읽음' : '다 읽었어요'}</button>
              </div>
              ${recallLine}
            </div></li>`;
        }).join('');
        const pages = P.dayTotal(t.reading);
        steps.push(['새 범위 읽기 → 떠올리기', `${pages}쪽`,
          '처음 이해하는 단계입니다. 다 읽으면 바로 책을 덮고 핵심을 떠올린 뒤 책과 비교하세요. 못 떠올린 것만 빈칸 카드로 만듭니다.', items]);
      }

      // 5. past questions (testing effect)
      if (t.quizzes.length) {
        const items = t.quizzes.map((qz) => {
          tick(qz.done);
          return `<li class="todo${qz.done ? ' done' : ''}">${checkBox(qz.done, 'task-toggle', qz.key, `${qz.m.subject} 기출 풀이`)}
            <div class="todo-body"><div>${subjectDot(qz.m.subject)}<strong>${esc(qz.m.subject)} 기출 풀이</strong></div>
              <div class="small muted">${esc(qz.label)}${qz.overdue ? ' · <span class="warn">밀림</span>' : ''}</div></div></li>`;
        }).join('');
        steps.push(['기출 풀이', `${t.quizzes.length}개`, '틀린 문제의 개념은 빈칸 카드로 만들어 두세요.', items]);
      }
    }

    let setup = '';
    if (!t) {
      setup = exam == null
        ? `<p class="small">시험 날짜를 정하면 매일 읽을 범위, 복습, 기출 풀이까지 이 목록에 모아 드립니다. <button data-nav="settings">시험 날짜 정하기</button></p>`
        : `<p class="small">학습 계획을 만들면 매일 읽을 범위, 복습, 기출 풀이까지 이 목록에 모아 드립니다. <button class="primary" data-nav="plan">학습 계획 만들기</button></p>`;
    }
    if (!steps.length && !setup) return '';

    const pomoToday = state.pomodoro.day === C.dayKey(now) ? state.pomodoro.completed : 0;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const allDone = total > 0 && done === total;
    return `<section class="panel todo-panel">
      <div class="row spread">
        <h2>오늘 할 일</h2>
        <span class="small muted">${done} / ${total} 완료 · 뽀모도로 ${pomoToday}회</span>
      </div>
      <div class="plan-progress"><div style="width:${pct}%"></div></div>
      ${allDone ? '<p class="todo-done-msg">오늘 할 일을 모두 끝냈습니다. 푹 쉬세요!</p>' : ''}
      ${steps.map((s, i) => todoStep(i + 1, s[0], s[1], s[2], s[3])).join('')}
      ${setup}
    </section>`;
  }

  // ---------- recall dialog ----------

  function deckForSubject(subject) {
    return state.decks.find((d) => d.name.includes(subject)) || null;
  }

  function openRecall(id) {
    const key = C.dayKey(Date.now());
    const r = ((state.plan.ranges || {})[key] || {})[id];
    const m = state.plan.materials.find((x) => x.id === id);
    if (!m || !r) return;
    const match = deckForSubject(m.subject);
    const options = state.decks.map((d) => `<option value="${d.id}" ${match && match.id === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
    showModal(`<h2>읽은 직후 떠올리기</h2>
      <p class="small">${subjectDot(m.subject)}<strong>${esc(m.subject)}</strong> ${esc(m.name)} · ${P.rangeLabel(m, r[0], r[1])}</p>
      <ol class="small recall-steps">
        <li><strong>책을 덮고</strong> 방금 읽은 핵심을 2~3분 동안 생각나는 대로 적으세요.</li>
        <li>책을 다시 펴서 비교하세요.</li>
        <li><strong>못 떠올렸거나 틀린 것만</strong> 아래에 빈칸 문장으로 적으면 카드가 됩니다.</li>
      </ol>
      <label for="recall-text">떠올린 내용 <span class="muted small">(저장되지 않습니다)</span></label>
      <textarea id="recall-text" rows="5" data-autofocus placeholder="책을 덮고 기억나는 대로 적어 보세요"></textarea>
      <label for="recall-cards">못 떠올린 것 → 카드 <span class="muted small">한 줄에 하나, 외울 부분을 {{ }}로</span></label>
      <textarea id="recall-cards" rows="4" placeholder="예: 고동 아말감은 {{γ₂}} 상이 거의 생기지 않는다"></textarea>
      <label for="recall-deck">카드를 넣을 덱</label>
      <select id="recall-deck">${options}<option value="__new__" ${match ? '' : 'selected'}>새 덱 만들기: ${esc(m.subject)}</option></select>
      <div class="row modal-actions">
        <button data-action="modal-cancel">나중에</button>
        <button class="primary" data-action="recall-save" data-id="${m.id}">떠올리기 완료</button>
      </div>`);
  }

  function saveRecall(id) {
    const m = state.plan.materials.find((x) => x.id === id);
    if (!m) return;
    const key = C.dayKey(Date.now());
    const { cards, skipped } = C.parseCardLines($('#recall-cards').value);
    let deckId = $('#recall-deck').value;
    if (cards.length) {
      if (deckId === '__new__') {
        const d = { id: C.makeId(), name: m.subject, createdAt: Date.now() };
        state.decks.push(d);
        deckId = d.id;
      }
      const now = Date.now();
      cards.forEach(([f, b], i) => state.cards.push(C.createCard(deckId, f, b, now + i)));
    }
    state.plan.checks[`rc|${key}|${id}`] = key;
    closeModal();
    save();
    render();
    toast(cards.length
      ? `카드 ${cards.length}장을 만들었습니다.${skipped ? ` ${skipped}줄은 {{ }}나 ::가 없어 건너뛰었습니다.` : ''}`
      : '떠올리기를 완료했습니다.');
  }

  function renderPlan() {
    const now = Date.now();
    const exam = opts().examDate;
    if (exam == null) {
      return `<section class="panel empty">
        <h2>먼저 시험 날짜를 정해 주세요</h2>
        <p class="muted">계획은 시험 날짜를 기준으로 거꾸로 짭니다.</p>
        <button class="primary" data-nav="settings">설정으로 가기</button>
      </section>`;
    }
    if (!state.plan) {
      return `<section class="panel">
        <h1>학습 계획</h1>
        <p>79회 OT 자료의 <strong>기간별 전략</strong>과 과목별 추천 자료로 시험 날짜까지의 읽기 계획을 만듭니다.</p>
        <ul class="small">
          <li><strong>초반 과목</strong>(지금부터): 치재(경희치재), 영상(교과서 13장까지), 외과(퍼플외과), 병리(테마병리), 교정(옳소교정), 치주(치주대마왕)</li>
          <li><strong>중반 과목</strong>(D-80부터): 소치(소맥), 보철(골드크라운·olleh RPD), 보존(all in one), 내과(단내지존), 생물(생맥)</li>
          <li><strong>후반 과목</strong>(D-60부터): 보건(보석건틀렛), 법규(법규王)</li>
          <li><strong>라플</strong>: 배포 예상일(D-65)부터 1회독, 12월 중순부터 라플·단권화 자료 반복</li>
          <li>시험 전 ${toInt(state.settings.examBufferDays, 2)}일은 복습 전용</li>
        </ul>
        <p class="small muted">쪽수는 임시값입니다. 만든 뒤 책의 마지막 쪽 번호를 보고 고치면 하루 분량이 자동으로 다시 계산됩니다.</p>
        <button class="primary" data-action="plan-create">기본 계획 만들기</button>
      </section>`;
    }

    const cal = P.buildCalendar(state.plan, now);
    const left = C.daysBetween(now, exam);
    const head = `<section class="panel">
      <div class="row spread"><h1>학습 계획</h1><span class="muted">${left > 0 ? `D-${left}` : left === 0 ? 'D-Day' : ''}</span></div>
      <p class="small muted">오늘 할 일(읽기, 지난 범위 복습, 떠올리기, 기출 풀이)은 <a href="#" data-nav="dashboard">오늘</a> 탭에 모여 있습니다. 여기서는 전체 일정을 보고 자료와 기간을 고칩니다.</p>
    </section>`;
    return `${head}${renderCalendar(cal, now, exam)}${renderMaterials(now)}`;
  }

  function renderCalendar(cal, now, exam) {
    const todayKey = C.dayKey(now);
    const cur = new Date(now);
    const firstMonth = new Date(cur.getFullYear(), cur.getMonth(), 1).getTime();
    const lastMonth = new Date(new Date(exam).getFullYear(), new Date(exam).getMonth(), 1).getTime();
    let month = ui.planMonth || firstMonth;
    month = Math.min(Math.max(month, firstMonth), Math.max(firstMonth, lastMonth));
    ui.planMonth = month;
    const md = new Date(month);
    const y = md.getFullYear();
    const mo = md.getMonth();
    const days = new Date(y, mo + 1, 0).getDate();
    const marks = new Map();
    for (const ms of P.milestones(exam, toInt(state.settings.examBufferDays, 2))) {
      const k = C.dayKey(ms.ts);
      if (!marks.has(k)) marks.set(k, ms);
    }
    const cap = planCapacity();
    const selected = ui.planDay || todayKey;
    const extras = P.calendarExtras(state.plan, cal, now, exam);

    let cells = '';
    for (let i = 0; i < md.getDay(); i++) cells += '<div class="cal-cell blank" aria-hidden="true"></div>';
    for (let d = 1; d <= days; d++) {
      const ts = new Date(y, mo, d).getTime();
      const k = C.dayKey(ts);
      const its = cal.get(k) || [];
      const tot = P.dayTotal(its);
      const mk = marks.get(k);
      const subjects = [...new Set(its.map((it) => it.m.subject))];
      const cls = ['cal-cell'];
      if (k === todayKey) cls.push('today');
      if (k === selected) cls.push('selected');
      if (k < todayKey) cls.push('past');
      if (mk && mk.exam) cls.push('exam');
      if (mk && mk.buffer) cls.push('buffer');
      if (k >= todayKey && tot > cap) cls.push('over');
      cells += `<button class="${cls.join(' ')}" data-action="plan-day" data-key="${k}" aria-label="${mo + 1}월 ${d}일 ${tot}쪽">
        <span class="cal-date">${d}</span>
        ${tot ? `<span class="cal-pages">${tot}쪽</span>` : ''}
        ${mk ? `<span class="cal-tag">${esc(mk.label)}</span>` : ''}
        ${extras.has(k) ? `<span class="cal-sub">${[extras.get(k).reviews.length ? `복습 ${extras.get(k).reviews.length}` : '', extras.get(k).quizzes.length ? '기출' : ''].filter(Boolean).join(' · ')}</span>` : ''}
        <span class="cal-dots">${subjects.slice(0, 5).map(subjectDot).join('')}</span>
      </button>`;
    }

    const selTs = C.parseDate(selected);
    const selEx = extras.get(selected) || { reviews: [], quizzes: [] };
    const exList = [
      ...selEx.quizzes.map((qz) => `<li>${subjectDot(qz.m.subject)}<strong>${esc(qz.m.subject)} 기출 풀이</strong> <span class="muted small">${esc(qz.label)}</span></li>`),
      ...selEx.reviews.slice(0, 8).map((r) => `<li>${subjectDot(r.m.subject)}복습: ${esc(r.m.subject)} ${P.rangeLabel(r.m, r.from, r.to)} <span class="muted small">${agoLabel(r.ago)} 읽은 범위</span></li>`),
      selEx.reviews.length > 8 ? `<li class="muted small">외 복습 ${selEx.reviews.length - 8}개</li>` : '',
    ].join('');
    const selItems = cal.get(selected) || [];
    const selMark = marks.get(selected);
    const detail = selItems.length
      ? `<ul class="plan-summary">${selItems.map((it) => (it.past
        ? `<li>${subjectDot(it.m.subject)}<strong>${esc(it.m.subject)}</strong> ${esc(it.m.name)} <span class="muted small">${it.pages}쪽 읽음</span></li>`
        : `<li>${subjectDot(it.m.subject)}<strong>${esc(it.m.subject)}</strong> ${esc(it.m.name)} · ${P.rangeLabel(it.m, it.from, it.to)} <span class="muted small">${it.pages}쪽</span></li>`)).join('')}</ul>`
      : `<p class="muted small">${selected < todayKey ? '기록된 공부가 없습니다.' : selMark && selMark.buffer ? '새 분량 없이 복습만 합니다.' : selMark && selMark.exam ? '시험 날입니다. 행운을 빕니다!' : '읽을 분량이 없습니다.'}</p>`;

    return `<section class="panel">
      <div class="row spread">
        <button class="ghost" data-action="plan-month" data-dir="-1" ${month <= firstMonth ? 'disabled' : ''} aria-label="이전 달">‹</button>
        <h2 style="margin:0">${y}년 ${mo + 1}월</h2>
        <button class="ghost" data-action="plan-month" data-dir="1" ${month >= lastMonth ? 'disabled' : ''} aria-label="다음 달">›</button>
      </div>
      <div class="cal-grid cal-head">${['일', '월', '화', '수', '목', '금', '토'].map((w) => `<div>${w}</div>`).join('')}</div>
      <div class="cal-grid">${cells}</div>
      <div class="cal-detail">
        <h3>${selTs ? `${mdLabel(selTs)} (${['일', '월', '화', '수', '목', '금', '토'][new Date(selTs).getDay()]})` : ''}${selMark ? ` · ${esc(selMark.label)}` : ''} <span class="muted small">${P.dayTotal(selItems)}쪽</span></h3>
        ${detail}
        ${exList ? `<ul class="plan-summary cal-extra">${exList}</ul>` : ''}
      </div>
      <div class="row small muted cal-legend">
        <label for="plan-capacity" style="margin:0;font-weight:normal">하루 최대</label>
        <input type="number" id="plan-capacity" min="1" max="2000" value="${cap}" style="width:6em"> 쪽을 넘는 날은 <span class="warn">빨간색</span>으로 표시
      </div>
    </section>`;
  }

  function renderMaterials(now) {
    const rows = state.plan.materials.map((m) => {
      const total = P.totalPages(m);
      const pct = total ? Math.round((m.done / total) * 100) : 0;
      return `<tr>
        <td>${subjectDot(m.subject)}<strong>${esc(m.subject)}</strong> <span class="muted">${esc(m.name)}</span>
          <div class="small muted">${m.pages}쪽 × ${m.rounds}회독 · ${mdLabel(C.parseDate(m.start))}~${mdLabel(C.parseDate(m.end))}${m.estimated ? ' <span class="badge overdue">쪽수 확인</span>' : ''}</div></td>
        <td style="width:28%"><div class="row" style="flex-wrap:nowrap"><div class="progress" style="flex:1"><div style="width:${pct}%"></div></div><span class="small muted">${pct}%</span></div></td>
        <td class="num"><button class="ghost" data-action="plan-edit" data-id="${m.id}" title="편집">✎</button></td>
      </tr>`;
    }).join('');
    return `<section class="panel">
      <div class="row spread"><h2>자료와 기간</h2><button data-action="plan-add">자료 추가</button></div>
      <p class="small muted">"쪽수 확인" 표시는 임시 쪽수입니다. ✎를 눌러 실제 쪽수와 기간을 고치면 달력이 바로 다시 계산됩니다.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>과목 · 자료 · 분량 · 기간</th><th>진도</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="row" style="margin-top:1em"><button class="danger" data-action="plan-reset">기본 계획으로 다시 만들기</button></div>
    </section>`;
  }

  function editMaterial(id) {
    const m = id ? state.plan.materials.find((x) => x.id === id) : null;
    const today = C.dayKey(Date.now());
    const v = m || { subject: '', name: '', pages: 100, rounds: 1, start: today, end: C.dayKey(C.addDays(Date.now(), 30)), done: 0 };
    showModal(`<h2>${m ? '자료 편집' : '자료 추가'}</h2>
      <form data-form="plan-material" data-id="${m ? m.id : ''}">
        <label for="pm-subject">과목</label>
        <input type="text" id="pm-subject" name="subject" value="${esc(v.subject)}" required data-autofocus>
        <label for="pm-name">자료 이름</label>
        <input type="text" id="pm-name" name="name" value="${esc(v.name)}" required placeholder="예: 경희치재">
        <div class="grid">
          <div><label for="pm-pages">쪽수</label><input type="number" id="pm-pages" name="pages" min="1" value="${v.pages}" required></div>
          <div><label for="pm-rounds">회독 수</label><input type="number" id="pm-rounds" name="rounds" min="1" max="10" value="${v.rounds}" required></div>
        </div>
        <div class="grid">
          <div><label for="pm-start">시작일</label><input type="date" id="pm-start" name="start" value="${esc(v.start)}" required></div>
          <div><label for="pm-end">끝낼 날</label><input type="date" id="pm-end" name="end" value="${esc(v.end)}" required></div>
        </div>
        <label for="pm-done">지금까지 읽은 쪽수 (모든 회독 합계)</label>
        <input type="number" id="pm-done" name="done" min="0" value="${v.done}">
        <div class="row modal-actions">
          ${m ? `<button type="button" class="danger" data-action="plan-delete" data-id="${m.id}" style="margin-right:auto">삭제</button>` : ''}
          <button type="button" data-action="modal-cancel">취소</button>
          <button type="submit" class="primary">저장</button>
        </div>
      </form>`);
  }

  function saveMaterial(form) {
    const fd = new FormData(form);
    const start = String(fd.get('start') || '');
    const end = String(fd.get('end') || '');
    if (!C.parseDate(start) || !C.parseDate(end) || end < start) {
      toast('끝낼 날은 시작일과 같거나 그 뒤여야 합니다.');
      return;
    }
    const fields = {
      subject: String(fd.get('subject') || '').trim(),
      name: String(fd.get('name') || '').trim(),
      pages: Math.max(1, toInt(fd.get('pages'), 1)),
      rounds: Math.max(1, toInt(fd.get('rounds'), 1)),
      start,
      end,
      estimated: false,
    };
    fields.done = Math.min(toInt(fd.get('done'), 0), fields.pages * fields.rounds);
    const id = form.dataset.id;
    if (id) Object.assign(state.plan.materials.find((x) => x.id === id), fields);
    else state.plan.materials.push({ id: C.makeId(), group: '', ...fields });
    closeModal();
    save();
    render();
    toast('저장했습니다. 달력을 다시 계산했습니다.');
  }

  // ---------- guide ----------

  function renderGuide() {
    return `<section class="panel guide">
      <h1>이 앱이 공부를 돕는 방법</h1>
      <p>모든 기능은 연구로 효과가 입증된 학습법을 바탕으로 합니다.</p>

      <h2>1. 능동적 회상 (Active recall)</h2>
      <p>질문만 보고 정답을 보기 전에 답을 직접 <strong>떠올려야</strong> 합니다. 직접 적어 보면 더 좋습니다.
      기억에서 정보를 꺼내는 과정은 다시 읽거나 형광펜을 칠하는 것보다 훨씬 강하게 기억을 남깁니다.</p>

      <h2>2. 간격 반복 (Spaced repetition)</h2>
      <p>정답을 확인한 뒤 얼마나 잘 기억했는지 평가하세요.</p>
      <ul>
        <li><strong>다시</strong>: 기억나지 않았습니다. 몇 분 뒤에 다시 나옵니다.</li>
        <li><strong>어려움</strong>: 기억은 났지만 꽤 애를 썼습니다.</li>
        <li><strong>알맞음</strong>: 잠깐 생각한 뒤 기억났습니다.</li>
        <li><strong>쉬움</strong>: 바로 알았습니다.</li>
      </ul>
      <p>잘 아는 카드는 점점 긴 간격(1일, 3일, 1주…)으로 다시 나오고, 어려운 카드는 더 자주 나옵니다.
      일정은 SuperMemo와 Anki가 쓰는 SM-2 알고리즘을 바탕으로 계산합니다.</p>

      <h2>3. 시험 날짜에 맞춘 계획</h2>
      <p>시험 날짜를 정하면 시험 이후로 잡히는 복습은 없습니다. 아직 보지 않은 카드는 남은 날짜에 고르게 나눠지므로
      제때 모든 내용을 끝내고, 마지막 며칠은 복습에만 쓸 수 있습니다.</p>

      <h2>4. 교차 학습 (Interleaving)</h2>
      <p>일반 학습에서는 모든 과목의 카드가 섞여 나옵니다. 한 단원씩 공부하는 것보다 어렵게 느껴지지만 더 많이 배우고,
      실제 시험과도 더 비슷합니다.</p>

      <h2>5. 모의 테스트</h2>
      <p>무작위 문제로 실제 시험처럼 테스트를 보며 현재 실력을 확인하세요. 틀린 카드는 바로 오늘 복습 목록에 넣을 수 있습니다.</p>

      <h2>6. 뽀모도로</h2>
      <p>위쪽 타이머를 사용하세요. 25분 집중, 5분 휴식, 4번마다 긴 휴식입니다. 쉬는 시간이 집중력을 유지해 주고,
      타이머가 있으면 공부를 시작하기도 쉬워집니다.</p>

      <h2>하루 루틴 ("오늘" 탭)</h2>
      <p>오늘 탭의 할 일 목록을 위에서부터 순서대로 체크하세요.</p>
      <ol>
        <li><strong>카드 복습</strong>: 잊을 때쯤 다시 나오는 카드(간격 반복, 능동적 회상)</li>
        <li><strong>지난 범위 복습</strong>: 1일·1주·3주 전에 읽은 범위를 목차만 보고 떠올린 뒤 막힌 곳만 훑기(간격 반복)</li>
        <li><strong>새 범위 읽기</strong>: 계획 달력이 정한 오늘 분량. 못 읽은 분량은 남은 날짜에 자동으로 나눠짐</li>
        <li><strong>읽은 직후 떠올리기</strong>: 책을 덮고 핵심을 적은 뒤 비교, 못 떠올린 것만 빈칸 카드로(능동적 회상)</li>
        <li><strong>기출 풀이</strong>: 과목별 기간 중간과 끝(시험 효과)</li>
      </ol>

      <h2>빈칸 카드로 빠르게 만들기</h2>
      <p>책의 중요한 문장을 그대로 적고 외울 부분만 <code>{{ }}</code>로 감싸세요. 빈칸마다 카드가 한 장씩 생깁니다.
      치주, 교정, 소치처럼 교과서 문장이 그대로 출제되는 과목에 특히 잘 맞습니다.</p>
      <ul>
        <li><code>글래스아이오노머는 {{불소}}를 방출한다</code> → "글래스아이오노머는 [ ? ]를 방출한다"</li>
        <li>힌트를 주려면 <code>{{정답::힌트}}</code>: <code>{{γ₂::상 이름}}</code> → "[ 상 이름 ]"</li>
        <li>휴대폰 음성 입력으로 문장을 불러 넣으면 더 빠릅니다.</li>
      </ul>

      <h2>좋은 카드 만드는 법</h2>
      <ul>
        <li>카드 한 장에 한 가지 내용만 넣으세요. 긴 답은 나누세요.</li>
        <li>내용을 이해한 뒤에 내 말로 카드를 쓰세요(파인만 기법: 쉽게 설명해 보기).</li>
        <li>"무엇인가?"뿐 아니라 "왜?", "어떻게?"를 물으세요.</li>
        <li>솔직하게 평가하세요. 틀린 카드에 "알맞음"을 누르면 일정만 틀어집니다.</li>
        <li>매일 조금씩 하세요. 오래 공부하는 것보다 매일 복습하는 것이 더 중요합니다.</li>
        <li>특히 시험 직전 며칠은 잠을 충분히 자세요.</li>
      </ul>

      <h2>단축키</h2>
      <ul>
        <li>답 입력칸에서 <kbd>Enter</kbd>, 또는 <kbd>Space</kbd>: 정답 보기</li>
        <li><kbd>1</kbd>–<kbd>4</kbd>: 다시 / 어려움 / 알맞음 / 쉬움. <kbd>Space</kbd>: 알맞음</li>
        <li><kbd>U</kbd>: 마지막 답 되돌리기</li>
        <li><kbd>Ctrl</kbd>+<kbd>Enter</kbd>: 덱 편집 중 카드 추가</li>
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
    const label = pomo.mode === 'work' ? '집중' : pomo.mode === 'long' ? '긴 휴식' : '휴식';
    $('#pomo-time').textContent = fmtClock(left);
    $('#pomo-mode').textContent = label;
    $('#pomo-toggle').textContent = pomo.running ? '일시정지' : '시작';
    $('#pomo').classList.toggle('running', pomo.running);
    $('#pomo').classList.toggle('break', pomo.mode !== 'work');
    document.title = pomo.running ? `${fmtClock(left)} · ${label}` : '시험 공부 매니저';
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
      toast(wasWork ? '집중 시간 끝! 일어나서 스트레칭하고 화면에서 눈을 떼고 쉬세요.' : '휴식 끝! 다시 집중해 볼까요?');
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
    if (e.target.id === 'modal') { closeModal(); return; }
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
      case 'add-preset': addPreset(el.dataset.key); break;
      case 'edit-card': ui.editingCardId = id; render(); break;
      case 'cancel-edit': ui.editingCardId = null; render(); break;
      case 'goto-card': ui.view = 'deck'; ui.deckId = el.dataset.deck; ui.editingCardId = id; render(); break;
      case 'modal-ok': {
        const fn = pendingConfirm;
        closeModal();
        if (fn) fn();
        break;
      }
      case 'modal-cancel': closeModal(); break;
      case 'delete-card':
        askConfirm('이 카드를 삭제할까요?', '삭제', () => {
          state.cards = state.cards.filter((c) => c.id !== id);
          save();
          render();
        });
        break;
      case 'reset-card':
        askConfirm('이 카드를 새 카드로 초기화할까요? 지금까지의 복습 기록은 통계에 남습니다.', '초기화', () => {
          const i = state.cards.findIndex((c) => c.id === id);
          if (i < 0) return;
          const c = state.cards[i];
          state.cards[i] = { ...C.createCard(c.deckId, c.front, c.back, c.createdAt), id: c.id };
          ui.editingCardId = null;
          save();
          render();
        });
        break;
      case 'delete-deck': {
        const n = state.cards.filter((c) => c.deckId === id).length;
        askConfirm(`"${deckName(id)}" 덱과 카드 ${n}장을 삭제할까요? 되돌릴 수 없습니다.`, '덱 삭제', () => {
          state.decks = state.decks.filter((d) => d.id !== id);
          state.cards = state.cards.filter((c) => c.deckId !== id);
          save();
          navigate('decks');
        });
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
      case 'export-copy': {
        const ta = $('#backup-text');
        copyText(ta.value, ta);
        break;
      }
      case 'export-file': exportFile(); break;
      case 'import': $('#import-file').click(); break;
      case 'import-paste': importPaste(); break;
      case 'import-paste-go': {
        const text = $('#paste-text').value.trim();
        if (!text) { toast('백업 내용을 붙여넣어 주세요.'); break; }
        closeModal();
        restoreFromText(text);
        break;
      }
      case 'reset-all':
        askConfirm('모든 덱, 카드, 학습 기록을 삭제합니다. 되돌릴 수 없으니 먼저 백업을 내보내 두세요.', '모두 삭제', () => {
          state = emptyState();
          save();
          navigate('dashboard');
        });
        break;
      case 'pomo-toggle': pomoToggle(); break;
      case 'pomo-reset': pomo.running = false; pomo.remaining = pomoLength(pomo.mode); updatePomo(); break;
      case 'pomo-skip': nextPhase(false); break;
      case 'plan-create': createPlan(); break;
      case 'plan-done': {
        const key = C.dayKey(Date.now());
        const target = toInt(el.dataset.pages, 0);
        const wasDone = P.loggedOn(state.plan, key, id) >= target;
        setLogged(id, wasDone ? 0 : target);
        if (!wasDone && !state.plan.checks[`rc|${key}|${id}`]) openRecall(id);
        break;
      }
      case 'task-toggle': {
        const k = el.dataset.key;
        if (!k || !state.plan) break;
        if (state.plan.checks[k]) delete state.plan.checks[k];
        else state.plan.checks[k] = C.dayKey(Date.now());
        save();
        render();
        break;
      }
      case 'recall-open': openRecall(id); break;
      case 'recall-save': saveRecall(id); break;
      case 'plan-day': ui.planDay = el.dataset.key; render(); break;
      case 'plan-month': {
        const d = new Date(ui.planMonth || Date.now());
        ui.planMonth = new Date(d.getFullYear(), d.getMonth() + Number(el.dataset.dir), 1).getTime();
        render();
        break;
      }
      case 'plan-edit': editMaterial(id); break;
      case 'plan-add': editMaterial(null); break;
      case 'plan-delete':
        closeModal();
        askConfirm('이 자료를 계획에서 삭제할까요?', '삭제', () => {
          state.plan.materials = state.plan.materials.filter((x) => x.id !== id);
          save();
          render();
        });
        break;
      case 'plan-reset':
        askConfirm('지금 계획과 진도 기록을 지우고, 현재 시험 날짜 기준으로 기본 계획을 다시 만들까요?', '다시 만들기', createPlan);
        break;
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
        toast('덱 이름을 바꿨습니다.');
        render();
        break;
      }
      case 'add-card': {
        const front = String(fd.get('front') || '').trim();
        const back = String(fd.get('back') || '').trim();
        if (!front) return;
        const now = Date.now();
        if (C.hasCloze(front)) {
          const made = C.clozeCards(front, back);
          made.forEach(([f, b], i) => state.cards.push(C.createCard(ui.deckId, f, b, now + i)));
          toast(`빈칸 카드 ${made.length}장을 추가했습니다.`);
        } else if (back) {
          state.cards.push(C.createCard(ui.deckId, front, back, now));
          toast('카드를 추가했습니다.');
        } else {
          toast('정답을 입력하거나, 질문에 {{ }}로 빈칸을 표시하세요.');
          return;
        }
        save();
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
        const { cards, skipped } = C.parseCardLines(String(fd.get('text') || ''));
        const now = Date.now();
        cards.forEach(([f, b], i) => state.cards.push(C.createCard(ui.deckId, f, b, now + i)));
        save();
        toast(`카드 ${cards.length}장을 가져왔습니다.${skipped ? ` 구분자가 없는 ${skipped}줄은 건너뛰었습니다.` : ''}`);
        render();
        break;
      }
      case 'practice-start': startPractice(form); break;
      case 'settings': saveSettings(form); break;
      case 'plan-material': saveMaterial(form); break;
      default: break;
    }
  });

  document.addEventListener('change', (e) => {
    if (e.target.classList.contains('plan-log')) {
      setLogged(e.target.dataset.id, e.target.value);
      return;
    }
    if (e.target.id === 'plan-capacity') {
      state.plan.capacity = Math.max(1, toInt(e.target.value, 100));
      save();
      render();
      return;
    }
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

    if (!$('#modal').hidden) {
      if (e.key === 'Escape') closeModal();
      return;
    }

    // Ctrl/Cmd+Enter submits the form being edited (e.g. add card).
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && t.form && t.form.dataset.form) {
      e.preventDefault();
      t.form.requestSubmit();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (ui.view === 'study' && ui.session && !typing && ['u', 'U', 'ㅕ'].includes(e.key) && ui.session.undo) {
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
