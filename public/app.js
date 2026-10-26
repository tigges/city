(() => {
  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = "city-map:me";
  const COLORS = ["#4f46e5", "#ec4899", "#0ea5e9", "#f59e0b", "#10b981", "#8b5cf6", "#ef4444", "#14b8a6"];

  const me = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") || {};
  if (!me.clientId) {
    me.clientId = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
    saveMe();
  }

  let entries = [];
  let editing = false;
  let firstFit = true;

  function saveMe() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(me));
  }

  function colorFor(text) {
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return COLORS[h % COLORS.length];
  }

  function initials(name) {
    return name.split(" ").filter(Boolean).slice(0, 2).map((w) => [...w][0].toUpperCase()).join("");
  }

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    for (const child of children) node.append(child);
    return node;
  }

  function toast(message) {
    const t = $("toast");
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), 2800);
  }

  // ---------- countries datalist ----------
  try {
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const skip = new Set(["EU", "EZ", "UN", "ZZ", "XA", "XB", "QO", "AC", "CP", "DG", "EA", "IC", "TA", "CQ"]);
    const countries = new Set();
    for (const a of letters) for (const b of letters) {
      const code = a + b;
      if (skip.has(code)) continue;
      const n = names.of(code);
      if (n && n !== code) countries.add(n);
    }
    $("countries").append(...[...countries].sort().map((value) => el("option", { value })));
  } catch {}

  // ---------- map ----------
  const map = L.map("map", { worldCopyJump: true, zoomControl: false }).setView([25, 10], 2);
  L.control.zoom({ position: "topright" }).addTo(map);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
    subdomains: "abcd",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
  const markerLayer = L.layerGroup().addTo(map);
  const markersByPlace = new Map();

  function placeKey(e) {
    return `${e.lat.toFixed(3)},${e.lon.toFixed(3)}`;
  }

  function renderMap() {
    markerLayer.clearLayers();
    markersByPlace.clear();
    const groups = new Map();
    for (const e of entries) {
      const key = placeKey(e);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    for (const [key, group] of groups) {
      const first = group[0];
      const label = group.length > 1 ? String(group.length) : initials(first.name);
      const icon = L.divIcon({
        className: "pin-icon",
        html: `<div class="pin" style="background:${colorFor(first.city)}"><span></span></div>`,
        iconSize: [34, 34],
        iconAnchor: [17, 34],
        popupAnchor: [0, -32],
      });
      const marker = L.marker([first.lat, first.lon], { icon, title: `${first.city}, ${first.country}` });
      marker.on("add", () => {
        const span = marker.getElement()?.querySelector(".pin span");
        if (span) span.textContent = label;
      });
      const popup = el("div", {},
        el("div", { className: "popup-place", textContent: `${first.city}, ${first.country}` }),
        el("ul", { className: "popup-names" }, ...group.map((e) => el("li", { textContent: e.name }))),
      );
      marker.bindPopup(popup);
      marker.addTo(markerLayer);
      markersByPlace.set(key, marker);
    }
    if (firstFit && entries.length) {
      firstFit = false;
      const bounds = L.latLngBounds(entries.map((e) => [e.lat, e.lon]));
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 6 });
    }
  }

  function focusEntry(e) {
    map.flyTo([e.lat, e.lon], Math.max(map.getZoom(), 6), { duration: 0.8 });
    markersByPlace.get(placeKey(e))?.openPopup();
    if (window.innerWidth < 900) $("map").scrollIntoView({ behavior: "smooth" });
  }

  // ---------- list & stats ----------
  function renderList() {
    const list = $("people-list");
    list.replaceChildren();
    const sorted = [...entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const e of sorted) {
      const nameEl = el("strong", { textContent: e.name });
      if (e.id === me.entryId) nameEl.append(el("span", { className: "you-badge", textContent: "YOU" }));
      const btn = el("button", { type: "button", className: "person" },
        el("span", { className: "avatar", textContent: initials(e.name), style: `background:${colorFor(e.city)}` }),
        el("span", { className: "person-text" }, nameEl, el("span", { textContent: `${e.city}, ${e.country}` })),
      );
      btn.addEventListener("click", () => focusEntry(e));
      list.append(el("li", {}, btn));
    }
    $("empty").hidden = entries.length > 0;
    $("stat-people").textContent = entries.length;
    $("stat-cities").textContent = new Set(entries.map(placeKey)).size;
    $("stat-countries").textContent = new Set(entries.map((e) => e.country)).size;
  }

  // ---------- my entry ----------
  function myEntry() {
    return entries.find((e) => e.id === me.entryId);
  }

  function renderMe() {
    const mine = myEntry();
    const showForm = !mine || editing;
    $("entry-form").hidden = !showForm;
    $("me-card").hidden = showForm;
    $("me-actions").hidden = !(mine && editing);
    $("form-title").textContent = mine ? "Update your pin" : "Add yourself";
    $("submit").querySelector(".btn-label").textContent = mine ? "Save changes" : "Put me on the map";
    if (mine) $("me-summary").textContent = `${mine.name} · ${mine.city}, ${mine.country}`;
  }

  function render() {
    renderMap();
    renderList();
    renderMe();
  }

  async function load() {
    try {
      const res = await fetch("/api/entries", { cache: "no-store" });
      if (!res.ok) throw new Error();
      entries = await res.json();
      if (me.entryId && !myEntry()) {
        delete me.entryId;
        saveMe();
      }
      render();
    } catch {
      // keep showing the last known state; next poll will retry
    }
  }

  // ---------- form ----------
  const form = $("entry-form");
  const fields = ["name", "city", "country"].map($);

  function showError(message) {
    $("form-error").textContent = message;
    $("form-error").hidden = !message;
  }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    showError("");
    let firstInvalid = null;
    for (const f of fields) {
      const bad = !f.value.trim();
      f.setAttribute("aria-invalid", String(bad));
      if (bad && !firstInvalid) firstInvalid = f;
    }
    if (firstInvalid) {
      showError("Please fill in your name, city and country.");
      firstInvalid.focus();
      return;
    }

    const btn = $("submit");
    btn.disabled = true;
    btn.classList.add("loading");
    try {
      const res = await fetch("/api/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: fields[0].value, city: fields[1].value, country: fields[2].value, clientId: me.clientId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
      me.entryId = data.id;
      saveMe();
      entries = entries.filter((e) => e.id !== data.id).concat(data);
      editing = false;
      render();
      focusEntry(data);
      toast(`📍 Welcome, ${data.name}! You're on the map.`);
    } catch (err) {
      showError(err.message);
    } finally {
      btn.disabled = false;
      btn.classList.remove("loading");
    }
  });

  for (const f of fields) f.addEventListener("input", () => f.setAttribute("aria-invalid", "false"));

  $("edit-me").addEventListener("click", () => {
    const mine = myEntry();
    if (!mine) return;
    editing = true;
    fields[0].value = mine.name;
    fields[1].value = mine.city;
    fields[2].value = mine.country;
    showError("");
    renderMe();
    fields[1].focus();
  });

  $("cancel-edit").addEventListener("click", () => {
    editing = false;
    showError("");
    renderMe();
  });

  $("remove-me").addEventListener("click", async () => {
    const mine = myEntry();
    if (!mine || !confirm("Remove your pin from the map?")) return;
    const res = await fetch(`/api/entries/${mine.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: me.clientId }),
    });
    if (!res.ok && res.status !== 404) return toast("Couldn't remove your pin. Please try again.");
    entries = entries.filter((e) => e.id !== mine.id);
    delete me.entryId;
    saveMe();
    editing = false;
    form.reset();
    render();
    toast("Your pin was removed.");
  });

  // ---------- share ----------
  $("share").addEventListener("click", async () => {
    const url = location.origin + location.pathname;
    const text = "Add yourself to our group map! 🌍";
    if (navigator.share) {
      try {
        await navigator.share({ title: document.title, text, url });
        return;
      } catch (err) {
        if (err.name === "AbortError") return;
      }
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`, "_blank", "noopener");
  });

  renderMe();
  load();
  setInterval(() => document.visibilityState === "visible" && load(), 15000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && load());
})();
