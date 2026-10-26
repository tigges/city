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

const fileStore = {
  async load() {
    try {
      return JSON.parse(await fs.promises.readFile(DATA_FILE, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
  },
  async save(entries) {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${DATA_FILE}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(entries));
    await fs.promises.rename(tmp, DATA_FILE);
  },
};

async function upstash(command) {
  const res = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`Upstash error ${res.status}`);
  return (await res.json()).result;
}

const redisStore = {
  async load() {
    const raw = await upstash(["GET", UPSTASH_KEY]);
    return raw ? JSON.parse(raw) : [];
  },
  async save(entries) {
    await upstash(["SET", UPSTASH_KEY, JSON.stringify(entries)]);
  },
};

const store = UPSTASH_URL && UPSTASH_TOKEN ? redisStore : fileStore;

// All writes go through this chain so concurrent submissions can't clobber each other.
let writeChain = Promise.resolve();
function mutate(fn) {
  const run = writeChain.then(async () => {
    const entries = await store.load();
    const result = await fn(entries);
    await store.save(entries);
    return result;
  });
  writeChain = run.catch(() => {});
  return run;
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
  const hit = results.find((r) => sameCountry(r.country_code, r.country, code, country));
  return hit && { lat: hit.latitude, lon: hit.longitude, country: hit.country };
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
  const result = hit ? { lat: hit.lat, lon: hit.lon, city: displayCity, country: hit.country || countryName } : null;
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

function publicEntry({ clientId, ...rest }) {
  return rest;
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

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 10_000) throw Object.assign(new Error("Request too large"), { status: 413 });
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
  .replaceAll("{{TITLE}}", escapeHtml(APP_TITLE))
  .replaceAll("{{INDUSTRY_REQUIRED}}", String(INDUSTRY_REQUIRED))
  .replaceAll("{{INDUSTRY_HINT}}", INDUSTRY_REQUIRED ? "" : ' <em class="optional">optional</em>');

const loginTemplate = fs
  .readFileSync(path.join(__dirname, "views", "login.html"), "utf8")
  .replaceAll("{{TITLE}}", escapeHtml(APP_TITLE));

const adminHtml = fs
  .readFileSync(path.join(__dirname, "views", "admin.html"), "utf8")
  .replaceAll("{{TITLE}}", escapeHtml(APP_TITLE));

function sendHtml(req, res, status, html) {
  send(res, status, html.replaceAll("{{ORIGIN}}", siteOrigin(req)), { "Content-Type": STATIC_TYPES[".html"], "Cache-Control": "no-cache" });
}

function sendLogin(req, res, status, error = "") {
  sendHtml(req, res, status, loginTemplate.replace("{{ERROR}}", error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ""));
}

async function handleLogin(req, res) {
  if (rateLimited(`login:${clientIp(req)}`)) return sendLogin(req, res, 429, "Too many attempts. Please wait a minute.");
  const form = await readForm(req);
  if (!safeEqual(form.get("password") || "", SITE_PASSWORD)) return sendLogin(req, res, 401, "That password isn't right.");
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.writeHead(303, {
    Location: "/",
    "Set-Cookie": `${AUTH_COOKIE}=${AUTH_TOKEN}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`,
  });
  res.end();
}

// ---------- routes ----------

async function handleApi(req, res, url) {
  if (url.pathname === "/api/entries" && req.method === "GET") {
    const entries = await store.load();
    return send(res, 200, entries.map(publicEntry));
  }

  if (url.pathname === "/api/entries" && req.method === "POST") {
    if (rateLimited(`post:${clientIp(req)}`)) return send(res, 429, { error: "Too many submissions, please wait a minute." });

    const body = await readJson(req);
    const name = clean(body.name, 40);
    const city = clean(body.city, 80);
    const country = clean(body.country, 60);
    const industry = clean(body.industry, 60);
    const clientId = clean(body.clientId, 64);
    if (!name || !city || !country) return send(res, 400, { error: "Please fill in your name, city and country." });
    if (INDUSTRY_REQUIRED && !industry) return send(res, 400, { error: "Please fill in your industry." });

    let place;
    try {
      place = await geocode(city, country);
    } catch {
      return send(res, 502, { error: "Couldn't reach the map service. Please try again." });
    }
    if (!place) return send(res, 422, { error: `We couldn't find "${city}, ${country}". Check the spelling?` });

    const entry = await mutate((entries) => {
      const existing = clientId ? entries.find((e) => e.clientId === clientId) : null;
      const next = {
        id: existing?.id || crypto.randomUUID(),
        name,
        city: place.city,
        country: place.country,
        industry: industry || undefined,
        lat: place.lat,
        lon: place.lon,
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        clientId: clientId || undefined,
      };
      if (existing) entries[entries.indexOf(existing)] = next;
      else {
        if (entries.length >= MAX_ENTRIES) throw Object.assign(new Error("This map is full."), { status: 507 });
        entries.push(next);
      }
      return next;
    });
    return send(res, 201, publicEntry(entry));
  }

  if (url.pathname === "/api/admin/entries" && req.method === "GET") {
    if (!ADMIN_KEY) return send(res, 503, { error: "ADMIN_KEY isn't set on the server." });
    if (!isAdmin(req)) {
      if (rateLimited(`admin:${clientIp(req)}`)) return send(res, 429, { error: "Too many attempts. Please wait a minute." });
      return send(res, 401, { error: "That admin key isn't right." });
    }
    const entries = await store.load();
    return send(res, 200, entries.map(publicEntry));
  }

  const match = url.pathname.match(/^\/api\/entries\/([\w-]+)$/);
  if (match && req.method === "DELETE") {
    const body = await readJson(req);
    const admin = isAdmin(req);
    if (req.headers["x-admin-key"] && !admin) return send(res, 401, { error: "That admin key isn't right." });
    const removed = await mutate((entries) => {
      const i = entries.findIndex((e) => e.id === match[1] && (admin || (body.clientId && e.clientId === body.clientId)));
      if (i === -1) return false;
      entries.splice(i, 1);
      return true;
    });
    return removed ? send(res, 204, "") : send(res, 404, { error: "Entry not found." });
  }

  return send(res, 404, { error: "Not found" });
}

function serveStatic(req, res, url) {
  if (url.pathname === "/" || url.pathname === "/index.html") return sendHtml(req, res, 200, indexHtml);
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
    return serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    send(res, err.status || 500, { error: err.status ? err.message : "Something went wrong." });
  }
});

server.listen(PORT, () => {
  console.log(`Group map running on http://localhost:${PORT} (storage: ${store === redisStore ? "Upstash Redis" : DATA_FILE})`);
  console.log(SITE_PASSWORD ? "Site password is on." : "No SITE_PASSWORD set: anyone with the link can see the map.");
});
