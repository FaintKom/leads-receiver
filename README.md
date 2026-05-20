# leads-receiver

Tiny Bun HTTP service that receives booking-form submissions from
`mario.grasslms.online` and writes them into the Notion **Portfolio leads**
database. Deployed as a standalone Docker container on Hetzner via Coolify,
fully isolated from GrassLMS.

## Endpoints

- `POST /` — submit a lead (JSON body, see payload shape below)
- `GET  /health` — liveness probe for Docker / Coolify

## Payload shape

```json
{
  "name":     "Jane Doe",
  "email":    "jane@acme.com",
  "company":  "ACME Ltd.",
  "messenger":"@janedoe (Telegram)",
  "topics":   ["AI pipelines", "L&D consulting"],
  "budget":   "€5-10k",
  "timeline": "1-2 weeks",
  "brief":    "Free-form message",
  "hp":       ""
}
```

Required: `name`, `email`. Optional: rest.
`topics` / `budget` / `timeline` values must match the whitelists in `server.js`.
`hp` is a honeypot — bots fill it, humans leave empty.

Returns `200 { ok: true, id: "<notion-page-id>" }` on success.
Returns `4xx` for bad request, `5xx` for upstream/config errors.

## Env vars

| Name | Required | Description |
|------|----------|-------------|
| `NOTION_TOKEN` | yes | Internal Integration secret (`ntn_…` / `secret_…`) from notion.so/profile/integrations |
| `LEADS_DB_ID`  | yes | Notion database id without dashes (`bf3a5e3cda084e63b5737b74c28408c3`) |
| `PORT`         | no  | default `3000` |

## Local run

```bash
NOTION_TOKEN=ntn_xxx LEADS_DB_ID=bf3a5e3cda084e63b5737b74c28408c3 bun run server.js

# in another terminal:
curl -X POST http://localhost:3000/ \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:8080" \
  -d '{"name":"Local Test","email":"local@test.com","topics":["AI pipelines"]}'
```

## Coolify deploy (on Hetzner)

**Prereq:** Notion Integration created + connected to the Portfolio leads DB.

1. Push this folder to a new git repo (e.g. `FaintKom/leads-receiver`).
2. Coolify dashboard → **+ New Resource** → **Public Repository** → paste git URL.
3. Build pack: **Dockerfile** (auto-detected).
4. **Environment variables** (Configuration → Environment Variables):
   - `NOTION_TOKEN` = `ntn_…`  (mark as Secret / Encrypted)
   - `LEADS_DB_ID`  = `bf3a5e3cda084e63b5737b74c28408c3`
5. **Domain** — assign subdomain (e.g. `leads.mario.grasslms.online`). Coolify auto-issues Let's Encrypt.
6. **Healthcheck** — already in Dockerfile (`GET /health` every 30s).
7. **Deploy**. Live in ~2 min.

## Test after deploy

```bash
curl -X POST https://leads.mario.grasslms.online/ \
  -H "Content-Type: application/json" \
  -H "Origin: https://mario.grasslms.online" \
  -d '{"name":"Smoke Test","email":"smoke@test.com","topics":["AI pipelines"],"brief":"Deploy smoke test"}'
```

Expect `{"ok":true,"id":"…"}`. Open Notion → Portfolio leads → new "Smoke Test" row visible.

## Security notes

- `NOTION_TOKEN` is server-side only — never exposed to the browser.
- CORS allow-list hardcoded in `server.js`: only `mario.grasslms.online` (+ localhost dev).
- Honeypot `hp` silently drops bot submissions (returns 200 so bots don't retry).
- 16 KB body cap + 4 KB per-field cap.
- Logs contain Notion API error codes + truncated body — no user PII.

## Files

- `server.js` — Bun HTTP handler
- `Dockerfile` — `oven/bun:1-alpine` base, `EXPOSE 3000`, healthcheck on `/health`
- `package.json` — zero runtime deps (uses Bun built-ins)
- `README.md` — this file

## Update flow

Push to main → Coolify rebuilds + redeploys (if webhook enabled).
Otherwise: Coolify dashboard → service → Redeploy.

## Rotate Notion token

1. Notion → Integrations → `portfolio-lead-receiver` → Reset Internal Integration Secret
2. Coolify → Environment Variables → update `NOTION_TOKEN` → Save → Redeploy
