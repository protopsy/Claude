# Exam Study Manager

A browser app for preparing for an exam with study techniques that are backed by research:

| Technique | What the app does |
|---|---|
| **Active recall** | You see only the question, type your answer from memory, then compare it with the real answer. |
| **Spaced repetition** | Every card is rescheduled based on how well you recalled it (Again / Hard / Good / Easy), using an SM-2 scheduler like Anki's. |
| **Exam-aware planning** | Set your exam date. Reviews never land after it, unseen cards are spread over the days left, and the last few days are review-only. |
| **Interleaving** | Study sessions mix cards from all your topics instead of one chapter at a time. |
| **Practice tests** | Randomized exam-style tests with a score. Missed cards can go straight back into today's reviews. |
| **Pomodoro** | A focus/break timer is always in the header (25/5 min, a long break every 4 rounds; all adjustable). |
| **Weak-spot tracking** | Stats show your recall rate, streak, review history and forecast, and the cards you forget most. |

## Getting started

There's nothing to install. Open `index.html` in any modern browser (double-click the file).

If you'd rather serve it locally:

```sh
npm start        # serves on http://localhost:8000 (needs Python 3)
```

Then:
1. **Settings** → enter your exam name and date.
2. **Decks** → make one deck per topic or chapter and add question/answer cards. Use bulk import to paste
   `question :: answer` lines, or two columns copied from a spreadsheet.
3. **Today** → press *Start studying* every day and clear your due cards.

### Keyboard shortcuts (study mode)

- `Enter` in the answer box, or `Space`: reveal the answer
- `1`–`4`: grade Again / Hard / Good / Easy (`Space` = Good)
- `U`: undo the last answer
- `Ctrl+Enter`: add a card while editing a deck

## Your data

Everything is stored in your browser's `localStorage`, on your device only. Use **Settings → Export backup**
regularly. The same JSON file restores your data on another browser or computer.

## Development

```
index.html        page shell
css/styles.css    styling (light and dark mode)
js/core.js        scheduler, queues and statistics: pure functions, no DOM
js/app.js         UI, persistence and Pomodoro timer
tests/            unit tests for core.js
```

```sh
npm test         # runs the unit tests with Node's built-in test runner (Node 18+)
```

There are no dependencies and no build step.
