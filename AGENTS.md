# AGENTS.md

## Cursor Cloud specific instructions

Personal-finance app ("Finanças" / KAKEIBO.SYS). Two dev services; standard commands
live in `README.md` and `package.json` scripts. Notes below cover only non-obvious caveats.

### Services / how to run
- API + AI backend: `npm run dev:api` (alias `npm run dev`). Fastify on `http://127.0.0.1:3333`. Runs DB migrations automatically on startup.
- Web frontend: `npm run dev:web` (Vite). Serves the UI and proxies `/api/*` → `:3333`.
- Run both together for the full app. In production `npm run build` + `npm start` serves both on one port (`:3333`).

### Non-obvious gotchas
- The Vite dev server binds to `localhost` (IPv6 `::1`) only, NOT `127.0.0.1`. Open `http://localhost:3000` in the browser/curl; `http://127.0.0.1:3000` gives connection refused.
- A `.env` file is required (gitignored; copy from `.env.example`). With auth enabled the server refuses to boot unless `APP_PASSWORD` is set to a real value (not the example `troque-esta-senha`). The dev login password currently configured is `devpassword123`. Alternatively set `AUTH_DISABLED=true` only while `HOST` is loopback.
- Data lives in SQLite at `./data/finance.db` (gitignored). `npm run db:seed` loads ~12 months of demo data (5 accounts, ~369 transactions).
- AI features need `DEEPSEEK_API_KEY` in `.env`. Without it the app runs normally with the assistant disabled (`aiConfigured: false`).
- No separate linter: `npm run typecheck` (backend) and `npm --prefix web run typecheck` (frontend) are the lint/typecheck step. Tests: `npm test` (node's built-in test runner, ~365 tests).
- `POST /transactions`: `amountCents` must be a positive integer; the debit/credit sign is derived from `type` (`expense`/`income`). Sending a negative amount fails validation.
