(() => {
  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = "city-map:me";
  const COLORS = ["#4f46e5", "#ec4899", "#0ea5e9", "#f59e0b", "#10b981", "#8b5cf6", "#ef4444", "#14b8a6"];
  const FIELDS = JSON.parse($("config").textContent).fields;

  const me = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") || {};
  if (!me.clientId) {
    me.clientId = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
    saveMe();
  }

  let entries = [];
  let editing = false;
  let fitPending = true;
  let activeIndustry = null;

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

  function toast(message, ms = 2800) {
    const t = $("toast");
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), ms);
  }

  // ---------- countries datalist ----------
  const countryCodes = new Map();
  try {
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const skip = new Set(["EU", "EZ", "UN", "ZZ", "XA", "XB", "QO", "AC", "CP", "DG", "EA", "IC", "TA", "CQ"]);
    const countries = new Set();
    for (const a of letters) for (const b of letters) {
      const code = a + b;
      if (skip.has(code)) continue;
      const n = names.of(code);
      if (n && n !== code) {
        countries.add(n);
        countryCodes.set(n.toLowerCase(), code);
      }
    }
    $("countries").append(...[...countries].sort().map((value) => el("option", { value })));
  } catch {}

  $("industries").append(
    ...["Agriculture", "Arts & Media", "Construction", "Consulting", "Education", "Energy", "Finance", "Government",
      "Healthcare", "Hospitality", "Legal", "Manufacturing", "Marketing", "Non-profit", "Real Estate", "Retail",
      "Student", "Technology", "Transport & Logistics", "Retired"].map((value) => el("option", { value })),
  );

  // ---------- configurable fields ----------
  // With several optional fields the form gets long on a phone, so they go behind "More about you".
  const extraInputs = new Map();
  const optionalCount = FIELDS.filter((f) => f.mode !== "required").length;
  const more = optionalCount >= 2
    ? el("details", { className: "more-fields" }, el("summary", {}, "More about you ", el("em", { className: "optional", textContent: "optional" })))
    : null;
  for (const f of FIELDS) {
    const input = el("input", {
      id: `field-${f.id}`,
      type: f.type === "link" && !f.handleBase ? "url" : "text",
      maxLength: f.type === "link" ? 300 : f.id === "industry" ? 60 : 100,
      placeholder: f.placeholder || "",
      required: f.mode === "required",
    });
    if (f.id === "industry") {
      input.setAttribute("list", "industries");
      input.autocomplete = "organization-title";
    }
    if (f.type === "link") input.inputMode = "url";
    const label = el("span", { textContent: f.label });
    if (f.mode !== "required" && !more) label.append(el("em", { className: "optional", textContent: "optional" }));
    (f.mode !== "required" && more ? more : $("extra-fields")).append(el("label", { className: "field" }, label, input));
    extraInputs.set(f.id, input);
  }
  if (more) $("extra-fields").append(more);

  function valueOf(e, f) {
    return f.id === "industry" ? e.industry : e.extra?.[f.id];
  }

  function textDetails(e) {
    return FIELDS.filter((f) => f.type !== "link").map((f) => valueOf(e, f)).filter(Boolean);
  }

  function links(e) {
    return FIELDS.filter((f) => f.type === "link" && /^https?:\/\//i.test(valueOf(e, f) || ""))
      .map((f) => el("a", { href: valueOf(e, f), target: "_blank", rel: "noopener noreferrer nofollow", textContent: f.label }));
  }

  // ---------- map ----------
  // On phones the map fills most of the screen, so one finger scrolls the page and two fingers move the
  // map (Leaflet's pinch handler pans as well as zooms).
  const coarse = matchMedia("(pointer: coarse)").matches;
  const map = L.map("map", { worldCopyJump: true, zoomControl: false, dragging: !coarse }).setView([25, 10], 2);
  if (coarse) {
    let hintTimer;
    $("map").addEventListener("touchmove", (ev) => {
      if (ev.touches.length !== 1) return;
      $("map-hint").hidden = false;
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => ($("map-hint").hidden = true), 1500);
    }, { passive: true });
    $("map").addEventListener("touchstart", (ev) => {
      if (ev.touches.length > 1) $("map-hint").hidden = true;
    }, { passive: true });
  }
  L.control.zoom({ position: "topright" }).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const markerLayer = L.layerGroup().addTo(map);
  const markersByPlace = new Map();
  const markerForPlace = new Map(); // place key -> its pin or the bubble it's in

  function placeKey(e) {
    return `${e.lat.toFixed(3)},${e.lon.toFixed(3)}`;
  }

  // ---------- industry filter ----------
  // Industry is free text, so "Media, Technology" counts towards both.
  function industryTags(e) {
    return (e.industry || "").split(/[,;/]/).map((t) => t.trim()).filter(Boolean);
  }

  function visibleEntries() {
    if (!activeIndustry) return entries;
    return entries.filter((e) => industryTags(e).some((t) => t.toLowerCase() === activeIndustry));
  }

  function setIndustry(key) {
    activeIndustry = key;
    fitPending = true;
    render();
  }

  function renderFilters() {
    const tags = new Map();
    for (const e of entries) {
      for (const t of new Set(industryTags(e).map((x) => x.toLowerCase()))) {
        const label = industryTags(e).find((x) => x.toLowerCase() === t);
        const tag = tags.get(t) || { label, count: 0 };
        tag.count++;
        tags.set(t, tag);
      }
    }
    if (activeIndustry && !tags.has(activeIndustry)) activeIndustry = null;
    const box = $("filters");
    box.hidden = tags.size < 2;
    if (box.hidden) return box.replaceChildren();
    const chip = (key, label, count) => {
      const b = el("button", { type: "button", className: "chip", textContent: label }, ...(count ? [el("small", { textContent: count })] : []));
      b.setAttribute("aria-pressed", String(activeIndustry === key));
      b.addEventListener("click", () => setIndustry(activeIndustry === key ? null : key));
      return b;
    };
    const sorted = [...tags].sort((a, b) => b[1].count - a[1].count || a[1].label.localeCompare(b[1].label));
    box.replaceChildren(chip(null, "Everyone"), ...sorted.map(([key, t]) => chip(key, t.label, t.count)));
  }

  function placeLabel(e) {
    return [e.city, e.region, e.country].filter(Boolean).join(", ");
  }

  function localTime(timeZone) {
    if (!timeZone) return "";
    try {
      return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone }).format(new Date());
    } catch {
      return "";
    }
  }

  function popupFor(places) {
    const box = el("div", { className: places.length > 1 ? "popup-cluster" : "" });
    const total = places.reduce((n, p) => n + p.people.length, 0);
    if (places.length > 1) box.append(el("div", { className: "popup-place", textContent: `${total} people in ${places.length} places` }));
    for (const p of places) {
      const place = placeLabel(p.people[0]);
      const time = localTime(p.people.find((e) => e.timezone)?.timezone);
      box.append(
        el("div", { className: places.length > 1 ? "popup-sub" : "popup-place", textContent: p.people.length > 1 ? `${place} · ${p.people.length} people` : place }),
        ...(time ? [el("div", { className: "popup-time", textContent: `🕒 ${time} there now` })] : []),
        el("ul", { className: "popup-names" }, ...[...p.people].sort((a, b) => a.name.localeCompare(b.name)).map((e) => {
          const li = el("li", { textContent: [e.name, ...textDetails(e)].join(" · ") });
          for (const a of links(e)) li.append(" · ", a);
          return li;
        })),
      );
    }
    return box;
  }

  // Places closer than this on screen share one bubble, so a zoomed-out map of 40 European cities
  // isn't a pile of overlapping pins. Zooming in splits them up again.
  const CLUSTER_PX = 56;
  let focusKey = null;

  function clusterPlaces(places) {
    const clusters = [];
    for (const p of [...places].sort((a, b) => b.people.length - a.people.length)) {
      const point = map.latLngToLayerPoint([p.lat, p.lon]);
      const near = p.key !== focusKey && clusters.find((c) => !c.focus && c.point.distanceTo(point) < CLUSTER_PX);
      if (near) near.places.push(p);
      else clusters.push({ point, places: [p], focus: p.key === focusKey });
    }
    return clusters;
  }

  function placeMarker(p) {
    const first = p.people[0];
    const icon = L.divIcon({
      className: "pin-icon",
      html: `<div class="pin" style="background:${colorFor(first.city)}"><span></span></div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 34],
      popupAnchor: [0, -32],
    });
    const marker = L.marker([p.lat, p.lon], { icon, title: placeLabel(first) });
    const label = p.people.length > 1 ? String(p.people.length) : initials(first.name);
    marker.on("add", () => {
      const span = marker.getElement()?.querySelector(".pin span");
      if (span) span.textContent = label;
    });
    // Built when opened, so the local time is current.
    marker.bindPopup(() => popupFor([p]));
    markersByPlace.set(p.key, marker);
    return marker;
  }

  function clusterMarker(places) {
    const total = places.reduce((n, p) => n + p.people.length, 0);
    const lat = places.reduce((s, p) => s + p.lat * p.people.length, 0) / total;
    const lon = places.reduce((s, p) => s + p.lon * p.people.length, 0) / total;
    const size = Math.round(36 + Math.min(18, Math.log2(total) * 4));
    const icon = L.divIcon({
      className: "pin-icon",
      html: `<div class="cluster" style="width:${size}px;height:${size}px">${total}</div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
    const names = places.map((p) => p.people[0].city).slice(0, 4).join(", ") + (places.length > 4 ? "…" : "");
    const marker = L.marker([lat, lon], { icon, title: `${total} people: ${names}` });
    const bounds = L.latLngBounds(places.map((p) => [p.lat, p.lon]));
    marker.on("click", () => {
      // Places a few streets apart may never split, so past that point show everyone in one popup.
      if (map.getBoundsZoom(bounds.pad(0.5)) > map.getZoom() && map.getZoom() < 15) {
        map.flyToBounds(bounds.pad(0.5), { duration: 0.6, maxZoom: 15 });
      } else {
        L.popup({ offset: [0, -size / 2] }).setLatLng([lat, lon]).setContent(popupFor(places)).openOn(map);
      }
    });
    return marker;
  }

  function renderMap() {
    const shown = visibleEntries();
    if (fitPending && shown.length) {
      // This can fire zoomend, which renders the markers; the render below then replaces them.
      fitPending = false;
      const bounds = L.latLngBounds(shown.map((e) => [e.lat, e.lon]));
      // Room for bubbles at the edges, the title bar on top and the Add button at the bottom.
      map.fitBounds(bounds, { paddingTopLeft: [48, 72], paddingBottomRight: [48, 72], maxZoom: 6, animate: false });
    }
    const reopen = [...markersByPlace].find(([, m]) => m.isPopupOpen())?.[0];
    markerLayer.clearLayers();
    markersByPlace.clear();
    markerForPlace.clear();
    const places = new Map();
    for (const e of shown) {
      const key = placeKey(e);
      if (!places.has(key)) places.set(key, { key, lat: e.lat, lon: e.lon, people: [] });
      places.get(key).people.push(e);
    }
    for (const c of clusterPlaces(places.values())) {
      const marker = (c.places.length > 1 ? clusterMarker(c.places) : placeMarker(c.places[0])).addTo(markerLayer);
      for (const p of c.places) markerForPlace.set(p.key, marker);
    }
    if (reopen) markersByPlace.get(reopen)?.openPopup();
  }

  map.on("zoomend", renderMap);

  function pulse(keys) {
    for (const marker of new Set(keys.map((k) => markerForPlace.get(k)).filter(Boolean))) {
      const node = marker.getElement()?.querySelector(".pin, .cluster");
      if (!node) continue;
      node.classList.add("pulse");
      setTimeout(() => node.classList.remove("pulse"), 3000);
    }
  }

  function showPeople(people) {
    focusKey = null;
    renderMap();
    map.flyToBounds(L.latLngBounds(people.map((e) => [e.lat, e.lon])).pad(0.3), { duration: 0.8, maxZoom: 10 });
    if (window.innerWidth < 900) $("map").scrollIntoView({ behavior: "smooth" });
  }

  function focusEntry(e) {
    const key = placeKey(e);
    focusKey = key;
    renderMap();
    map.flyTo([e.lat, e.lon], Math.max(map.getZoom(), 6), { duration: 0.8 });
    map.once("moveend", () => markersByPlace.get(key)?.openPopup());
    if (window.innerWidth < 900) $("map").scrollIntoView({ behavior: "smooth" });
  }

  // ---------- list & stats ----------
  const fold = (s) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

  function flag(country) {
    const code = countryCodes.get(country.toLowerCase());
    return code ? String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "";
  }

  function personRow(e) {
    const nameEl = el("strong", { textContent: e.name });
    if (e.id === me.entryId) nameEl.append(el("span", { className: "you-badge", textContent: "YOU" }));
    const btn = el("button", { type: "button", className: "person" },
      el("span", { className: "avatar", textContent: initials(e.name), style: `background:${colorFor(e.city)}` }),
      el("span", { className: "person-text" }, nameEl, el("span", {},
        listOrder === "country" ? e.city : `${e.city}, ${e.country}`,
        ...FIELDS.filter((f) => f.type !== "link" && valueOf(e, f)).flatMap((f) => [
          " · ",
          el("span", { className: f.id === "industry" ? "industry-tag" : "", textContent: valueOf(e, f) }),
        ]),
      )),
    );
    btn.addEventListener("click", () => focusEntry(e));
    return el("li", {}, btn);
  }

  let listOrder = me.listOrder === "country" ? "country" : "newest";

  function setListOrder(order) {
    listOrder = order;
    me.listOrder = order;
    saveMe();
    renderList();
  }

  $("order-newest").addEventListener("click", () => setListOrder("newest"));
  $("order-country").addEventListener("click", () => setListOrder("country"));
  $("list-search").addEventListener("input", () => renderList());

  function renderList() {
    const list = $("people-list");
    if (entries.length < 6) $("list-search").value = "";
    const query = fold($("list-search").value.trim());
    const matches = (e) => !query || fold([e.name, e.city, e.region, e.country, ...textDetails(e)].filter(Boolean).join(" ")).includes(query);
    const shown = visibleEntries().filter(matches);
    $("list-tools").hidden = entries.length < 6;
    $("order-newest").setAttribute("aria-pressed", String(listOrder === "newest"));
    $("order-country").setAttribute("aria-pressed", String(listOrder === "country"));

    if (listOrder === "country") {
      const byCountry = new Map();
      for (const e of shown) {
        if (!byCountry.has(e.country)) byCountry.set(e.country, []);
        byCountry.get(e.country).push(e);
      }
      const groups = [...byCountry].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
      list.replaceChildren(...groups.flatMap(([country, people]) => [
        el("li", { className: "country-head" }, `${flag(country)} ${country}`.trim(), el("small", { textContent: people.length })),
        ...people.sort((a, b) => a.city.localeCompare(b.city) || a.name.localeCompare(b.name)).map(personRow),
      ]));
    } else {
      list.replaceChildren(...[...shown].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(personRow));
    }
    $("no-match").hidden = !(entries.length && !shown.length);
    $("no-match").textContent = query ? `No one matches "${$("list-search").value.trim()}".` : "";
    $("empty").hidden = entries.length > 0;
    const countries = new Set(entries.map((e) => e.country)).size;
    $("stat-people").textContent = entries.length;
    $("stat-cities").textContent = new Set(entries.map(placeKey)).size;
    $("stat-countries").textContent = countries;
    $("map-bar-stats").textContent = entries.length
      ? `${entries.length} ${entries.length === 1 ? "person" : "people"} · ${countries} ${countries === 1 ? "country" : "countries"}`
      : "Be the first to add yourself";
  }

  $("map-bar").addEventListener("click", () => ($("me-card").hidden ? $("entry-form") : $("me-card")).scrollIntoView({ behavior: "smooth" }));

  // ---------- near you ----------
  const MILES = /^en-(US|GB)$/i.test(navigator.language);
  const NEAR_KM = MILES ? 30 * 1.609 : 50;

  function distanceKm(a, b) {
    const rad = Math.PI / 180;
    const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2
      + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
  }

  function formatDistance(km) {
    const n = MILES ? km / 1.609 : km;
    return `${(n < 10 ? Math.round(n * 10) / 10 : Math.round(n)).toLocaleString()} ${MILES ? "miles" : "km"}`;
  }

  function renderNear(mine) {
    const btn = $("near-me");
    const others = entries.filter((e) => e.id !== mine.id).map((e) => ({ e, km: distanceKm(mine, e) }));
    btn.hidden = !others.length;
    if (!others.length) return;
    const near = others.filter((o) => o.km <= NEAR_KM);
    if (near.length) {
      btn.textContent = `📍 ${near.length} ${near.length === 1 ? "person" : "people"} within ${MILES ? "30 miles" : "50 km"} of you`;
      btn.onclick = () => showPeople([mine, ...near.map((o) => o.e)]);
    } else {
      const nearest = others.reduce((a, b) => (b.km < a.km ? b : a));
      btn.textContent = `📍 Nearest: ${nearest.e.name} in ${nearest.e.city}, ${formatDistance(nearest.km)} away`;
      btn.onclick = () => focusEntry(nearest.e);
    }
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
    if (mine) {
      $("me-summary").textContent = `${mine.name} · ${mine.city}, ${mine.country}`;
      renderNear(mine);
    }
    $("add-fab").hidden = !!mine;
  }

  function render() {
    renderFilters();
    renderMap();
    renderList();
    renderMe();
  }

  let loadedOnce = false;

  async function load() {
    try {
      const res = await fetch("/api/entries", { cache: "no-store" });
      if (res.status === 401) return location.reload();
      if (!res.ok) throw new Error();
      const known = new Set(entries.map((e) => e.id));
      entries = await res.json();
      if (me.entryId && !myEntry()) {
        delete me.entryId;
        saveMe();
      }
      render();
      if (loadedOnce) announce(entries.filter((e) => !known.has(e.id) && e.id !== me.entryId));
      loadedOnce = true;
    } catch {
      // keep showing the last known state; next poll will retry
    }
  }

  function announce(joined) {
    if (!joined.length) return;
    const [first] = joined;
    toast(joined.length === 1
      ? `👋 ${first.name} just joined from ${first.city}`
      : `👋 ${first.name} and ${joined.length - 1} ${joined.length === 2 ? "other" : "others"} just joined`, 4500);
    pulse(joined.map(placeKey));
  }

  // ---------- form ----------
  const form = $("entry-form");
  const fields = ["name", "city", "country"].map($);
  const requiredExtra = FIELDS.filter((f) => f.mode === "required").map((f) => extraInputs.get(f.id));
  const requiredFields = [...fields, ...requiredExtra];

  function showError(message) {
    $("form-error").textContent = message;
    $("form-error").hidden = !message;
  }

  function hideChoice() {
    $("form-choice").hidden = true;
    $("choice-buttons").replaceChildren();
  }

  // The server asks a follow-up question (which Springfield? is that you?) as a 409 with a code.
  function showChoice(title, buttons) {
    $("choice-title").textContent = title;
    $("choice-buttons").replaceChildren(...buttons.map(([text, onClick, primary]) => {
      const b = el("button", { type: "button", className: primary ? "btn-choice primary" : "btn-choice", textContent: text });
      b.addEventListener("click", onClick);
      return b;
    }));
    $("form-choice").hidden = false;
    $("form-choice").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  for (const input of [...fields, ...extraInputs.values()]) input.addEventListener("input", hideChoice);

  // ---------- city suggestions ----------
  // Picking a suggestion fills in the country and pins the exact place, so the server doesn't have to
  // guess (or ask "which Springfield?").
  const cityInput = fields[1];
  const suggestList = $("city-suggest");
  let suggestions = [];
  let activeSuggestion = -1;
  let suggested = null; // { lat, lon, city, country } of the picked suggestion
  let suggestTimer;
  let suggestSeq = 0;

  function closeSuggest() {
    suggestList.hidden = true;
    cityInput.setAttribute("aria-expanded", "false");
    cityInput.removeAttribute("aria-activedescendant");
    activeSuggestion = -1;
  }

  function renderSuggest() {
    suggestList.replaceChildren(...suggestions.map((s, i) => {
      const li = el("li", { id: `city-option-${i}`, role: "option", className: i === activeSuggestion ? "active" : "" },
        el("strong", { textContent: s.name }),
        el("span", { textContent: [s.region, s.country].filter((x) => x && x !== s.name).join(", ") }),
      );
      li.setAttribute("aria-selected", String(i === activeSuggestion));
      li.addEventListener("click", () => pickSuggestion(s));
      return li;
    }));
    suggestList.hidden = !suggestions.length;
    cityInput.setAttribute("aria-expanded", String(!!suggestions.length));
    if (activeSuggestion >= 0) cityInput.setAttribute("aria-activedescendant", `city-option-${activeSuggestion}`);
  }

  function pickSuggestion(s) {
    cityInput.value = s.name;
    fields[2].value = s.country;
    suggested = { lat: s.lat, lon: s.lon, city: s.name, country: s.country };
    for (const f of [cityInput, fields[2]]) f.setAttribute("aria-invalid", "false");
    closeSuggest();
    const next = requiredFields.find((f) => !f.value.trim());
    if (next) next.focus();
    else cityInput.blur();
  }

  cityInput.addEventListener("input", () => {
    suggested = null;
    clearTimeout(suggestTimer);
    const q = cityInput.value.trim();
    if (q.length < 2) {
      suggestions = [];
      return closeSuggest();
    }
    suggestTimer = setTimeout(async () => {
      const seq = ++suggestSeq;
      let list = [];
      try {
        const res = await fetch(`/api/places?q=${encodeURIComponent(q)}`);
        if (res.ok) list = await res.json();
      } catch {}
      if (seq !== suggestSeq || cityInput.value.trim() !== q || document.activeElement !== cityInput) return;
      // If the country is already filled in, its places go first.
      const country = fold(fields[2].value.trim());
      suggestions = country ? [...list].sort((a, b) => (fold(b.country) === country) - (fold(a.country) === country)) : list;
      activeSuggestion = -1;
      renderSuggest();
    }, 250);
  });

  cityInput.addEventListener("keydown", (ev) => {
    if (suggestList.hidden) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const n = suggestions.length;
      if (ev.key === "ArrowDown") activeSuggestion = (activeSuggestion + 1) % n;
      else activeSuggestion = activeSuggestion <= 0 ? n - 1 : activeSuggestion - 1;
      renderSuggest();
    } else if (ev.key === "Enter" && activeSuggestion >= 0) {
      ev.preventDefault();
      pickSuggestion(suggestions[activeSuggestion]);
    } else if (ev.key === "Escape") {
      closeSuggest();
    }
  });

  // Keep focus in the input while tapping a suggestion, so blur doesn't close the list first.
  suggestList.addEventListener("pointerdown", (ev) => ev.preventDefault());
  cityInput.addEventListener("blur", () => setTimeout(closeSuggest, 100));
  fields[2].addEventListener("input", () => {
    if (suggested && fold(fields[2].value.trim()) !== fold(suggested.country)) suggested = null;
  });

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    submitEntry();
  });

  async function submitEntry(choice = {}) {
    showError("");
    hideChoice();
    let firstInvalid = null;
    for (const f of requiredFields) {
      const bad = !f.value.trim();
      f.setAttribute("aria-invalid", String(bad));
      if (bad && !firstInvalid) firstInvalid = f;
    }
    if (firstInvalid) {
      showError(requiredExtra.length ? "Please fill in all the fields that aren't marked optional." : "Please fill in your name, city and country.");
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
        body: JSON.stringify({
          name: fields[0].value,
          city: fields[1].value,
          country: fields[2].value,
          fields: Object.fromEntries([...extraInputs].map(([id, input]) => [id, input.value])),
          clientId: me.clientId,
          suggested: suggested && { lat: suggested.lat, lon: suggested.lon },
          ...choice,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.code === "choose_place") {
        return showChoice(data.error, data.options.map((o) => [o.label, () => submitEntry({ ...choice, place: { lat: o.lat, lon: o.lon } })]));
      }
      if (res.status === 409 && data.code === "duplicate") {
        const d = data.duplicate;
        return showChoice(`${d.name} in ${d.city} is already on the map. Is that you?`, [
          ["Yes, that's me: update it", () => submitEntry({ ...choice, claim: d.id }), true],
          ["No, add me as well", () => submitEntry({ ...choice, addAnyway: true })],
        ]);
      }
      if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
      me.entryId = data.id;
      saveMe();
      entries = entries.filter((e) => e.id !== data.id).concat(data);
      editing = false;
      activeIndustry = null;
      render();
      focusEntry(data);
      toast(choice.claim ? "📍 Got it. You can now edit your pin from here too." : `📍 Welcome, ${data.name}! You're on the map.`);
    } catch (err) {
      showError(err.message);
    } finally {
      btn.disabled = false;
      btn.classList.remove("loading");
    }
  }

  for (const f of requiredFields) f.addEventListener("input", () => f.setAttribute("aria-invalid", "false"));

  $("edit-me").addEventListener("click", () => {
    const mine = myEntry();
    if (!mine) return;
    editing = true;
    suggested = null;
    fields[0].value = mine.name;
    fields[1].value = mine.city;
    fields[2].value = mine.country;
    for (const f of FIELDS) extraInputs.get(f.id).value = valueOf(mine, f) || "";
    if (more) more.open = FIELDS.some((f) => f.mode !== "required" && valueOf(mine, f));
    showError("");
    hideChoice();
    renderMe();
    fields[1].focus();
  });

  $("cancel-edit").addEventListener("click", () => {
    editing = false;
    showError("");
    hideChoice();
    renderMe();
  });

  $("remove-me").addEventListener("click", removeMe);
  $("remove-me-card").addEventListener("click", removeMe);

  // The edit link carries this browser's clientId, so opening it elsewhere (Safari vs WhatsApp's
  // in-app browser, or another phone) gives that browser the right to edit the same pin.
  $("copy-edit-link").addEventListener("click", async () => {
    const url = `${location.origin}/?me=${encodeURIComponent(me.clientId)}`;
    const note = "Open this link on another phone or browser to edit your pin there. Keep it to yourself.";
    try {
      if (navigator.share && matchMedia("(pointer: coarse)").matches) {
        await navigator.share({ title: "My edit link", text: note, url });
      } else {
        await navigator.clipboard.writeText(url);
        toast("Edit link copied. Send it to yourself, e.g. in a chat with yourself.");
      }
    } catch (err) {
      if (err.name !== "AbortError") prompt(note, url);
    }
  });

  $("add-fab").addEventListener("click", () => {
    $("entry-form").scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => fields[0].focus({ preventScroll: true }), 400);
  });

  async function removeMe() {
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
  }

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

  async function adoptEditLink() {
    const params = new URLSearchParams(location.search);
    const clientId = params.get("me");
    if (!clientId) return;
    params.delete("me");
    history.replaceState(null, "", location.pathname + ([...params].length ? `?${params}` : "") + location.hash);
    try {
      const res = await fetch("/api/mine", { headers: { "x-client-id": clientId }, cache: "no-store" });
      if (!res.ok) return toast("That edit link doesn't match a pin any more.");
      me.clientId = clientId;
      me.entryId = (await res.json()).id;
      saveMe();
      toast("✓ You can now edit your pin from this browser.");
    } catch {
      toast("Couldn't check your edit link. Please try again.");
    }
  }

  renderMe();
  adoptEditLink().then(load);
  setInterval(() => document.visibilityState === "visible" && load(), 15000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && load());
})();
