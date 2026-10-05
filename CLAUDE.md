# 시험 공부 매니저 — notes for Claude

A dependency-free browser app (Korean UI) for preparing for the 79th Korean dental licensing exam
(치과의사 국가시험, 2027-01-14). The user is a dental student; reply to them in Korean.

## Layout
- `index.html`, `css/styles.css` — page shell and styles (light/dark tokens, phone layout)
- `js/core.js` — spaced repetition (SM-2 variant capped before the exam date), study queue, cloze
  parsing (`{{answer}}` / `{{answer::hint}}`), stats. Pure functions.
- `js/planner.js` — reading plan: pages × rounds spread over each book's date window, 1/7/21-day
  reviews of read ranges, past-question sessions, today's task list. Pure functions.
- `js/decks.js` — built-in AI-drafted decks (one card per line). Currently 치과재료학 (146 cards).
- `js/app.js` — UI, localStorage persistence, Pomodoro, in-page dialogs.
- `tests/` — `npm test` (Node's built-in runner, no install needed).
- `tools/build_single.py` — bundles everything into one HTML file (`--artifact` for the hosted copy).

## Conventions
- No dependencies and no build step for the app itself; keep it that way.
- All user-facing text is Korean. Use 덱/카드/복습 vocabulary already in the UI.
- `confirm()`, `prompt()`, `alert()` and file downloads are blocked in the hosted artifact: use
  `askConfirm()` / `showModal()` / `toast()`.
- Data lives only in the browser's localStorage (key `exam-study-manager.v1`); backups are JSON
  copied/pasted from 설정.
- Draft deck content is AI-written: keep the "검토 필요" framing and never present it as verified.
  Avoid generating 법규/보건 statistics from memory (they change yearly).

## Publishing
The app is hosted as a private Claude artifact: https://claude.ai/artifact/33zAW1tDZgpd6M4cmmm9kZ
Rebuild with `python3 tools/build_single.py <out.html> --artifact` and republish to that URL.

## Open items
- Draft decks for 교정 → 병리 → 영상 → 치주 (same format as `js/decks.js`), after the user reviews 치재.
- Planner page counts are placeholders (flagged "쪽수 확인") until the user enters real ones.
- Ideas raised but not built: images on cards (영상·병리 판독), 과락 과목군 dashboard.
