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

const PUBLIC_DIR = path.join(__dirname, "public");
const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
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

// ---------- geocoding (OpenStreetMap Nominatim) ----------

const geoCache = new Map();
let geoChain = Promise.resolve();

async function nominatim(params) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  for (const [k, v] of Object.entries({ format: "jsonv2", limit: "1", addressdetails: "1", "accept-language": "en", ...params })) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: { "User-Agent": "city-group-map/1.0 (https://github.com/tigges/city)" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Geocoder error ${res.status}`);
  const [hit] = await res.json();
  return hit || null;
}

function geocode(city, country) {
  const key = `${city}|${country}`.toLowerCase();
  if (geoCache.has(key)) return Promise.resolve(geoCache.get(key));

  // Nominatim's usage policy allows ~1 request/second, so lookups are serialized.
  const job = geoChain.then(async () => {
    const pause = () => new Promise((r) => setTimeout(r, 1000));
    const lookup = (params) => nominatim(params).catch(() => pause().then(() => nominatim(params)));
    let hit = await lookup({ city, country });
    if (!hit) {
      await pause();
      hit = await lookup({ q: `${city}, ${country}` });
    }
    await pause();
    // Nominatim often names the admin boundary ("Greater London"), so keep the user's own spelling.
    const displayCity = city === city.toLowerCase() ? city.replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase()) : city;
    const result = hit
      ? { lat: Number(hit.lat), lon: Number(hit.lon), city: displayCity, country: hit.address?.country || country }
      : null;
    geoCache.set(key, result);
    return result;
  });
  geoChain = job.catch(() => {});
  return job;
}

// ---------- helpers ----------

const rateBuckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (rateBuckets.get(ip) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  rateBuckets.set(ip, recent);
  return recent.length > 10;
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
  .replaceAll("{{TITLE}}", escapeHtml(APP_TITLE));

// ---------- routes ----------

async function handleApi(req, res, url) {
  if (url.pathname === "/api/entries" && req.method === "GET") {
    const entries = await store.load();
    return send(res, 200, entries.map(publicEntry));
  }

  if (url.pathname === "/api/entries" && req.method === "POST") {
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    if (rateLimited(ip)) return send(res, 429, { error: "Too many submissions, please wait a minute." });

    const body = await readJson(req);
    const name = clean(body.name, 40);
    const city = clean(body.city, 80);
    const country = clean(body.country, 60);
    const clientId = clean(body.clientId, 64);
    if (!name || !city || !country) return send(res, 400, { error: "Please fill in your name, city and country." });

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

  const match = url.pathname.match(/^\/api\/entries\/([\w-]+)$/);
  if (match && req.method === "DELETE") {
    const body = await readJson(req);
    const isAdmin = ADMIN_KEY && req.headers["x-admin-key"] === ADMIN_KEY;
    const removed = await mutate((entries) => {
      const i = entries.findIndex((e) => e.id === match[1] && (isAdmin || (body.clientId && e.clientId === body.clientId)));
      if (i === -1) return false;
      entries.splice(i, 1);
      return true;
    });
    return removed ? send(res, 204, "") : send(res, 404, { error: "Entry not found." });
  }

  return send(res, 404, { error: "Not found" });
}

function serveStatic(req, res, url) {
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return send(res, 200, indexHtml, { "Content-Type": STATIC_TYPES[".html"], "Cache-Control": "no-cache" });
  }
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
});
