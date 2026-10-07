// Raumbelegung BWS – Belegungsdienst für Gäste ohne BWS-Konto
// Liest die Raumkalender mit Anwendungsrechten (Client Credentials) aus
// Microsoft Graph und liefert belegt/frei mit Veranstalter, ohne Betreff.
// Node >= 18, keine Abhängigkeiten.

const http = require("http");
const crypto = require("crypto");

const env = (k, d) => process.env[k] ?? d;
const TENANT = env("TENANT_ID");
const CLIENT_ID = env("CLIENT_ID");
const CLIENT_SECRET = env("CLIENT_SECRET");
const GUEST_KEY = env("GUEST_KEY");
const PORT = Number(env("PORT", 8787));
const ORIGINS = env("ALLOWED_ORIGINS", "https://raum.bws-ev.de,https://bws-ev.github.io").split(",").map(s => s.trim());
const ROOMS = env("ROOMS",
  "raum-digi1@bws-ev.de,raum-analog@bws-ev.de,raum-perso@bws-ev.de,raum-systemisch-2og@bws-ev.de,raum-besprechung-2og@bws-ev.de,palmenhaus-cafe@bws-ev.de,palmenhaus-seminar@bws-ev.de,palmenhaus-beratung@bws-ev.de"
).split(",").map(s => s.trim().toLowerCase());
const CACHE_SECONDS = Number(env("CACHE_SECONDS", 180));
const MAX_DAYS = 45;
const TZ = "W. Europe Standard Time";

for (const [k, v] of Object.entries({ TENANT_ID: TENANT, CLIENT_ID, CLIENT_SECRET, GUEST_KEY })) {
  if (!v) { console.error(`Fehlt: ${k}`); process.exit(1); }
}

/* ---------- Token ---------- */
let tok = { value: null, exp: 0 };
async function token() {
  if (tok.value && Date.now() < tok.exp - 60000) return tok.value;
  const body = new URLSearchParams({
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials"
  });
  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body
  });
  if (!r.ok) throw new Error("Token " + r.status + " " + (await r.text()).slice(0, 200));
  const j = await r.json();
  tok = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return tok.value;
}

/* ---------- Graph: calendarView je Raum ---------- */
async function roomEvents(mail, from, to) {
  const t = await token();
  let url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mail)}/calendarView` +
    `?startDateTime=${from}T00:00:00&endDateTime=${to}T00:00:00` +
    `&$select=start,end,showAs,isAllDay,isCancelled,organizer&$top=200&$orderby=start/dateTime`;
  const out = [];
  while (url) {
    const r = await fetch(url, { headers: { Authorization: "Bearer " + t, Prefer: `outlook.timezone="${TZ}"` } });
    if (!r.ok) throw new Error(`${mail}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    for (const e of j.value || []) {
      if (e.isCancelled || e.showAs === "free") continue;
      out.push({
        start: e.start.dateTime.slice(0, 19),
        end: e.end.dateTime.slice(0, 19),
        status: e.showAs === "tentative" ? "tentative" : "busy",
        allDay: !!e.isAllDay,
        who: (e.organizer && e.organizer.emailAddress && e.organizer.emailAddress.name) || ""
      });
    }
    url = j["@odata.nextLink"] || null;
  }
  return out;
}

/* ---------- Cache ---------- */
const cache = new Map(); // key from|to → {at, data}
async function schedule(from, to) {
  const k = from + "|" + to, hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_SECONDS * 1000) return hit.data;
  const entries = await Promise.all(ROOMS.map(async m => [m, await roomEvents(m, from, to)]));
  const data = { generatedAt: new Date().toISOString(), timeZone: TZ, from, to, rooms: Object.fromEntries(entries) };
  cache.set(k, { at: Date.now(), data });
  if (cache.size > 50) cache.delete(cache.keys().next().value);
  return data;
}

/* ---------- HTTP ---------- */
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
function keyOk(k) {
  if (!k || k.length !== GUEST_KEY.length) return false;
  return crypto.timingSafeEqual(Buffer.from(k), Buffer.from(GUEST_KEY));
}
function cors(req, res) {
  const o = req.headers.origin;
  if (o && ORIGINS.includes(o)) {
    res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/health") return send(res, 200, { ok: true });
  if (u.pathname !== "/api/belegung") return send(res, 404, { error: "nicht gefunden" });
  if (!keyOk(u.searchParams.get("key"))) return send(res, 403, { error: "kein gültiger Schlüssel" });

  const from = u.searchParams.get("from"), to = u.searchParams.get("to");
  if (!isDate(from) || !isDate(to)) return send(res, 400, { error: "from/to als YYYY-MM-DD" });
  const days = (Date.parse(to) - Date.parse(from)) / 864e5;
  if (days <= 0 || days > MAX_DAYS) return send(res, 400, { error: `Zeitraum 1–${MAX_DAYS} Tage` });

  try { send(res, 200, await schedule(from, to)); }
  catch (e) { console.error(new Date().toISOString(), e.message); send(res, 502, { error: "Graph nicht erreichbar: " + e.message }); }
}).listen(PORT, "127.0.0.1", () => console.log(`Belegungsdienst auf 127.0.0.1:${PORT}, ${ROOMS.length} Räume`));
