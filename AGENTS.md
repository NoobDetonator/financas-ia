# AGENTS.md

## Cursor Cloud specific instructions

Personal-finance app ("Finanças" / KAKEIBO.SYS). Two dev services; standard commands
live in `README.md` and `package.json` scripts. Notes below cover only non-obvious caveats.

### Services / how to run
- API + AI backend: `npm run dev:api` (alias `npm run dev`). Fastify on `http://127.0.0.1:3333`. Runs DB migrations automatically on startup.
- Web frontend: `npm run dev:web` (Vite). Serves the UI and proxies `/api/*` → `:3333` (or root API paths when the built UI is served by Fastify).
- Full stack on one port: `npm run build` then `npm run dev:api` / `npm start` — Fastify serves `web/dist` when it exists.

### Non-obvious gotchas
- Vite is configured for `127.0.0.1` (see `web/vite.config`). Prefer `http://127.0.0.1:3000` for the Vite UI; production-style is `http://127.0.0.1:3333/` after build.
- A `.env` file is required (gitignored; copy from `.env.example`). With auth enabled the server refuses to boot unless `APP_PASSWORD` is set to a real value (not the example `troque-esta-senha`). Never commit real passwords or API keys. For local loopback-only smoke you may set `AUTH_DISABLED=true` only while `HOST` is loopback.
- Data lives in SQLite at `./data/finance.db` (gitignored). `npm run db:seed` loads demo data.
- AI features need `DEEPSEEK_API_KEY` in `.env`. Without it the app runs with the assistant disabled (`aiConfigured: false`).
- No separate linter: `npm run typecheck` (backend) and `npm --prefix web run typecheck` (frontend). Tests: `npm test`.
- `POST /transactions`: `amountCents` must be a positive integer; the debit/credit sign comes from `type` (`expense`/`income`).
