# Lyrica

Lyrica is a web-based singing practice app. Frontend is React 19 + TypeScript + Vite 8 + Tailwind CSS v4 at the repo root. Backend is Python 3 + FastAPI in `/backend`.

The current product shape is a one-device two-player battle (best of three lines), with a planned catalog of ElevenLabs-generated songs in Korean, Spanish, and English. Scoring runs in the browser; the backend only exists for commentary and announcer audio.

## Development Server

A Vite dev server is **already running** on `$PORT` (default 8443). Don't start it manually. Hot reload is on.

## Project Structure

Canonical layout. Start with task-relevant files; follow imports only when necessary.

**Frontend**
- `src/main.tsx` — React entry; imports `src/index.css`, mounts `src/App.tsx` into `#root`.
- `src/App.tsx` — Top-level app shell and the SingScreen / RoundResultScreen. Routes between screens via the match reducer.
- `src/screens/` — Per-screen components that are too large to inline (SetupScreen, HandoverScreen, FinalScreen). Add new screens here when they exceed ~150 lines; otherwise keep them in `App.tsx`.
- `src/domain/` — Pure, framework-free logic. `scoring.ts`, `scoring.test.ts`, `match.ts`, `match.test.ts`, `types.ts`.
- `src/data/` — Static practice content (currently `lines.ts`; will become `songs.ts`).
- `src/services/` — Browser-side side-effectful helpers: `microphone.ts`, `pitch.ts`, `audioSession.ts`.
- `src/index.css` — Global CSS + Tailwind v4 import.
- `index.html` — Vite shell.
- `package.json`, `vite.config.ts`, `.mise.toml` — tooling.

**Backend**
- `backend/main.py` — FastAPI app; CORS and welcome endpoint; mounts routers.
- `backend/round_result.py` — `POST /round-result`: Gemini commentary + ElevenLabs TTS with a shared 5s deadline and deterministic fallback.
- `backend/test_round_result.py` — unittest suite; mocks all provider calls.
- `backend/.env.example` — placeholder keys (`GEMINI_API_KEY`, `GEMINI_MODEL`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`, `ELEVENLABS_ROUND_MODEL_ID`, `FRONTEND_ORIGINS`). Real `.env` is gitignored.

## Dependencies

- Runtime: React 19, React DOM 19, `pitchy` (pitch detection).
- Styling: Tailwind CSS v4 via `@tailwindcss/vite`.
- Build: Vite 8, TypeScript 5.7, `@vitejs/plugin-react`.
- Formatting: oxfmt.
- Tests: vitest for frontend; `python -m unittest` for backend.
- Package manager: **pnpm**. Do not introduce npm or yarn commands.

## Styling

Tailwind v4 via the Vite plugin. `src/index.css` does `@import 'tailwindcss';` first; add `@font-face` and global rules below that. No `tailwind.config.*` or PostCSS config needed. Use utilities in JSX; put theme + global CSS in `index.css`.

## Code quality

- Double-quote strings that contain apostrophes (`"We're here"`), or escape in single quotes. An unescaped `'` in a single-quoted string breaks the build.
- Keep JSX balanced; default-export components.
- Prefer small, pure helpers in `src/domain/` over logic inside components.
- `src/domain/scoring.ts` is the pitch scorer. **Do not change scoring behavior or what its tests assert.** Mechanical type renames in fixtures are allowed when types widen.
- `src/domain/match.ts` is the match reducer. Keep it pure. Any new state field needs reducer tests.
- No new runtime deps without a note explaining why. Dev deps are fine when justified.
- Secrets go in `backend/.env` only. Never commit real keys. Never return provider error bodies to the frontend.

## Testing & checks before committing

Frontend:
```sh
pnpm exec tsc --noEmit
pnpm test
pnpm build
pnpm format
```

Backend (from `/backend`):
```sh
python -m unittest discover -v
```

All of the above must pass. If `pnpm format` rewrites a file, re-run `tsc`; the formatter has stripped semicolons from inline type literals in the past.

## Git conventions

- Branch off the latest `main`. Run `git fetch && git pull` first.
- One PR per branch. Keep PRs scoped to a single concern.
- Do not push or open PRs without being asked.
- Never force-push to shared branches. Never bypass hooks.
- Commit messages should explain **why**, not just **what**.

## Live status (keep this short; update as work lands)

**Merged on main:**
- Real microphone capture + pitch sampling (`src/services/microphone.ts`, `src/services/pitch.ts`).
- Pure scorer (`src/domain/scoring.ts`) with vitest coverage.
- FastAPI backend scaffold + `POST /round-result` (Gemini + ElevenLabs, 5s deadline, deterministic fallback).

**In flight:**
- PR #5 (`jas-branch`): one-device battle loop. Adds `src/domain/match.ts`, `src/screens/`, `src/services/audioSession.ts`. Not yet merged.
- `laiba-songs` (not opened yet): replaces `src/data/lines.ts` with `src/data/songs.ts` — three original ElevenLabs songs (ko/es/en), three lines per song, with per-line `audioStart`/`audioEnd`. Threads a selected `Song` into match state. Blocked on PR #5 landing.

## Current task owners

- **Zarif** — pitch ML + TigerGraph work outside this repo. Not available for frontend handoffs.
- **Jasleen** — owns the demo frontend end-to-end after her PR #5 merges. See "Pending work for Jas" below.
- **Laiba** — owns `laiba-songs` + any further backend work.

## Pending work for Jas (post-PR-#5)

Prioritized. Work each on its own branch off latest `main`. Open one PR per item. Don't push without being asked.

1. **Wire `POST /round-result` into the RoundResultScreen.**
   - Call once per completed round with the shape in `backend/round-result.example.json`. `missedSyllables` is an array of **syllable text strings** (map `result.missed` indices to the line's syllable text), not indices.
   - Six-second AbortController timeout on the frontend side (the backend's deadline is 5s; the extra second covers network).
   - On `fallback: true`, missing `audioUrl`, timeout, or non-OK response: show the built-in `fallbackCommentary` text and continue — never block scores or the next-round button on the fetch.
   - On success: show `commentary`, construct `new Audio(audioUrl)` (data URL), and attempt `audio.play().catch(...)`. If autoplay is denied, show a visible Play button that triggers it.
   - Abort on unmount, on round change, and on `GO_HOME`. Ignore stale responses. Pause old audio before starting new.
   - Add a dev-only toggle (`import.meta.env.DEV`) to force the fallback path for testing.

2. **Wire the "Hear it" button on the sing screen.**
   - Blocked until `laiba-songs` lands, since it needs `audioUrl` + `audioStart`/`audioEnd` on each `PracticeLine`.
   - Use a plain `<audio>` ref. Seek to `audioStart`, play, pause at `audioEnd`.
   - Pause and reset on record start.

3. **Fix the two minor battle-flow issues flagged in PR #5 review.**
   - `visibilitychange` listener in `SingScreen` only reacts to `counting`/`recording`. Extend it to `starting` so a tab switch during the mic permission prompt also resets to `ready` with a visible error.
   - `FinalScreen` tiebreak defaults P1 as winner on a 1–1 record. The reducer currently can't produce 1–1, but add an explicit guard or an assertion so a future change can't silently mis-attribute the winner.

4. **Reconcile with `laiba-songs` when it lands.**
   - The match reducer will gain a `song` field. Jas's screens should read `state.song.title` where appropriate (handover copy, final screen) instead of generic text.
   - Pick screen / song picker is Laiba's — do not duplicate.

5. **Demo polish (last).**
   - Make sure iPhone Safari audio works end-to-end over HTTPS before the demo. Localhost HTTP is fine for laptops; phone requires a deployed origin added to `FRONTEND_ORIGINS` in `backend/.env`.
   - Add explicit error UI if `POST /round-result` returns 422 (should not happen in practice but is useful for debugging a mis-wired payload).

## Hard rules

- Never modify `src/domain/scoring.ts` or what `scoring.test.ts` asserts. Mechanical renames in fixtures are fine when types widen.
- Never commit real `.env` values. `backend/.env` is gitignored for a reason.
- Never return provider error bodies or secrets to the frontend. Log error type only.
- Original ElevenLabs output with original lyrics only. No real artist names. No existing songs.
- Vocals-only mp3s (`<id>-vocals.mp3` in `/public/songs/`) are for pitch analysis; full mixes are for playback. If a required file is missing, stop and ask.
