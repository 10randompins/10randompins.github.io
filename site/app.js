/* 10 Random Pins: pick a country, drop 10 weighted-random pins, tour them in Street View. */
(() => {
  "use strict";

  const CFG = Object.assign({ googleMapsApiKey: "", mapId: "DEMO_MAP_ID", thumbnails: true }, window.TRP_CONFIG || {});
  const KEY_STORE = "trp_google_key";
  const PIN_COUNT = 10;
  const MAX_LOOKUPS = 90;      // Street View lookups per drop before giving up
  const CONCURRENCY = 4;
  const AUTOPLAY_MS = 7000;

  // Place bitmask (see tools/build_data.py) and how often each tier is chosen.
  const TIERS = [
    { bit: 1, weight: 0.55, label: "Metro" },
    { bit: 2, weight: 0.20, label: "Near metro" },
    { bit: 4, weight: 0.15, label: "Landmark" },
    { bit: 8, weight: 0.10, label: "Small region" },
  ];

  // Countries with broad official Street View coverage, used by "Surprise me".
  const SV_GOOD = new Set(("US CA MX BR AR CL CO PE EC UY BO GT DO PR GB IE FR ES PT IT DE NL BE LU CH AT DK NO SE FI IS " +
    "EE LV LT PL CZ SK HU SI HR RS ME AL MK BG RO GR TR UA JP KR TW TH MY SG ID PH KH LK BD BT MN KZ KG IL JO AE " +
    "ZA BW LS SZ KE UG NG GH SN TN AU NZ AD MC MT CY IN RU").split(" "));

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Flag emoji don't render on Windows, so use small flag images instead.
  const flag = (iso) => `<img class="flag" src="https://flagcdn.com/w40/${iso.toLowerCase()}.png" alt="" loading="lazy" onerror="this.remove()">`;

  const state = {
    key: "",
    map: null, sv: null, pano: null,
    index: [], byIso: new Map(), borders: new Map(), pools: new Map(),
    selected: null, hovered: null,
    results: [], markers: [], running: false, runId: 0,
    viewerIndex: 0, autoplay: null,
  };

  /* ---------------------------------------------------------------- boot */

  function boot() {
    state.key = (CFG.googleMapsApiKey || safeGet(KEY_STORE) || "").trim();
    if (!state.key) return showSetup();
    loadGoogle(state.key);
  }

  function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function safeSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } }

  function showSetup(message) {
    $("setup").hidden = false;
    if (message) toast(message, 6000);
    $("keyInput").focus();
  }

  $("setupForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const k = $("keyInput").value.trim();
    if (!k) return;
    safeSet(KEY_STORE, k);
    location.reload();
  });

  // Google calls this when the key is rejected.
  window.gm_authFailure = () => {
    if (!CFG.googleMapsApiKey) safeSet(KEY_STORE, null);
    showSetup("Google rejected that API key. Check that Maps JavaScript API is enabled and the key allows this URL.");
  };

  function loadGoogle(key) {
    window.__trpInit = init;
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&libraries=marker,geometry&loading=async&callback=__trpInit`;
    s.async = true;
    s.onerror = () => toast("Couldn't load Google Maps. Check your connection.", 6000);
    document.head.appendChild(s);
  }

  async function init() {
    const g = google.maps;
    state.map = new g.Map($("map"), {
      center: { lat: 25, lng: 10 }, zoom: 2.6, minZoom: 2,
      mapId: CFG.mapId || "DEMO_MAP_ID",
      colorScheme: g.ColorScheme ? g.ColorScheme.DARK : undefined,
      disableDefaultUI: true, zoomControl: true, gestureHandling: "greedy",
      clickableIcons: false, isFractionalZoomEnabled: true,
    });
    state.sv = new g.StreetViewService();

    const [index, borders] = await Promise.all([
      fetch("data/index.json").then((r) => r.json()),
      fetch("data/countries.geojson").then((r) => r.json()),
    ]);
    state.index = index;
    index.forEach((c) => state.byIso.set(c.iso, c));
    borders.features.forEach((f) => state.borders.set(f.properties.iso, f));

    state.map.data.addGeoJson(borders, { idPropertyName: "iso" });
    state.map.data.setStyle(styleFeature);
    state.map.data.addListener("mouseover", (e) => { state.hovered = e.feature.getId(); state.map.data.revertStyle(); state.map.data.overrideStyle(e.feature, hoverStyle(e.feature)); });
    state.map.data.addListener("mouseout", () => { state.hovered = null; state.map.data.revertStyle(); });
    state.map.data.addListener("click", (e) => {
      const iso = e.feature.getId();
      if (state.byIso.has(iso)) selectCountry(iso, true);
    });

    setupCombo();
    const fromHash = decodeURIComponent(location.hash.slice(1)).toUpperCase();
    if (state.byIso.has(fromHash)) selectCountry(fromHash, true);
  }

  function styleFeature(f) {
    const iso = f.getId();
    const selected = iso === state.selected;
    const usable = state.byIso.has(iso);
    return {
      clickable: usable,
      cursor: usable ? "pointer" : "default",
      fillColor: "#ff5a5f",
      fillOpacity: selected ? 0.10 : 0,
      strokeColor: selected ? "#ff5a5f" : "#ffffff",
      strokeOpacity: selected ? 0.95 : 0.12,
      strokeWeight: selected ? 2 : 0.7,
      zIndex: selected ? 2 : 1,
    };
  }
  function hoverStyle(f) {
    return f.getId() === state.selected ? {} : { fillOpacity: 0.16, strokeOpacity: 0.6, strokeColor: "#ff8a4c", strokeWeight: 1.4 };
  }

  /* ------------------------------------------------------------ combobox */

  function setupCombo() {
    const input = $("countryInput"), list = $("countryList"), clear = $("comboClear");
    let active = -1, items = [];

    const render = () => {
      const q = input.value.trim().toLowerCase();
      items = state.index.filter((c) => !q || c.name.toLowerCase().includes(q) || c.iso.toLowerCase() === q)
        .sort((a, b) => (q && a.name.toLowerCase().startsWith(q) ? 0 : 1) - (q && b.name.toLowerCase().startsWith(q) ? 0 : 1) || a.name.localeCompare(b.name));
      list.innerHTML = "";
      if (!items.length) list.appendChild(el("li", "empty", "No matching country"));
      items.slice(0, 250).forEach((c, i) => {
        const li = el("li", null, `${flag(c.iso)}<span>${esc(c.name)}</span>` +
          (SV_GOOD.has(c.iso) ? "" : `<span class="meta">limited coverage</span>`));
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", String(i === active));
        li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(c.iso); });
        list.appendChild(li);
      });
    };
    const open = () => { list.hidden = false; input.setAttribute("aria-expanded", "true"); render(); };
    const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); active = -1; };
    const choose = (iso) => { close(); input.blur(); selectCountry(iso, true); };

    input.addEventListener("focus", () => { input.select(); open(); });
    input.addEventListener("input", () => { active = 0; open(); clear.hidden = !input.value; });
    input.addEventListener("blur", () => setTimeout(close, 100));
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (list.hidden) open();
        active = Math.max(0, Math.min(items.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)));
        render();
        list.children[active]?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        e.preventDefault();
        const c = items[Math.max(active, 0)];
        if (c) choose(c.iso);
      } else if (e.key === "Escape") { close(); input.blur(); }
    });
    clear.addEventListener("click", () => { input.value = ""; clear.hidden = true; input.focus(); });
  }

  /* ----------------------------------------------------------- selection */

  function selectCountry(iso, fly) {
    const c = state.byIso.get(iso);
    if (!c) return;
    state.selected = iso;
    $("countryInput").value = c.name;
    $("comboClear").hidden = false;
    $("dropBtn").disabled = false;
    $("dropBtn").querySelector(".btn-label").textContent = `Drop 10 pins in ${c.name}`;
    history.replaceState(null, "", "#" + iso);
    state.map.data.setStyle(styleFeature);
    if (fly) fitCountry(iso);
    getPool(iso); // warm the cache
  }

  // Zoom to the country's largest landmass so far-flung islands don't shrink the view.
  function fitCountry(iso) {
    const f = state.borders.get(iso);
    if (!f) return;
    let best = null, bestArea = -1;
    for (const poly of f.geometry.coordinates) {
      const b = ringBounds(poly[0]);
      const area = (b.e - b.w) * (b.n - b.s);
      if (area > bestArea) { bestArea = area; best = b; }
    }
    // Include other polygons that are reasonably large and nearby (e.g. Japan's islands).
    for (const poly of f.geometry.coordinates) {
      const b = ringBounds(poly[0]);
      const area = (b.e - b.w) * (b.n - b.s);
      const near = b.w < best.e + 8 && b.e > best.w - 8 && b.s < best.n + 8 && b.n > best.s - 8;
      if (area > bestArea * 0.04 && near) { best.w = Math.min(best.w, b.w); best.e = Math.max(best.e, b.e); best.s = Math.min(best.s, b.s); best.n = Math.max(best.n, b.n); }
    }
    state.map.fitBounds({ west: best.w, east: best.e, south: best.s, north: best.n }, mapPadding());
  }
  function ringBounds(ring) {
    let w = 180, e = -180, s = 90, n = -90;
    for (const [x, y] of ring) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
    return { w, e, s, n };
  }
  function mapPadding() {
    const small = innerWidth <= 720;
    const stripUp = !$("strip").hidden;
    return small
      ? { top: 190, left: 20, right: 20, bottom: stripUp ? 300 : 20 }
      : { top: 40, left: 420, right: 60, bottom: stripUp ? 330 : 40 };
  }

  async function getPool(iso) {
    if (!state.pools.has(iso)) {
      state.pools.set(iso, fetch(`data/c/${iso}.json`).then((r) => {
        if (!r.ok) throw new Error("missing pool");
        return r.json();
      }).then((d) => {
        const S = d.strings;
        d.towns = d.places.map(([lat, lng, pop, mask, n, r, m, l], i) => ({
          i, lat, lng, pop, mask, name: S[n], region: S[r], metro: S[m], landmark: S[l],
          w: Math.pow(pop, 0.5),
        }));
        d.hasMetro = d.towns.some((t) => t.mask & 3);
        return d;
      }));
    }
    return state.pools.get(iso);
  }

  /* -------------------------------------------------------------- sampler */

  function km(a, b) {
    const R = 6371, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function weightedPick(arr, w) {
    let total = 0;
    for (const x of arr) total += w(x);
    let r = Math.random() * total;
    for (const x of arr) { r -= w(x); if (r <= 0) return x; }
    return arr[arr.length - 1];
  }

  // Picks a tier by weight, then a town in it weighted by sqrt(population),
  // avoiding towns already tried and towns too close to pins already placed.
  function pickTown(pool, ctx) {
    for (let relax = 0; relax < 6; relax++) {
      const minSep = ctx.minSep / Math.pow(2, relax);
      const ok = (t) => !ctx.tried.has(t.i) && ctx.placed.every((p) => km(p, t) >= minSep);
      const tiers = TIERS.map((tier) => ({ tier, towns: pool.towns.filter((t) => (t.mask & tier.bit) && ok(t)) }))
        .filter((x) => x.towns.length);
      if (!tiers.length) continue;
      // With no major metro (e.g. Belize), "anywhere in a town" leads instead of trailing.
      const weight = (x) => (x.tier.bit === 8 && !pool.hasMetro ? 0.6 : x.tier.weight);
      const { tier, towns } = weightedPick(tiers, weight);
      const town = weightedPick(towns, (t) => t.w);
      ctx.tried.add(town.i);
      return { town, tier };
    }
    return null;
  }

  // Random point near the town centre; bigger towns get a wider spread.
  function jitter(town) {
    const maxKm = Math.min(6, 0.4 + Math.sqrt(town.pop) / 150);
    const d = maxKm * Math.sqrt(Math.random());
    const a = Math.random() * 2 * Math.PI;
    return {
      lat: town.lat + (d / 111) * Math.cos(a),
      lng: town.lng + (d / (111 * Math.cos(town.lat * Math.PI / 180))) * Math.sin(a),
    };
  }

  async function findPano(location, radius) {
    const g = google.maps;
    try {
      const { data } = await state.sv.getPanorama({
        location, radius,
        sources: [g.StreetViewSource.GOOGLE],
        preference: g.StreetViewPreference.NEAREST,
      });
      return data;
    } catch {
      return null;
    }
  }

  function insideCountry(iso, pt) {
    const f = state.borders.get(iso);
    if (!f) return true;
    return f.geometry.coordinates.some((poly) => inRing(poly[0], pt) && !poly.slice(1).some((h) => inRing(h, pt)));
  }
  function inRing(ring, { lat, lng }) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function headingFor(data) {
    const links = (data.links || []).filter((l) => typeof l.heading === "number");
    const base = links.length ? links[Math.floor(Math.random() * links.length)].heading : Math.random() * 360;
    return (base + (Math.random() * 60 - 30) + 360) % 360;
  }

  /* ---------------------------------------------------------------- drop */

  async function dropPins() {
    const iso = state.selected;
    if (!iso || state.running) return;
    const runId = ++state.runId;
    state.running = true;
    clearResults();
    setBusy(true);
    setStatus(0, "Picking towns…");
    fitCountry(iso);
    renderSkeletons();

    let pool;
    try { pool = await getPool(iso); } catch { setBusy(false); state.running = false; return toast("No town data for this country."); }

    const f = state.borders.get(iso);
    const b = ringBounds(f ? f.geometry.coordinates.flatMap((p) => p[0]) : pool.towns.map((t) => [t.lng, t.lat]));
    const diagKm = km({ lat: b.s, lng: b.w }, { lat: b.n, lng: b.e });
    const ctx = { tried: new Set(), placed: [], panoIds: new Set(), minSep: Math.max(2, Math.min(40, diagKm / 25)) };
    let lookups = 0;

    const worker = async () => {
      while (state.runId === runId && state.results.length < PIN_COUNT && lookups < MAX_LOOKUPS) {
        const pick = pickTown(pool, ctx);
        if (!pick) return;
        const { town, tier } = pick;
        lookups++;
        let data = await findPano(jitter(town), 400);
        if (!data) { lookups++; data = await findPano({ lat: town.lat, lng: town.lng }, 1500); }
        if (state.runId !== runId || state.results.length >= PIN_COUNT) return;
        if (!data || !data.location || ctx.panoIds.has(data.location.pano)) continue;
        const loc = { lat: data.location.latLng.lat(), lng: data.location.latLng.lng() };
        if (!insideCountry(iso, loc)) continue;
        if (ctx.placed.some((p) => km(p, loc) < ctx.minSep / 4)) continue;
        ctx.panoIds.add(data.location.pano);
        ctx.placed.push(loc);
        addResult({ ...loc, panoId: data.location.pano, heading: headingFor(data), town, tier, description: data.location.description || "" });
        setStatus(state.results.length / PIN_COUNT, `Found ${state.results.length} of ${PIN_COUNT}…`);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (state.runId !== runId) return;

    state.running = false;
    setBusy(false);
    finishResults(pool);
  }

  function clearResults() {
    state.markers.forEach((m) => (m.map = null));
    state.markers = [];
    state.results = [];
    $("cards").innerHTML = "";
    document.body.classList.remove("has-results");
  }

  function addResult(r) {
    r.n = state.results.length + 1;
    state.results.push(r);

    const pin = el("div", "pin", `<svg viewBox="0 0 34 44"><path d="M17 1.5C8.4 1.5 1.5 8.3 1.5 16.8 1.5 28 17 42.5 17 42.5S32.5 28 32.5 16.8C32.5 8.3 25.6 1.5 17 1.5z"/></svg><span>${r.n}</span>`);
    const marker = new google.maps.marker.AdvancedMarkerElement({
      map: state.map, position: { lat: r.lat, lng: r.lng }, content: pin, gmpClickable: true, title: `${r.n}. ${placeName(r)}`, zIndex: 100 + r.n,
    });
    marker.addEventListener("gmp-click", () => openViewer(r.n - 1));
    pin.addEventListener("mouseenter", () => highlight(r.n - 1, true));
    pin.addEventListener("mouseleave", () => highlight(r.n - 1, false));
    state.markers.push(marker);

    const card = cardFor(r);
    const skeleton = $("cards").querySelector(".card.skeleton");
    skeleton ? skeleton.replaceWith(card) : $("cards").appendChild(card);
  }

  function placeName(r) {
    return r.town.region && r.town.region !== r.town.name ? `${r.town.name}, ${r.town.region}` : r.town.name;
  }
  function tierText(r) {
    const t = r.town, c = state.byIso.get(state.selected);
    switch (r.tier.bit) {
      case 1: return `${t.metro || t.name} metro area`;
      case 2: return `Within 50 mi of ${t.metro}`;
      case 4: return `Near ${t.landmark}`;
      default: return `Small-region pick · ${c ? c.name : ""}`;
    }
  }

  function cardFor(r) {
    const li = el("li", "card");
    const thumb = el("div", "thumb", `<span class="num">${r.n}</span><span class="tier">${esc(r.tier.label)}</span>`);
    if (CFG.thumbnails) {
      const url = `https://maps.googleapis.com/maps/api/streetview?size=400x250&pano=${encodeURIComponent(r.panoId)}` +
        `&heading=${r.heading.toFixed(0)}&pitch=0&fov=90&return_error_code=true&key=${encodeURIComponent(state.key)}`;
      const img = new Image();
      img.onload = () => { thumb.style.backgroundImage = `url("${url}")`; };
      img.src = url;
    }
    li.appendChild(thumb);
    li.appendChild(el("div", "body", `<h4>${esc(placeName(r))}</h4><p>${esc(tierText(r))}</p>`));
    li.addEventListener("click", () => openViewer(r.n - 1));
    li.addEventListener("mouseenter", () => highlight(r.n - 1, true));
    li.addEventListener("mouseleave", () => highlight(r.n - 1, false));
    return li;
  }

  function renderSkeletons() {
    const c = state.byIso.get(state.selected);
    $("strip").hidden = false;
    $("stripTitle").textContent = `Dropping pins in ${c.name}…`;
    $("stripSub").textContent = "Finding Street View near towns and cities";
    for (let i = 0; i < PIN_COUNT; i++) {
      $("cards").appendChild(el("li", "card skeleton", `<div class="thumb"></div><div class="body"><h4></h4><p></p></div>`));
    }
  }

  function finishResults() {
    $("cards").querySelectorAll(".card.skeleton").forEach((s) => s.remove());
    const c = state.byIso.get(state.selected);
    const n = state.results.length;
    $("status").hidden = true;
    if (!n) {
      $("strip").hidden = true;
      return toast(`No Street View found in ${c.name}. Google's coverage there is very limited.`, 6000);
    }
    document.body.classList.add("has-results");
    $("stripTitle").innerHTML = `${flag(c.iso)} ${n} random pin${n === 1 ? "" : "s"} in ${esc(c.name)}`;
    const counts = TIERS.map((t) => [t.label, state.results.filter((r) => r.tier.bit === t.bit).length]).filter(([, k]) => k);
    $("stripSub").textContent = counts.map(([l, k]) => `${k} ${l.toLowerCase()}`).join(" · ");
    if (n < PIN_COUNT) toast(`Only found ${n} Street View spots. Coverage in ${c.name} is limited.`, 5000);

    const bounds = new google.maps.LatLngBounds();
    state.results.forEach((r) => bounds.extend(r));
    state.map.fitBounds(bounds, mapPadding());
    google.maps.event.addListenerOnce(state.map, "idle", () => { if (state.map.getZoom() > 12) state.map.setZoom(12); });
  }

  function highlight(i, on) {
    state.markers[i]?.content.classList.toggle("active", on);
    $("cards").children[i]?.classList.toggle("active", on);
  }

  function setBusy(b) {
    $("dropBtn").classList.toggle("loading", b);
    $("dropBtn").disabled = b;
    $("rerollBtn").disabled = b;
    $("slideshowBtn").disabled = b;
  }
  function setStatus(frac, text) {
    $("status").hidden = false;
    $("progressBar").style.width = `${Math.round(frac * 100)}%`;
    $("statusText").textContent = text;
  }

  /* -------------------------------------------------------------- viewer */

  function openViewer(i) {
    if (!state.results.length) return;
    $("viewer").hidden = false;
    if (!state.pano) {
      state.pano = new google.maps.StreetViewPanorama($("pano"), {
        addressControl: false, fullscreenControl: false, motionTracking: false, motionTrackingControl: false,
        showRoadLabels: true, keyboardShortcuts: false, enableCloseButton: false, zoomControl: false,
        panControl: false, linksControl: true, clickToGo: true,
      });
    }
    $("vTotal").textContent = state.results.length;
    const dots = $("vDots");
    dots.innerHTML = "";
    state.results.forEach((_, k) => {
      const d = el("button");
      d.type = "button";
      d.setAttribute("aria-label", `Pin ${k + 1}`);
      d.addEventListener("click", () => show(k));
      dots.appendChild(d);
    });
    show(i);
  }

  function show(i) {
    const n = state.results.length;
    state.viewerIndex = (i + n) % n;
    const r = state.results[state.viewerIndex];
    state.pano.setPano(r.panoId);
    state.pano.setPov({ heading: r.heading, pitch: 0 });
    state.pano.setZoom(0);
    state.pano.setVisible(true);
    $("vIndex").textContent = r.n;
    $("vTitle").textContent = placeName(r);
    $("vSub").textContent = `${tierText(r)}${r.description ? " · " + r.description : ""}`;
    $("vOpen").href = `https://www.google.com/maps/@?api=1&map_action=pano&pano=${encodeURIComponent(r.panoId)}&heading=${r.heading.toFixed(0)}`;
    [...$("vDots").children].forEach((d, k) => d.classList.toggle("on", k === state.viewerIndex));
    state.results.forEach((_, k) => highlight(k, k === state.viewerIndex));
    if (state.autoplay) restartAutoplay();
  }

  function closeViewer() {
    stopAutoplay();
    $("viewer").hidden = true;
    state.results.forEach((_, k) => highlight(k, false));
  }

  // Autoplay advances every AUTOPLAY_MS and slowly pans the camera.
  function startAutoplay() {
    $("vPlay").textContent = "❚❚";
    state.autoplay = { start: performance.now(), raf: 0 };
    const tick = (now) => {
      if (!state.autoplay) return;
      const t = now - state.autoplay.start;
      $("vBar").style.width = `${Math.min(100, (t / AUTOPLAY_MS) * 100)}%`;
      const pov = state.pano.getPov();
      state.pano.setPov({ heading: (pov.heading + 0.12) % 360, pitch: pov.pitch });
      if (t >= AUTOPLAY_MS) { show(state.viewerIndex + 1); return; }
      state.autoplay.raf = requestAnimationFrame(tick);
    };
    state.autoplay.raf = requestAnimationFrame(tick);
  }
  function restartAutoplay() { stopAutoplay(); startAutoplay(); }
  function stopAutoplay() {
    if (state.autoplay) cancelAnimationFrame(state.autoplay.raf);
    state.autoplay = null;
    $("vPlay").textContent = "▶";
    $("vBar").style.width = "0";
  }

  /* -------------------------------------------------------------- wiring */

  function toast(msg, ms = 3500) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove("show"), ms);
  }

  $("dropBtn").addEventListener("click", dropPins);
  $("rerollBtn").addEventListener("click", dropPins);
  $("slideshowBtn").addEventListener("click", () => { openViewer(0); startAutoplay(); });
  $("randomBtn").addEventListener("click", () => {
    if (!state.index.length || state.running) return;
    const pool = state.index.filter((c) => SV_GOOD.has(c.iso) && c.iso !== state.selected);
    selectCountry(pool[Math.floor(Math.random() * pool.length)].iso, true);
    dropPins();
  });
  $("vClose").addEventListener("click", closeViewer);
  $("vPrev").addEventListener("click", () => show(state.viewerIndex - 1));
  $("vNext").addEventListener("click", () => show(state.viewerIndex + 1));
  $("vPlay").addEventListener("click", () => (state.autoplay ? stopAutoplay() : startAutoplay()));
  document.addEventListener("keydown", (e) => {
    if ($("viewer").hidden) return;
    if (e.key === "Escape") closeViewer();
    else if (e.key === "ArrowRight") show(state.viewerIndex + 1);
    else if (e.key === "ArrowLeft") show(state.viewerIndex - 1);
    else if (e.key === " ") { e.preventDefault(); state.autoplay ? stopAutoplay() : startAutoplay(); }
  });

  boot();
})();
