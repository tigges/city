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
  const map = L.map("map", { worldCopyJump: true, zoomControl: false }).setView([25, 10], 2);
  L.control.zoom({ position: "topright" }).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const markerLayer = L.layerGroup().addTo(map);
  const markersByPlace = new Map();

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

  function renderMap() {
    markerLayer.clearLayers();
    markersByPlace.clear();
    const shown = visibleEntries();
    const groups = new Map();
    for (const e of shown) {
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
      const place = [first.city, first.region, first.country].filter(Boolean).join(", ");
      const marker = L.marker([first.lat, first.lon], { icon, title: place });
      marker.on("add", () => {
        const span = marker.getElement()?.querySelector(".pin span");
        if (span) span.textContent = label;
      });
      const popup = el("div", {},
        el("div", { className: "popup-place", textContent: group.length > 1 ? `${place} · ${group.length} people` : place }),
        el("ul", { className: "popup-names" }, ...[...group].sort((a, b) => a.name.localeCompare(b.name)).map((e) => {
          const li = el("li", { textContent: [e.name, ...textDetails(e)].join(" · ") });
          for (const a of links(e)) li.append(" · ", a);
          return li;
        })),
      );
      marker.bindPopup(popup);
      marker.addTo(markerLayer);
      markersByPlace.set(key, marker);
    }
    if (fitPending && shown.length) {
      fitPending = false;
      const bounds = L.latLngBounds(shown.map((e) => [e.lat, e.lon]));
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
    const sorted = [...visibleEntries()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const e of sorted) {
      const nameEl = el("strong", { textContent: e.name });
      if (e.id === me.entryId) nameEl.append(el("span", { className: "you-badge", textContent: "YOU" }));
      const btn = el("button", { type: "button", className: "person" },
        el("span", { className: "avatar", textContent: initials(e.name), style: `background:${colorFor(e.city)}` }),
        el("span", { className: "person-text" }, nameEl, el("span", {},
          `${e.city}, ${e.country}`,
          ...FIELDS.filter((f) => f.type !== "link" && valueOf(e, f)).flatMap((f) => [
            " · ",
            el("span", { className: f.id === "industry" ? "industry-tag" : "", textContent: valueOf(e, f) }),
          ]),
        )),
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
    $("add-fab").hidden = !!mine;
  }

  function render() {
    renderFilters();
    renderMap();
    renderList();
    renderMe();
  }

  async function load() {
    try {
      const res = await fetch("/api/entries", { cache: "no-store" });
      if (res.status === 401) return location.reload();
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
