// leads-receiver · Deno Deploy entry point
// Receives booking-form POST from mario.grasslms.online and creates a page in the
// Notion "Portfolio leads" database. CORS-locked, honeypot + size guard, no PII logged.
//
// Required env vars (Deno Deploy → Project Settings → Environment Variables):
//   NOTION_TOKEN  - Internal integration secret (ntn_... or secret_...)
//   LEADS_DB_ID   - Notion database id (bf3a5e3cda084e63b5737b74c28408c3)
//
// Routes:
//   POST /         - submit lead (JSON body)
//   GET  /health   - liveness probe

const NOTION_VERSION = "2022-06-28";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_FIELD_LEN  = 4000;

const ALLOWED_ORIGINS = new Set([
  "https://mario.grasslms.online",
  "https://www.mario.grasslms.online",
  "http://localhost:8080",
  "http://localhost:3000",
]);

const TOPICS_WHITELIST = new Set([
  "ID engagement", "AI pipelines", "Internal tooling",
  "LMS / platform", "L&D consulting", "Other",
]);
const BUDGET_WHITELIST = new Set([
  "<€2k", "€2-5k", "€5-10k", "€10-20k", "€20k+", "TBD",
]);
const TIMELINE_WHITELIST = new Set([
  "ASAP", "1-2 weeks", "1 month", "2-3 months", "Exploring",
]);

// --- helpers ----------------------------------------------------------------

function corsHeaders(origin: string): Record<string, string> {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : "https://mario.grasslms.online";
  return {
    "Access-Control-Allow-Origin":  allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age":       "86400",
    "Vary":                          "Origin",
  };
}

function json(body: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function clip(s: unknown, n = MAX_FIELD_LEN): string {
  if (typeof s !== "string") return "";
  const t = s.trim();
  return t.length > n ? t.slice(0, n) : t;
}

function isEmail(s: unknown): boolean {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

type Payload = {
  name?: string;
  email?: string;
  company?: string;
  messenger?: string;
  topics?: string[];
  budget?: string;
  timeline?: string;
  brief?: string;
  hp?: string;
};

function buildNotionProperties(p: Payload): Record<string, unknown> {
  const props: Record<string, unknown> = {
    Name:   { title:     [{ text: { content: clip(p.name, 200) || "Unnamed lead" } }] },
    Email:  { email:     isEmail(p.email) ? (p.email as string).trim() : null },
    Source: { rich_text: [{ text: { content: "portfolio booking form" } }] },
  };
  if (p.company)   props.Company   = { rich_text: [{ text: { content: clip(p.company,   200) } }] };
  if (p.messenger) props.Messenger = { rich_text: [{ text: { content: clip(p.messenger, 200) } }] };
  if (p.brief)     props.Brief     = { rich_text: [{ text: { content: clip(p.brief) } }] };
  if (Array.isArray(p.topics) && p.topics.length) {
    const safe = p.topics.filter((t) => TOPICS_WHITELIST.has(t)).map((name) => ({ name }));
    if (safe.length) props.Topics = { multi_select: safe };
  }
  if (p.budget   && BUDGET_WHITELIST.has(p.budget))     props.Budget   = { select: { name: p.budget   } };
  if (p.timeline && TIMELINE_WHITELIST.has(p.timeline)) props.Timeline = { select: { name: p.timeline } };
  return props;
}

async function handleSubmit(req: Request): Promise<Response> {
  const origin = req.headers.get("Origin") || "";

  if (!ALLOWED_ORIGINS.has(origin)) {
    return json({ ok: false, error: "origin not allowed" }, 403, origin);
  }

  const cl = parseInt(req.headers.get("Content-Length") || "0", 10);
  if (cl && cl > MAX_BODY_BYTES) {
    return json({ ok: false, error: "payload too large" }, 413, origin);
  }

  let payload: Payload;
  try { payload = await req.json(); }
  catch { return json({ ok: false, error: "invalid JSON" }, 400, origin); }

  if (typeof payload?.hp === "string" && payload.hp.trim() !== "") {
    return json({ ok: true, dropped: "honeypot" }, 200, origin);
  }

  if (!clip(payload?.name))     return json({ ok: false, error: "name required" }, 400, origin);
  if (!isEmail(payload?.email)) return json({ ok: false, error: "valid email required" }, 400, origin);

  const NOTION_TOKEN = Deno.env.get("NOTION_TOKEN");
  const LEADS_DB_ID  = Deno.env.get("LEADS_DB_ID");
  if (!NOTION_TOKEN || !LEADS_DB_ID) {
    return json({ ok: false, error: "server not configured" }, 500, origin);
  }

  const body = {
    parent:     { database_id: LEADS_DB_ID },
    properties: buildNotionProperties(payload),
  };

  let notionRes: Response;
  try {
    notionRes = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization":  `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type":   "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("upstream_unreachable", String(err).slice(0, 300));
    return json({ ok: false, error: "upstream unreachable" }, 502, origin);
  }

  if (!notionRes.ok) {
    const txt = await notionRes.text().catch(() => "");
    console.error("notion_error", notionRes.status, txt.slice(0, 500));
    return json({ ok: false, error: "notion api error", status: notionRes.status }, 502, origin);
  }

  const data = await notionRes.json().catch(() => ({}));
  return json({ ok: true, id: (data as { id?: string }).id || null }, 200, origin);
}

// --- entry point ------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const url    = new URL(req.url);
  const origin = req.headers.get("Origin") || "";

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (url.pathname === "/health" && req.method === "GET") {
    return new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } });
  }

  if (url.pathname === "/" && req.method === "POST") {
    return handleSubmit(req);
  }

  return json({ ok: false, error: "not found" }, 404, origin);
});
