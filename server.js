const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "entries.json");
const APP_TITLE = process.env.APP_TITLE || "Where is everyone?";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const UPSTASH_KEY = process.env.UPSTASH_KEY || "city-map:entries";
const MAX_ENTRIES = 2000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || "";
const INDUSTRY_REQUIRED = /^(1|true|yes)$/i.test(process.env.INDUSTRY_REQUIRED || "");
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
const AUTH_COOKIE = "group_map_auth";
const AUTH_TOKEN = SITE_PASSWORD ? crypto.createHmac("sha256", SITE_PASSWORD).update("group-map-auth").digest("hex") : "";

const PUBLIC_DIR = path.join(__dirname, "public");
const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// ---------- storage ----------

function fileStore(file, empty) {
  return {
    async load() {
      try {
        return JSON.parse(await fs.promises.readFile(file, "utf8"));
      } catch (err) {
        if (err.code === "ENOENT") return empty;
        throw err;
      }
    },
    async save(value) {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(value));
      await fs.promises.rename(tmp, file);
    },
  };
}

async function upstash(command) {
  const res = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`Upstash error ${res.status}`);
  return (await res.json()).result;
}

function redisStore(key, empty) {
  return {
    async load() {
      const raw = await upstash(["GET", key]);
      return raw ? JSON.parse(raw) : empty;
    },
    async save(value) {
      await upstash(["SET", key, JSON.stringify(value)]);
    },
  };
}

const USE_REDIS = !!(UPSTASH_URL && UPSTASH_TOKEN);
const store = USE_REDIS ? redisStore(UPSTASH_KEY, []) : fileStore(DATA_FILE, []);
const settingsStore = USE_REDIS ? redisStore(`${UPSTASH_KEY}:settings`, null) : fileStore(path.join(DATA_DIR, "settings.json"), null);

// All writes go through this chain so concurrent submissions can't clobber each other.
let writeChain = Promise.resolve();
function mutate(fn) {
  const run = writeChain.then(async () => {
    const entries = await store.load();
    const result = await fn(entries);
    if (!result?.conflict) await store.save(entries);
    return result;
  });
  writeChain = run.catch(() => {});
  return run;
}

// ---------- form fields ----------
// Name, city and country are fixed. On top of those come the preset fields below (switched on/off in
// /admin) and up to MAX_CUSTOM_FIELDS fields the admin makes up.
// Industry is stored as entry.industry (the filter uses it); all other answers live in entry.extra.

const FIELD_MODES = ["off", "optional", "required"];
const FIELD_TYPES = ["text", "link"];
const MAX_CUSTOM_FIELDS = 8;
// handleBase lets people type just a handle ("@dana" or "dana") instead of a full link.
const PRESET_FIELDS = [
  { id: "industry", label: "Industry", type: "text", placeholder: "e.g. Finance, Tech, Healthcare" },
  { id: "job-title", label: "Job title", type: "text", placeholder: "e.g. Product designer" },
  { id: "company", label: "Company", type: "text", placeholder: "e.g. Acme Ltd" },
  { id: "linkedin", label: "LinkedIn", type: "link", placeholder: "linkedin.com/in/yourname", handleBase: "https://www.linkedin.com/in/" },
  { id: "instagram", label: "Instagram", type: "link", placeholder: "@yourname", handleBase: "https://www.instagram.com/" },
  { id: "website", label: "Website", type: "link", placeholder: "e.g. yoursite.com" },
  { id: "ask-me-about", label: "Ask me about", type: "text", placeholder: "e.g. hiking, startups, good coffee" },
];
const PRESET_IDS = new Set(PRESET_FIELDS.map((f) => f.id));
const DEFAULT_MODES = { industry: INDUSTRY_REQUIRED ? "required" : "optional" };

// Saved settings only hold modes for presets; labels, types and order always come from PRESET_FIELDS.
function resolveFields(saved) {
  const byId = new Map((saved || []).map((f) => [f.id, f]));
  const presets = PRESET_FIELDS.map((p) => ({ ...p, preset: true, mode: byId.get(p.id)?.mode || DEFAULT_MODES[p.id] || "off" }));
  const custom = (saved || []).filter((f) => !PRESET_IDS.has(f.id)).map((f) => ({ ...f, placeholder: f.type === "link" ? "https://…" : "" }));
  return [...presets, ...custom];
}

function storedFields(fields) {
  return fields.map((f) => (f.preset ? { id: f.id, mode: f.mode } : { id: f.id, label: f.label, type: f.type, mode: f.mode }));
}

let fieldsCache = null;
async function getFields() {
  if (!fieldsCache) fieldsCache = resolveFields((await settingsStore.load())?.fields);
  return fieldsCache;
}

async function activeFields() {
  return (await getFields()).filter((f) => f.mode !== "off");
}

function validateFields(input) {
  if (!Array.isArray(input)) throw badRequest("Invalid fields.");
  const seen = new Set();
  const saved = input.map((f) => {
    const id = String(f?.id || "");
    if (!/^[a-z0-9-]{1,40}$/.test(id) || seen.has(id)) throw badRequest("Invalid field id.");
    seen.add(id);
    if (!FIELD_MODES.includes(f.mode)) throw badRequest("Invalid field setting.");
    if (PRESET_IDS.has(id)) return { id, mode: f.mode };
    const label = clean(f.label, 40);
    if (!label) throw badRequest("Every field needs a name.");
    if (!FIELD_TYPES.includes(f.type)) throw badRequest(`Invalid type for "${label}".`);
    return { id, label, type: f.type, mode: f.mode };
  });
  if (saved.filter((f) => !PRESET_IDS.has(f.id)).length > MAX_CUSTOM_FIELDS) {
    throw badRequest(`You can add up to ${MAX_CUSTOM_FIELDS} of your own fields.`);
  }
  return resolveFields(saved);
}

function normalizeLink(value, handleBase) {
  if (handleBase && /^@?[\w.-]+$/.test(value) && !value.toLowerCase().includes(new URL(handleBase).hostname.replace(/^www\./, ""))) {
    value = handleBase + value.replace(/^@/, "");
  }
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (!/^https?:$/.test(url.protocol) || !url.hostname.includes(".")) return null;
    return url.href.length <= 300 ? url.href : null;
  } catch {
    return null;
  }
}

function restoredEntry(e) {
  if (!e || typeof e !== "object") return null;
  const name = clean(e.name, 60);
  const city = clean(e.city, 80);
  const country = clean(e.country, 60);
  const lat = Number(e.lat);
  const lon = Number(e.lon);
  if (!name || !city || !country || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) return null;
  const extra = {};
  if (e.extra && typeof e.extra === "object") {
    for (const [key, value] of Object.entries(e.extra)) {
      if (/^[a-z0-9-]{1,40}$/.test(key) && clean(value, 300)) extra[key] = clean(value, 300);
    }
  }
  const date = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : new Date().toISOString());
  return {
    id: typeof e.id === "string" && /^[\w-]{1,64}$/.test(e.id) ? e.id : crypto.randomUUID(),
    name,
    city,
    region: clean(e.region, 80) || undefined,
    country,
    industry: clean(e.industry, 100) || undefined,
    extra: Object.keys(extra).length ? extra : undefined,
    lat,
    lon,
    createdAt: date(e.createdAt),
    updatedAt: date(e.updatedAt),
    clientId: clean(e.clientId, 64) || undefined,
    otherClientIds: Array.isArray(e.otherClientIds)
      ? e.otherClientIds.map((c) => clean(c, 64)).filter(Boolean).slice(-MAX_OTHER_CLIENTS)
      : undefined,
  };
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

// ---------- geocoding ----------
// Several free, keyless providers are tried in turn because Nominatim often blocks shared cloud IPs.

const USER_AGENT = "city-group-map/1.0 (https://github.com/tigges/city)";
const COUNTRY_ALIASES = {
  uk: "GB", "great britain": "GB", britain: "GB", england: "GB", scotland: "GB", wales: "GB", "northern ireland": "GB",
  usa: "US", us: "US", america: "US", "united states of america": "US", uae: "AE", holland: "NL",
  russia: "RU", "south korea": "KR", korea: "KR", "north korea": "KP", "czech republic": "CZ", turkey: "TR",
};
const countryCodes = new Map(Object.entries(COUNTRY_ALIASES));
try {
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const a of letters) for (const b of letters) {
    const name = names.of(a + b);
    if (name && name !== a + b && !countryCodes.has(name.toLowerCase())) countryCodes.set(name.toLowerCase(), a + b);
  }
} catch {}

function countryCodeFor(country) {
  const c = country.toLowerCase().replace(/^the\s+/, "").trim();
  if (countryCodes.has(c)) return countryCodes.get(c);
  if (/^[a-z]{2}$/.test(c)) return c.toUpperCase();
  return null;
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, ...headers }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
  return res.json();
}

function sameCountry(code, name, wantCode, wantName) {
  if (wantCode && code) return code.toUpperCase() === wantCode;
  return !!name && name.toLowerCase().includes(wantName.toLowerCase());
}

async function openMeteo(city, country, code) {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.search = new URLSearchParams({ name: city, count: "20", language: "en", format: "json" });
  const { results = [] } = await getJson(url);
  const matches = results.filter((r) => sameCountry(r.country_code, r.country, code, country));
  const hit = matches[0];
  return hit && { lat: hit.latitude, lon: hit.longitude, country: hit.country, options: placeOptions(matches, city) };
}

// When a country has several sizeable places with this name (Springfield, Portland, Frankfurt), the
// visitor is asked which one they mean. Small namesakes (the hamlet called Cambridge) don't count.
function placeOptions(matches, city) {
  const top = matches[0].population || 0;
  const want = city.toLowerCase();
  const seen = new Set();
  const options = [];
  for (const [i, m] of matches.entries()) {
    if (i > 0 && (!m.name.toLowerCase().startsWith(want) || (m.population || 0) < Math.max(top * 0.05, 10_000))) continue;
    const label = [m.name, m.admin1].filter(Boolean).join(", ");
    if (seen.has(label)) continue;
    seen.add(label);
    options.push({ label, region: m.admin1 || "", lat: m.latitude, lon: m.longitude });
  }
  return options.length > 1 ? options.slice(0, 5) : undefined;
}

async function photon(city, country, code) {
  const url = new URL("https://photon.komoot.io/api/");
  url.search = new URLSearchParams({ q: `${city}, ${country}`, limit: "10", lang: "en" });
  const { features = [] } = await getJson(url);
  const hit = features.find((f) => sameCountry(f.properties.countrycode, f.properties.country, code, country));
  return hit && { lat: hit.geometry.coordinates[1], lon: hit.geometry.coordinates[0], country: hit.properties.country };
}

async function nominatim(city, country, code) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.search = new URLSearchParams({ format: "jsonv2", limit: "1", addressdetails: "1", "accept-language": "en", city });
  if (code) url.searchParams.set("countrycodes", code.toLowerCase());
  else url.searchParams.set("country", country);
  const [hit] = await getJson(url);
  return hit && { lat: Number(hit.lat), lon: Number(hit.lon), country: hit.address?.country };
}

const geoCache = new Map();

async function geocode(city, country) {
  const key = `${city}|${country}`.toLowerCase();
  if (geoCache.has(key)) return geoCache.get(key);

  const code = countryCodeFor(country);
  const countryName = code ? new Intl.DisplayNames(["en"], { type: "region" }).of(code) : country;
  let hit = null;
  let failures = 0;
  const providers = [openMeteo, photon, nominatim];
  for (const provider of providers) {
    try {
      hit = await provider(city, country, code);
      if (hit) break;
    } catch (err) {
      failures++;
      console.warn(`Geocoder ${provider.name} failed for "${city}, ${country}": ${err.message}`);
    }
  }
  if (!hit && failures === providers.length) throw new Error("All geocoders failed");

  const displayCity = city === city.toLowerCase() ? city.replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase()) : city;
  const result = hit ? { lat: hit.lat, lon: hit.lon, city: displayCity, country: hit.country || countryName, options: hit.options } : null;
  geoCache.set(key, result);
  return result;
}

// ---------- helpers ----------

const rateBuckets = new Map();
function rateLimited(key) {
  const now = Date.now();
  const recent = (rateBuckets.get(key) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  rateBuckets.set(key, recent);
  return recent.length > 10;
}

function clientIp(req) {
  return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function isAuthed(req) {
  if (!SITE_PASSWORD) return true;
  const cookies = Object.fromEntries(
    (req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter(([k]) => k).map(([k, ...v]) => [k, v.join("=")]),
  );
  return !!cookies[AUTH_COOKIE] && safeEqual(cookies[AUTH_COOKIE], AUTH_TOKEN);
}

function isAdmin(req) {
  return !!ADMIN_KEY && safeEqual(req.headers["x-admin-key"] || "", ADMIN_KEY);
}

// Link previews (WhatsApp etc.) need an absolute og:image URL.
function siteOrigin(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`).split(",")[0].trim();
  return `${proto}://${host.replace(/[^\w.:-]/g, "")}`;
}

async function readForm(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 10_000) throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function clean(value, max) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

// Answers to fields that are switched off are kept, but only admins see them.
// An entry can be edited from several browsers (e.g. WhatsApp's in-app browser and Safari), so besides
// the clientId it was created with it may carry otherClientIds that were added via "That's me".
const MAX_OTHER_CLIENTS = 5;

function ownedBy(entry, clientId) {
  return !!clientId && (entry.clientId === clientId || !!entry.otherClientIds?.includes(clientId));
}

function sameName(a, b) {
  const norm = (s) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}

function near(a, b, tolerance = 0.01) {
  return Math.abs(a.lat - b.lat) < tolerance && Math.abs(a.lon - b.lon) < tolerance;
}

function publicEntry({ clientId, otherClientIds, ...rest }, active) {
  if (!active) return rest;
  const out = { ...rest };
  delete out.extra;
  if (!active.some((f) => f.id === "industry")) delete out.industry;
  const extra = Object.fromEntries(active.filter((f) => rest.extra?.[f.id]).map((f) => [f.id, rest.extra[f.id]]));
  if (Object.keys(extra).length) out.extra = extra;
  return out;
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(status, {
    "Content-Type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readJson(req, maxBytes = 10_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const indexHtml = fs
  .readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8")
  .replaceAll("{{TITLE}}", escapeHtml(APP_TITLE));

function jsonForHtml(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const loginTemplate = fs
  .readFileSync(path.join(__dirname, "views", "login.html"), "utf8")
  .replaceAll("{{TITLE}}", escapeHtml(APP_TITLE));

const adminHtml = fs
  .readFileSync(path.join(__dirname, "views", "admin.html"), "utf8")
  .replaceAll("{{TITLE}}", escapeHtml(APP_TITLE));

function sendHtml(req, res, status, html) {
  send(res, status, html.replaceAll("{{ORIGIN}}", siteOrigin(req)), { "Content-Type": STATIC_TYPES[".html"], "Cache-Control": "no-cache" });
}

// Where to go after logging in, so links like a personal edit link survive the password page.
function safeNext(value) {
  const s = String(value || "");
  return s.startsWith("/") && !s.startsWith("//") && !s.includes("\\") && !s.startsWith("/login") && s.length <= 300 ? s : "/";
}

function sendLogin(req, res, status, error = "", next = req.url) {
  const html = loginTemplate
    .replace("{{ERROR}}", error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : "")
    .replace("{{NEXT}}", escapeHtml(safeNext(next)));
  sendHtml(req, res, status, html);
}

async function handleLogin(req, res) {
  const form = await readForm(req);
  const next = safeNext(form.get("next"));
  if (rateLimited(`login:${clientIp(req)}`)) return sendLogin(req, res, 429, "Too many attempts. Please wait a minute.", next);
  if (!safeEqual(form.get("password") || "", SITE_PASSWORD)) return sendLogin(req, res, 401, "That password isn't right.", next);
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.writeHead(303, {
    Location: next,
    "Set-Cookie": `${AUTH_COOKIE}=${AUTH_TOKEN}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`,
  });
  res.end();
}

// ---------- routes ----------

async function handleApi(req, res, url) {
  if (url.pathname === "/api/entries" && req.method === "GET") {
    const [entries, active] = await Promise.all([store.load(), activeFields()]);
    return send(res, 200, entries.map((e) => publicEntry(e, active)));
  }

  if (url.pathname === "/api/entries" && req.method === "POST") {
    if (rateLimited(`post:${clientIp(req)}`)) return send(res, 429, { error: "Too many submissions, please wait a minute." });

    const body = await readJson(req);
    const name = clean(body.name, 60);
    const city = clean(body.city, 80);
    const country = clean(body.country, 60);
    const clientId = clean(body.clientId, 64);
    if (!name || !city || !country) return send(res, 400, { error: "Please fill in your name, city and country." });

    const active = await activeFields();
    const answers = {};
    for (const f of active) {
      // Pages opened before the field settings existed send industry at the top level.
      let value = clean(body.fields?.[f.id] ?? (f.id === "industry" ? body.industry : ""), f.type === "link" ? 300 : 100);
      if (value && f.type === "link" && !(value = normalizeLink(value, f.handleBase))) {
        return send(res, 400, { error: `"${f.label}" needs to be a web address, like ${f.handleBase ? f.placeholder : "example.com"}.` });
      }
      if (!value && f.mode === "required") return send(res, 400, { error: `Please fill in ${f.label}.` });
      answers[f.id] = value;
    }

    let place;
    try {
      place = await geocode(city, country);
    } catch {
      return send(res, 502, { error: "Couldn't reach the map service. Please try again." });
    }
    if (!place) return send(res, 422, { error: `We couldn't find "${city}, ${country}". Check the spelling?` });

    const chosen = body.place && Number.isFinite(Number(body.place.lat)) && Number.isFinite(Number(body.place.lon))
      ? { lat: Number(body.place.lat), lon: Number(body.place.lon) }
      : null;

    const result = await mutate((entries) => {
      let existing = clientId ? entries.find((e) => ownedBy(e, clientId)) : null;

      let { lat, lon } = place;
      let region;
      if (place.options) {
        // Keep the earlier choice when someone edits their pin without changing the city.
        const option = place.options.find((o) => (chosen && near(o, chosen, 0.001)) || (!chosen && existing && near(o, existing)));
        if (!option) {
          if (chosen) throw badRequest("Please pick one of the places in the list.");
          return { conflict: { code: "choose_place", error: `There's more than one ${city}. Which one do you mean?`, options: place.options } };
        }
        ({ lat, lon, region } = option);
      }

      if (!existing) {
        const twin = entries.find((e) => sameName(e.name, name) && near(e, { lat, lon }, 0.05));
        if (twin && body.claim === twin.id) {
          twin.otherClientIds = [...(twin.otherClientIds || []), clientId].filter(Boolean).slice(-MAX_OTHER_CLIENTS);
          existing = twin;
        } else if (twin && !body.addAnyway) {
          return { conflict: { code: "duplicate", error: `${twin.name} in ${twin.city} is already on the map.`, duplicate: { id: twin.id, name: twin.name, city: twin.city } } };
        }
      }

      // Claiming from a new browser usually comes with the optional fields left empty; keep what's there.
      if (body.claim && existing) for (const id of Object.keys(answers)) if (!answers[id]) delete answers[id];
      const { industry = existing?.industry, ...rest } = answers;
      const extra = { ...existing?.extra, ...rest };
      for (const key of Object.keys(extra)) if (!extra[key]) delete extra[key];
      const next = {
        id: existing?.id || crypto.randomUUID(),
        // "That's me" from a new browser shouldn't turn "Charles Tigges" into "charles tigges".
        name: body.claim && existing && sameName(existing.name, name) ? existing.name : name,
        city: place.city,
        region: region || undefined,
        country: place.country,
        industry: industry || undefined,
        extra: Object.keys(extra).length ? extra : undefined,
        lat,
        lon,
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        clientId: existing?.clientId || clientId || undefined,
        otherClientIds: existing?.otherClientIds?.length ? existing.otherClientIds : undefined,
      };
      if (existing) entries[entries.indexOf(existing)] = next;
      else {
        if (entries.length >= MAX_ENTRIES) throw Object.assign(new Error("This map is full."), { status: 507 });
        entries.push(next);
      }
      return next;
    });
    if (result.conflict) return send(res, 409, result.conflict);
    return send(res, 201, publicEntry(result, active));
  }

  if (url.pathname === "/api/mine" && req.method === "GET") {
    const clientId = clean(req.headers["x-client-id"], 64);
    const mine = clientId && (await store.load()).find((e) => ownedBy(e, clientId));
    return mine ? send(res, 200, { id: mine.id }) : send(res, 404, { error: "No pin found for this link." });
  }

  if (url.pathname.startsWith("/api/admin/")) {
    if (!ADMIN_KEY) return send(res, 503, { error: "ADMIN_KEY isn't set on the server." });
    if (!isAdmin(req)) {
      if (rateLimited(`admin:${clientIp(req)}`)) return send(res, 429, { error: "Too many attempts. Please wait a minute." });
      return send(res, 401, { error: "That admin key isn't right." });
    }
    if (url.pathname === "/api/admin/entries" && req.method === "GET") {
      const entries = await store.load();
      return send(res, 200, entries.map((e) => publicEntry(e)));
    }
    if (url.pathname === "/api/admin/fields" && req.method === "GET") {
      return send(res, 200, { fields: await getFields(), maxCustom: MAX_CUSTOM_FIELDS });
    }
    if (url.pathname === "/api/admin/fields" && req.method === "PUT") {
      const fields = validateFields((await readJson(req)).fields);
      await settingsStore.save({ fields: storedFields(fields) });
      fieldsCache = fields;
      return send(res, 200, { fields, maxCustom: MAX_CUSTOM_FIELDS });
    }
    if (url.pathname === "/api/admin/backup" && req.method === "GET") {
      const [entries, fields] = await Promise.all([store.load(), getFields()]);
      const backup = { app: "group-map", version: 1, exportedAt: new Date().toISOString(), fields: storedFields(fields), entries };
      return send(res, 200, backup, { "Content-Disposition": `attachment; filename="group-map-backup-${backup.exportedAt.slice(0, 10)}.json"` });
    }
    if (url.pathname === "/api/admin/restore" && req.method === "POST") {
      const backup = await readJson(req, 5_000_000);
      if (backup?.app !== "group-map" || !Array.isArray(backup.entries)) throw badRequest("That file isn't a group map backup.");
      const fields = validateFields(Array.isArray(backup.fields) ? backup.fields : []);
      const ids = new Set();
      const restored = [];
      for (const raw of backup.entries.slice(0, MAX_ENTRIES)) {
        const e = restoredEntry(raw);
        if (!e || ids.has(e.id)) continue;
        ids.add(e.id);
        restored.push(e);
      }
      await mutate((entries) => entries.splice(0, entries.length, ...restored));
      await settingsStore.save({ fields: storedFields(fields) });
      fieldsCache = fields;
      return send(res, 200, { restored: restored.length, skipped: backup.entries.length - restored.length });
    }
  }

  const match = url.pathname.match(/^\/api\/entries\/([\w-]+)$/);
  if (match && req.method === "DELETE") {
    const body = await readJson(req);
    const admin = isAdmin(req);
    if (req.headers["x-admin-key"] && !admin) return send(res, 401, { error: "That admin key isn't right." });
    const removed = await mutate((entries) => {
      const i = entries.findIndex((e) => e.id === match[1] && (admin || ownedBy(e, clean(body.clientId, 64))));
      if (i === -1) return false;
      entries.splice(i, 1);
      return true;
    });
    return removed ? send(res, 204, "") : send(res, 404, { error: "Entry not found." });
  }

  return send(res, 404, { error: "Not found" });
}

async function serveStatic(req, res, url) {
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return sendHtml(req, res, 200, indexHtml.replace("{{CONFIG}}", jsonForHtml({ fields: await activeFields() })));
  }
  if (url.pathname === "/admin") return sendHtml(req, res, 200, adminHtml);
  const filePath = path.normalize(path.join(PUBLIC_DIR, url.pathname));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, "Not found");
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, "Not found");
    send(res, 200, data, {
      "Content-Type": STATIC_TYPES[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "public, max-age=300",
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/healthz") return send(res, 200, "ok");
    if (SITE_PASSWORD) {
      if (url.pathname === "/login" && req.method === "POST") return await handleLogin(req, res);
      const isAsset = /\.(css|svg|png|ico)$/.test(url.pathname);
      if (!isAsset && !isAuthed(req) && !isAdmin(req)) {
        if (url.pathname.startsWith("/api/")) return send(res, 401, { error: "Please enter the group password first." });
        return sendLogin(req, res, 200);
      }
    }
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
    return await serveStatic(req, res, url);
  } catch (err) {
    if (!err.status) console.error(err);
    send(res, err.status || 500, { error: err.status ? err.message : "Something went wrong." });
  }
});

server.listen(PORT, () => {
  console.log(`Group map running on http://localhost:${PORT} (storage: ${USE_REDIS ? "Upstash Redis" : DATA_FILE})`);
  console.log(SITE_PASSWORD ? "Site password is on." : "No SITE_PASSWORD set: anyone with the link can see the map.");
});
