/* RevierApp – Frontend (ES-Modul, ohne Framework) */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  token: localStorage.getItem('token'),
  me: null, users: [], online: [],
  revier: { name: 'Mein Revier', center: { lat: 51.1657, lng: 10.4515, zoom: 6 }, boundaries: [], features: [] },
  checkins: { active: [], history: [] }, sightings: [], shots: [], areas: [], events: [], incidents: [], contacts: [], tasks: [], seasons: [], seasonsNote: '', harvest: null, mehrPage: null,
  unlocked: localStorage.getItem('markersUnlocked') === '1',
  layerFilter: Object.assign({ kanzel: true, kamera: true, kirrung: true, nachbar: true, sonstiges: true, labels: true, sightings: true, shots: true, areas: true, grenze: true, tracks: true, incidents: true }, JSON.parse(localStorage.getItem('layerFilter') || '{}')),
  plans: [], hunts: [], hunt: null, huntTab: 'uebersicht',
  weather: null, notifications: [],
  view: 'karte', checkinMode: 'kanzel',
};

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && state.token) { setToken(null); showAuth(); throw new Error('Nicht angemeldet.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Fehler ' + res.status);
  if ((opts.method || (opts.body ? 'POST' : 'GET')) !== 'GET' && !opts.silent) refreshAfterWrite(path);
  return data;
}
const WRITE_REFRESH = [[/^\/(features|boundaries|revier|seasons)/, 'revier'], [/^\/(harvest|quota)/, 'harvest'], [/^\/tasks/, 'tasks'], [/^\/incidents/, 'incidents'], [/^\/contacts/, 'contacts'], [/^\/areas/, 'areas'], [/^\/sightings/, 'sightings'], [/^\/shots/, 'shots'], [/^\/checkins/, 'checkins'], [/^\/plans/, 'plans'], [/^\/hunts/, 'hunts'], [/^\/events/, 'events'], [/^\/(admin|auth\/register)/, 'users']];
let refreshTimer, refreshSet = new Set();
function refreshAfterWrite(path) {
  const hit = WRITE_REFRESH.find(([re]) => re.test(path)); if (!hit) return;
  refreshSet.add(hit[1]); if (path.startsWith('/checkins')) refreshSet.add('plans');
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { const names = [...refreshSet]; refreshSet.clear(); for (const n of names) loaders[n]?.({}); poll(); }, 80);
}
function setToken(t) { state.token = t; t ? localStorage.setItem('token', t) : localStorage.removeItem('token'); }

// ---------- Toast / Dialog ----------
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type; el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
function openDialog(html, onMount) {
  const d = $('#dialog'); $('#dialog-body').innerHTML = html;
  if (onMount) onMount(d);
  d.showModal();
  $$('[data-close]', d).forEach(b => b.onclick = () => d.close());
  return d;
}
const closeDialog = () => $('#dialog').close();

// ---------- Format ----------
const fmtDate = iso => new Date(iso).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
const fmtTime = iso => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const fmtDT = iso => `${fmtDate(iso)} ${fmtTime(iso)}`;
const sqlToIso = s => (s && !s.endsWith('Z') && !s.includes('T') ? s.replace(' ', 'T') + 'Z' : s);
function ago(iso) {
  const m = Math.round((Date.now() - new Date(sqlToIso(iso)).getTime()) / 60000);
  if (m < 1) return 'gerade eben'; if (m < 60) return `seit ${m} Min.`;
  const h = Math.floor(m / 60); return `seit ${h} Std. ${m % 60} Min.`;
}
const initials = n => n.split(/\s+/).map(p => p[0]).join('').slice(0, 2);
const avatar = (u, cls = '') => `<span class="avatar ${cls}" style="background:${esc(u.color || u.user_color)}" title="${esc(u.name || u.user_name)}">${esc(initials(u.name || u.user_name))}</span>`;
const spotText = (mode, featureName) => mode === 'pirsch' ? 'auf der Pirsch' : `auf ${featureName || 'Kanzel'}`;
const compass = deg => ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(deg / 22.5) % 16];

// ---------- Auth ----------
let authStatus = { needsSetup: false, hasInviteCode: true };
async function showAuth() {
  $('#auth').classList.remove('hidden'); $('#app').classList.add('hidden');
  $('#auth-error').textContent = '';
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server antwortet mit Status ${res.status}`);
    authStatus = data;
  } catch (e) {
    $('#auth-error').textContent = `Server nicht erreichbar: ${e.message}. Bitte später erneut versuchen oder den Admin informieren.`;
  }
  $('#invite-label').classList.remove('hidden');
  $('#setup-hint').classList.toggle('hidden', !authStatus.needsSetup);
  $('#auth-info').classList.toggle('hidden', authStatus.needsSetup);
  $('#btn-login').classList.toggle('hidden', authStatus.needsSetup);
  $('#invite-label-text').textContent = authStatus.needsSetup ? 'Einladungscode festlegen' : 'Einladungscode (nur zum Registrieren)';
  if (authStatus.needsSetup) { $('#btn-register').classList.add('primary'); $('#btn-register').textContent = 'Revier anlegen'; }
}
$('#auth-form').addEventListener('submit', async e => {
  e.preventDefault();
  const action = e.submitter?.dataset.action || 'login';
  const fd = new FormData(e.target);
  $('#auth-error').textContent = '';
  try {
    if (action === 'register' && !fd.get('invite_code')) { $('#auth-error').textContent = authStatus.needsSetup ? 'Bitte einen Einladungscode festlegen.' : 'Zum Registrieren brauchst du den Einladungscode.'; return; }
    const r = await api('/auth/' + action, { body: { name: fd.get('name'), password: fd.get('password'), invite_code: fd.get('invite_code') } });
    setToken(r.token); await boot();
  } catch (err) { $('#auth-error').textContent = err.message; }
});
$('#btn-logout').onclick = async () => { try { await api('/auth/logout', { method: 'POST' }); } catch {} setToken(null); location.reload(); };

// ---------- Boot ----------
async function boot() {
  if (!state.token) return showAuth();
  try { state.me = await api('/auth/me'); } catch { return showAuth(); }
  $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#btn-me').textContent = initials(state.me.name); $('#btn-me').style.background = state.me.color;
  $('#me-name').textContent = state.me.name;
  try { initMap(); } catch (e) { console.error('Karte konnte nicht initialisiert werden', e); toast('Karte nicht verfügbar', 'error'); }
  await Promise.all([loadRevier(), loadUsers(), loadCheckins(), loadPlans(), loadHunts(), loadNotifications(), loadSightings(), loadShots(), loadAreas(), loadEvents(), loadIncidents(), loadContacts(), loadSeasons(), loadTasks()]);
  loadWeather();
  connectWs();
  startPolling();
  registerSw();
  routeFromHash();
  setInterval(() => { if (state.view === 'karte') renderActive(); }, 60000);
  setInterval(loadWeather, 15 * 60 * 1000);
}

// ---------- Live-Updates: Abfrage der Versionszähler (überall) + WebSocket (nur lokaler Server) ----------
let ws, wsTimer, wsFailures = 0, wsEverOpen = false, pollTimer, knownVersions = null;
const loaders = { users: () => loadUsers(), revier: loadRevier, checkins: () => loadCheckins().then(loadNotifications), plans: () => loadPlans().then(loadNotifications), hunts: refreshHunts, sightings: () => loadSightings().then(loadNotifications), shots: () => loadShots().then(loadNotifications), areas: loadAreas, events: () => loadEvents().then(loadNotifications), incidents: () => loadIncidents().then(loadNotifications), contacts: () => loadContacts(), tasks: () => loadTasks(), harvest: () => loadHarvest() };
function refreshHunts(data = {}) {
  return loadHunts().then(() => { if (state.hunt && (!data.hunt_id || data.hunt_id === state.hunt.id)) return loadHunt(state.hunt.id); }).then(loadNotifications);
}
async function poll() {
  if (document.hidden || !state.token) return;
  try {
    const r = await api('/changes');
    state.online = r.online; renderOnline();
    if (knownVersions) {
      for (const [name, v] of Object.entries(r.versions)) if (knownVersions[name] !== v && loaders[name]) loaders[name]({});
    }
    knownVersions = r.versions;
    setStatus(ws && ws.readyState === 1 ? 'Live verbunden' : 'Verbunden');
  } catch (e) { setStatus('Keine Verbindung'); }
}
function startPolling() {
  clearInterval(pollTimer);
  poll();
  pollTimer = setInterval(poll, ws && ws.readyState === 1 ? 30000 : 10000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) startPolling(); });
function connectWs() {
  if (ws) ws.close();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try { ws = new WebSocket(`${proto}://${location.host}/ws?token=${state.token}`); } catch { ws = null; return; }
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (loaders[msg.type]) loaders[msg.type](msg.data || {});
    if (msg.type === 'users' && state.view === 'mehr') loadUsers().then(renderSettings);
  };
  ws.onopen = () => { wsEverOpen = true; wsFailures = 0; startPolling(); };
  ws.onclose = () => {
    wsFailures++;
    if (!wsEverOpen && wsFailures >= 2) { ws = null; startPolling(); return; } // Hosting ohne WebSocket (z. B. Netlify): nur Abfrage
    clearTimeout(wsTimer); wsTimer = setTimeout(connectWs, 3000); startPolling();
  };
}
function setStatus(t) { $('#topbar-status').textContent = t; }
function renderOnline() {
  $('#online-users').innerHTML = state.online.filter(u => u.id !== state.me.id).map(u => avatar(u)).join('');
  setStatus(`${state.online.length} online · ${state.checkins.active.length} im Revier`);
}

// ---------- Navigation ----------
$$('.nav button').forEach(b => b.onclick = () => { location.hash = b.dataset.view; });
window.addEventListener('hashchange', routeFromHash);
function routeFromHash() {
  const h = location.hash.replace('#', '') || 'karte';
  let view = h;
  if (h.startsWith('plan-')) { view = 'ansitz'; setTimeout(() => $(`#plan-${h.slice(5)}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 200); }
  if (h.startsWith('jagd-')) { view = 'jagd'; loadHunt(Number(h.slice(5))); }
  if (h.startsWith('termin-')) { view = 'jagd'; state.hunt = null; setTimeout(() => { renderHunts(); $(`#termin-${h.slice(7)}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 150); }
  if (h.startsWith('mehr-')) { view = 'mehr'; state.mehrPage = h.slice(5); } else if (h === 'mehr') state.mehrPage = null;
  if (!['karte', 'wetter', 'ansitz', 'jagd', 'mehr'].includes(view)) view = 'karte';
  showView(view);
}
function showView(v) {
  state.view = v;
  $$('.view').forEach(el => el.classList.toggle('hidden', el.id !== 'view-' + v));
  $$('.nav button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  if (v === 'karte' && map) setTimeout(() => map.invalidateSize(), 50);
  if (v === 'ansitz') markPlansRead();
  if (v === 'jagd' && !location.hash.startsWith('#jagd-')) { state.hunt = null; renderHunts(); }
  if (v === 'mehr') { renderSettings(); renderMehr(); }
}

// ---------- Users ----------
async function loadUsers() { state.users = await api('/users'); }

// ---------- Revier / Map ----------
let drawHandler = null;
let map, layers = {}, boundaryLayer, areaLayer, featureLayer, checkinLayer, sightingLayer, shotLayer, trackLayer, measureLayer, pathLayer, incidentLayer, drawControl, activeTool = null, meMarker, pendingFlightShot = null;
// Rendering bündeln: mehrere Datenänderungen kurz hintereinander führen nur zu einem Neuzeichnen
const renderQueue = new Set(); let renderScheduled = false;
function scheduleRender(fn) { renderQueue.add(fn); if (renderScheduled) return; renderScheduled = true; requestAnimationFrame(() => { renderScheduled = false; const fns = [...renderQueue]; renderQueue.clear(); fns.forEach(f => f()); }); }
function applyLayerFilter() {
  const f = state.layerFilter;
  const want = { boundaryLayer: f.grenze, areaLayer: f.areas, sightingLayer: f.sightings, shotLayer: f.shots, trackLayer: f.tracks, incidentLayer: f.incidents !== false };
  for (const [name, on] of Object.entries(want)) { const l = { boundaryLayer, areaLayer, sightingLayer, shotLayer, trackLayer, incidentLayer }[name]; if (!l) continue; if (on && !map.hasLayer(l)) l.addTo(map); if (!on && map.hasLayer(l)) map.removeLayer(l); }
  localStorage.setItem('layerFilter', JSON.stringify(f));
}
const featureKinds = { kanzel: 'Kanzel', kamera: 'Wildkamera', kirrung: 'Kirrung', nachbar: 'Reviernachbar', sonstiges: 'Sonstiges' };

function initMap() {
  if (map) return;
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView([state.revier.center.lat, state.revier.center.lng], state.revier.center.zoom || 6);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  layers = {
    topo: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenStreetMap, SRTM | © OpenTopoMap (CC-BY-SA)' }),
    osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap-Mitwirkende' }),
    sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles © Esri' }),
  };
  const saved = localStorage.getItem('layer') || 'topo';
  layers[saved].addTo(map);
  boundaryLayer = new L.FeatureGroup().addTo(map);
  areaLayer = new L.FeatureGroup().addTo(map);
  trackLayer = new L.FeatureGroup().addTo(map);
  pathLayer = new L.FeatureGroup().addTo(map);
  incidentLayer = new L.FeatureGroup().addTo(map);
  featureLayer = new L.FeatureGroup().addTo(map);
  checkinLayer = new L.FeatureGroup().addTo(map);
  sightingLayer = new L.FeatureGroup().addTo(map);
  shotLayer = new L.FeatureGroup().addTo(map);
  measureLayer = new L.FeatureGroup().addTo(map);

  map.on('click', onMapClick);
  map.on(L.Draw.Event.CREATED, async e => {
    const geo = e.layer.toGeoJSON();
    if (activeTool === 'gebiet') { setTool(null); return areaDialog({ geojson: geo }); }
    await api('/boundaries', { body: { geojson: geo, name: 'Reviergrenze' } });
    setTool(null); toast('Reviergrenze gespeichert');
  });
  map.on(L.Draw.Event.EDITED, async e => {
    for (const layer of Object.values(e.layers._layers)) {
      if (layer.boundaryId) await api('/boundaries/' + layer.boundaryId, { method: 'PUT', body: { geojson: layer.toGeoJSON() } });
      if (layer.areaId) await api('/areas/' + layer.areaId, { method: 'PUT', body: { geojson: layer.toGeoJSON() } });
    }
    toast('Gespeichert');
  });
  map.on(L.Draw.Event.DELETED, async e => {
    for (const layer of Object.values(e.layers._layers)) {
      if (layer.boundaryId) await api('/boundaries/' + layer.boundaryId, { method: 'DELETE' });
      if (layer.areaId) await api('/areas/' + layer.areaId, { method: 'DELETE' });
    }
  });

  $$('.map-toolbar .tool[data-tool]').forEach(b => b.onclick = () => onTool(b.dataset.tool));
  const toolbar = $('#map-toolbar');
  toolbar.classList.toggle('collapsed', localStorage.getItem('toolsCollapsed') === '1');
  $('#tools-toggle').onclick = () => { toolbar.classList.toggle('collapsed'); localStorage.setItem('toolsCollapsed', toolbar.classList.contains('collapsed') ? '1' : '0'); };
  setLocked(!state.unlocked);
  $('#lock-toggle').onclick = () => { setLocked(state.unlocked); toast(state.unlocked ? 'Markierungen entsperrt – zum Verschieben ziehen' : 'Markierungen gesperrt'); };
  applyLayerFilter();
  $('#wind-badge').onclick = () => { location.hash = 'wetter'; };
}

function onTool(tool) {
  if (tool === 'layer') return showLayerMenuV2();
  if (tool === 'locate') return locateMe();
  setTool(activeTool === tool ? null : tool);
}
function setTool(tool) {
  activeTool = tool;
  $$('.map-toolbar .tool').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  const hint = $('#map-hint');
  if (drawHandler) { try { drawHandler.disable(); } catch {} drawHandler = null; }
  if (drawControl) { map.removeControl(drawControl); drawControl = null; }
  if (tool !== 'messen') $('#measure-box').classList.add('hidden');
  if (tool !== 'flucht') { pendingFlightShot = null; $('#path-box').classList.add('hidden'); pathLayer.clearLayers(); pathPoints = []; }
  // Während des Platzierens kein Doppeltipp-Zoom, damit schnelle Tipps alle als Klick ankommen
  if (tool) map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
  if (!tool) { hint.classList.add('hidden'); $('#map').style.cursor = ''; return; }
  hint.classList.remove('hidden');
  if (tool === 'grenze' || tool === 'gebiet') {
    const isArea = tool === 'gebiet';
    hint.textContent = isArea ? 'Gebiet: Fläche zeichnen oder bestehende bearbeiten (Werkzeuge links)' : 'Grenze: Polygon zeichnen oder bestehende bearbeiten (Werkzeuge links)';
    drawControl = new L.Control.Draw({
      position: 'topleft',
      draw: { polygon: { allowIntersection: false, shapeOptions: isArea ? { color: '#3b7dd8', weight: 2, fillOpacity: .2 } : { color: '#9b3b2d', weight: 3, fillOpacity: .06 } }, polyline: false, rectangle: false, circle: false, marker: false, circlemarker: false },
      edit: { featureGroup: isArea ? areaLayer : boundaryLayer },
    });
    map.addControl(drawControl);
    // Zeichnen direkt starten: Eckpunkte antippen, zum Abschluss ersten Punkt erneut antippen oder „Fertig“
    drawHandler = new L.Draw.Polygon(map, drawControl.options.draw.polygon);
    drawHandler.enable();
    hint.textContent = isArea ? 'Gebiet: Eckpunkte antippen, zum Abschließen ersten Punkt erneut antippen' : 'Grenze: Eckpunkte antippen, zum Abschließen ersten Punkt erneut antippen';
  } else if (tool === 'faehrte') {
    hint.textContent = 'Tippe auf die Karte an die Stelle der Fährte oder Beobachtung';
    $('#map').style.cursor = 'crosshair';
  } else if (tool === 'anschuss') {
    hint.textContent = 'Tippe auf die Karte an die Stelle des Anschusses';
    $('#map').style.cursor = 'crosshair';
  } else if (tool === 'messen') {
    hint.classList.add('hidden');
    $('#map').style.cursor = 'crosshair';
    $('#measure-box').classList.remove('hidden');
    renderMeasure();
  } else if (tool === 'flucht') {
    hint.classList.add('hidden');
    $('#map').style.cursor = 'crosshair';
    $('#path-box').classList.remove('hidden');
  } else if (tool === 'unfall' || tool === 'schaden') {
    hint.textContent = tool === 'unfall' ? 'Tippe auf die Karte an die Unfallstelle' : 'Tippe auf die Karte an die Schadensfläche';
    $('#map').style.cursor = 'crosshair';
  } else if (tool === 'fund') {
    hint.textContent = 'Tippe auf die Karte an den Fundort des Stücks';
    $('#map').style.cursor = 'crosshair';
  } else {
    hint.textContent = `Tippe auf die Karte, um eine ${featureKinds[tool]} zu setzen`;
    $('#map').style.cursor = 'crosshair';
  }
}
// Marker sind standardmäßig gesperrt; das Schloss in der Werkzeugleiste gibt das Ziehen frei. Neue Marker lassen sich immer setzen.
function setLocked(locked) {
  state.unlocked = !locked; localStorage.setItem('markersUnlocked', state.unlocked ? '1' : '0');
  const b = $('#lock-toggle'); b.classList.toggle('unlocked', state.unlocked);
  $('.ico', b).className = 'ico ' + (state.unlocked ? 'ico-unlock' : 'ico-lock'); $('.tl', b).textContent = state.unlocked ? 'Offen' : 'Gesperrt';
  b.title = state.unlocked ? 'Markierungen sind verschiebbar – tippen zum Sperren' : 'Markierungen sind gesperrt – tippen zum Entsperren';
  scheduleRender(renderMapFeatures); scheduleRender(renderSightingMarkers); scheduleRender(renderShotMarkers); scheduleRender(renderIncidentMarkers);
}
const canDrag = own => !!state.unlocked && own;
const PLACEMENT_TOOLS = ['messen', 'faehrte', 'anschuss', 'flucht', 'fund', 'kanzel', 'kamera', 'kirrung', 'nachbar', 'unfall', 'schaden'];
// ---- Ebenen-Menü: Kartenansicht + Filter ----
function showLayerMenuV2() {
  if ($('.layer-menu')) return $('.layer-menu').remove();
  const menu = document.createElement('div'); menu.className = 'layer-menu';
  const names = { topo: 'Topografisch', osm: 'Straßenkarte', sat: 'Luftbild' };
  const current = localStorage.getItem('layer') || 'topo';
  const f = state.layerFilter;
  const cb = (k, label) => `<label><input type="checkbox" data-filter="${k}" ${f[k] ? 'checked' : ''}>${label}</label>`;
  menu.innerHTML = `<h4>Karte</h4>${Object.entries(names).map(([k, v]) => `<button data-layer="${k}" class="${k === current ? 'active' : ''}">${v}</button>`).join('')}
    <h4>Anzeigen</h4>${cb('kanzel', 'Kanzeln')}${cb('kamera', 'Wildkameras')}${cb('kirrung', 'Kirrungen')}${cb('nachbar', 'Reviernachbarn')}${cb('sonstiges', 'Sonstige Punkte')}${cb('labels', 'Beschriftungen')}
    ${cb('sightings', 'Fährten')}${cb('shots', 'Anschüsse / Nachsuche')}${cb('tracks', 'Nachsuche-Strecken')}${cb('incidents', 'Wildunfälle / Wildschäden')}${cb('areas', 'Gebiete')}${cb('grenze', 'Reviergrenze')}`;
  $$('button[data-layer]', menu).forEach(b => b.onclick = () => {
    Object.values(layers).forEach(l => map.removeLayer(l));
    layers[b.dataset.layer].addTo(map); localStorage.setItem('layer', b.dataset.layer);
    $$('button[data-layer]', menu).forEach(x => x.classList.toggle('active', x === b));
  });
  $$('input[data-filter]', menu).forEach(c => c.onchange = () => { f[c.dataset.filter] = c.checked; applyLayerFilter(); scheduleRender(renderMapFeatures); });
  $('.map-wrap').appendChild(menu);
}
function markerClickDuringPlacement(latlng) {
  if (!PLACEMENT_TOOLS.includes(activeTool)) return false;
  onMapClick({ latlng: L.latLng(latlng) });
  return true;
}
async function onMapClick(e) {
  if (!activeTool || activeTool === 'grenze' || activeTool === 'gebiet') return;
  if (activeTool === 'messen') return addMeasurePoint(e.latlng);
  if (activeTool === 'faehrte') { setTool(null); return sightingDialog({ lat: e.latlng.lat, lng: e.latlng.lng }); }
  if (activeTool === 'anschuss') { setTool(null); return shotDialog({ lat: e.latlng.lat, lng: e.latlng.lng }); }
  if (activeTool === 'unfall' || activeTool === 'schaden') { const kind = activeTool === 'unfall' ? 'wildunfall' : 'wildschaden'; setTool(null); return incidentDialog({ kind, lat: e.latlng.lat, lng: e.latlng.lng }); }
  if (activeTool === 'fund' && pendingFound) {
    const id = pendingFound; pendingFound = null; setTool(null);
    try { await api('/shots/' + id, { method: 'PUT', body: { status: 'gefunden', found_lat: e.latlng.lat, found_lng: e.latlng.lng } }); toast('Fundort gespeichert – Waidmannsheil!'); } catch (err) { toast(err.message, 'error'); }
    return;
  }
  if (activeTool === 'flucht' && pendingFlightShot) { pathPoints.push([e.latlng.lat, e.latlng.lng]); renderPathEdit(); return; }
  const kind = activeTool;
  const f = await api('/features', { body: { kind, lat: e.latlng.lat, lng: e.latlng.lng } });
  setTool(null);
  toast(`${featureKinds[kind]} gesetzt – Name im Popup anpassen`);
  setTimeout(() => editFeature(f.id), 300);
}
function showLayerMenu() {
  if ($('.layer-menu')) return $('.layer-menu').remove();
  const menu = document.createElement('div'); menu.className = 'layer-menu';
  const names = { topo: 'Topografisch', osm: 'Straßenkarte', sat: 'Luftbild' };
  const current = localStorage.getItem('layer') || 'topo';
  menu.innerHTML = Object.entries(names).map(([k, v]) => `<button data-layer="${k}" class="${k === current ? 'active' : ''}">${v}</button>`).join('');
  $$('button', menu).forEach(b => b.onclick = () => {
    Object.values(layers).forEach(l => map.removeLayer(l));
    layers[b.dataset.layer].addTo(map); localStorage.setItem('layer', b.dataset.layer); menu.remove();
  });
  $('.map-wrap').appendChild(menu);
}
function locateMe() {
  if (!navigator.geolocation) return toast('Standort nicht verfügbar', 'error');
  navigator.geolocation.getCurrentPosition(p => {
    const ll = [p.coords.latitude, p.coords.longitude];
    if (!meMarker) meMarker = L.circleMarker(ll, { radius: 8, color: '#fff', fillColor: '#2a6fd6', fillOpacity: 1, weight: 2 }).addTo(map);
    else meMarker.setLatLng(ll);
    map.setView(ll, Math.max(map.getZoom(), 15));
  }, () => toast('Standort konnte nicht ermittelt werden', 'error'), { enableHighAccuracy: true, timeout: 8000 });
}

async function loadRevier() {
  state.revier = await api('/revier');
  $('#revier-name').textContent = state.revier.name;
  document.title = `${state.revier.name} – RevierApp`;
  scheduleRender(renderMapFeatures);
  renderStandSelect();
  if (state.view === 'mehr') renderSettings();
}

function currentMaxZoom() { const key = localStorage.getItem('layer') || 'topo'; return layers[key]?.options.maxZoom || 18; }
function markerIcon(kind, cls = '') {
  return L.divIcon({ className: '', html: `<div class="marker ${kind} ${cls}"><span class="ico ico-${kind === 'sonstiges' ? 'locate' : kind}"></span></div>`, iconSize: [36, 36], iconAnchor: [18, 36], popupAnchor: [0, -34] });
}
let firstFit = true;
function renderMapFeatures() {
  if (!map) return;
  boundaryLayer.clearLayers(); featureLayer.clearLayers();
  for (const b of state.revier.boundaries) {
    // Grenzfläche reagiert nicht auf Tipps (sonst erscheint überall im Revier ein Hinweis); bearbeitbar bleibt sie über das Werkzeug „Grenze“
    const l = L.geoJSON(b.geojson, { style: { color: '#9b3b2d', weight: 3, dashArray: '8 6', fillColor: '#6b8e23', fillOpacity: .06 }, interactive: false });
    l.eachLayer(x => { x.boundaryId = b.id; boundaryLayer.addLayer(x); });
  }
  const occupied = new Map(state.checkins.active.filter(c => c.feature_id).map(c => [c.feature_id, c]));
  const planned = new Set(state.plans.filter(p => p.status === 'offen' && p.feature_id).map(p => p.feature_id));
  for (const f of state.revier.features) {
    if (!state.layerFilter[f.kind]) continue;
    const occ = occupied.get(f.id);
    const extra = [occ ? 'occupied' : '', planned.has(f.id) ? 'planned' : '', serviceOverdue(f) ? 'overdue' : '', windClass(f)].filter(Boolean).join(' ');
    const m = L.marker([f.lat, f.lng], { icon: markerIcon(f.kind, extra), draggable: !!state.unlocked });
    m.bindTooltip(f.name, { permanent: !!state.layerFilter.labels, direction: 'bottom', offset: [0, 2], className: 'marker-label' });
    m.on('dragend', async () => { const p = m.getLatLng(); await api('/features/' + f.id, { method: 'PUT', body: { lat: p.lat, lng: p.lng } }); });
    m.on('click', () => { if (markerClickDuringPlacement(m.getLatLng())) return; openFeaturePopup(m, f, occ); });
    featureLayer.addLayer(m);
  }
  if (firstFit) {
    // Startansicht: gespeicherter Mittelpunkt, Zoom = sechstgrößte Stufe der aktuellen Kartenart (maximal minus 5)
    const c = state.revier.center;
    const startZoom = currentMaxZoom() - 5;
    if (c && c.zoom >= 10) { firstFit = false; map.setView([c.lat, c.lng], startZoom); }
    else {
      const bounds = new L.FeatureGroup([boundaryLayer, featureLayer]).getBounds();
      if (bounds.isValid()) { firstFit = false; map.setView(bounds.getCenter(), startZoom); }
    }
  }
  renderCheckinMarkers();
}

// ---------- Gebiete ----------
async function loadAreas() { state.areas = await api('/areas'); scheduleRender(renderAreas); }
function renderAreas() {
  if (!map) return;
  areaLayer.clearLayers();
  for (const a of state.areas) {
    const l = L.geoJSON(a.geojson, { style: { color: a.color, weight: 2, fillColor: a.color, fillOpacity: .18 } });
    l.eachLayer(x => {
      x.areaId = a.id;
      if (state.layerFilter.labels) x.bindTooltip(a.name, { permanent: true, direction: 'center', className: 'area-label' });
      x.on('click', ev => {
        if (markerClickDuringPlacement(ev.latlng)) return;
        if (activeTool === 'gebiet' || activeTool === 'grenze') return;
        openMarkerPopup(x, `<h3 style="color:${esc(a.color)}">${esc(a.name)}</h3>${a.notes ? `<div class="muted small">${esc(a.notes)}</div>` : ''}<div class="muted small">Fläche ca. ${fmtArea(x)}</div>
          <div class="row"><button class="btn sm" data-act="edit">Bearbeiten</button><button class="btn sm" data-act="shape">Form ändern</button><button class="btn sm danger" data-act="del">Löschen</button></div>`);
        const pop = x.getPopup().getElement();
        $('[data-act="edit"]', pop)?.addEventListener('click', () => { map.closePopup(); areaDialog(a); });
        $('[data-act="shape"]', pop)?.addEventListener('click', () => { map.closePopup(); setTool('gebiet'); toast('Links „Bearbeiten“ wählen, Eckpunkte ziehen, dann „Save“'); });
        $('[data-act="del"]', pop)?.addEventListener('click', async () => { if (confirm(`Gebiet „${a.name}“ löschen?`)) { map.closePopup(); await api('/areas/' + a.id, { method: 'DELETE' }); } });
      });
      areaLayer.addLayer(x);
    });
  }
}
function fmtArea(layer) {
  try { const ll = layer.getLatLngs()[0]; const m2 = L.GeometryUtil?.geodesicArea ? L.GeometryUtil.geodesicArea(ll) : 0; return m2 >= 10000 ? `${(m2 / 10000).toFixed(1)} ha` : `${Math.round(m2)} m²`; } catch { return '–'; }
}
const AREA_COLORS = ['#3b7dd8', '#c9a24b', '#6b8e23', '#a0522d', '#8b1a1a', '#5c5c7a', '#2f8f7a', '#b8762b'];
function areaDialog(a) {
  const isNew = !a.id;
  openDialog(`<h2>${isNew ? 'Neues Gebiet' : 'Gebiet bearbeiten'}</h2>
    <label>Name<input id="a-name" maxlength="80" value="${esc(a.name || '')}" placeholder="z. B. Elsbruch"></label>
    <label>Farbe</label><div class="signs" id="a-colors">${AREA_COLORS.map(c => `<label style="background:${c};border-color:${c};width:36px;height:36px;padding:0;justify-content:center"><input type="radio" name="a-color" value="${c}" ${(a.color || AREA_COLORS[0]) === c ? 'checked' : ''} style="accent-color:#fff"></label>`).join('')}</div>
    <label>Notizen<textarea id="a-notes" maxlength="500">${esc(a.notes || '')}</textarea></label>
    <div class="row"><button class="btn primary" id="a-save">Speichern</button><button class="btn" data-close>Abbrechen</button></div>`, d => {
    $('#a-save', d).onclick = async () => {
      const body = { name: $('#a-name', d).value, color: $('input[name=a-color]:checked', d)?.value, notes: $('#a-notes', d).value, geojson: a.geojson };
      if (!body.name.trim()) return toast('Bitte einen Namen angeben', 'error');
      try { if (isNew) await api('/areas', { body }); else await api('/areas/' + a.id, { method: 'PUT', body }); closeDialog(); toast('Gebiet gespeichert'); } catch (e) { toast(e.message, 'error'); }
    };
  });
}
// Beschickungs-/Kontrollintervall überschritten?
function serviceOverdue(f) {
  if (!f.interval_days) return false;
  if (!f.last_service) return true;
  return (Date.now() - new Date(f.last_service).getTime()) / 86400e3 > f.interval_days;
}
const COMPASS8 = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
const compass8 = deg => COMPASS8[Math.round(deg / 45) % 8];
function windClass(f) {
  if (f.kind !== 'kanzel' || !f.wind_dirs || !state.weather?.current) return '';
  return f.wind_dirs.split(',').includes(compass8(state.weather.current.wind_direction_10m)) ? 'wind-ok' : 'wind-bad';
}
const windSuits = f => windClass(f) === 'wind-ok';
function checkAge(f) { if (!f.last_check) return null; return Math.floor((Date.now() - new Date(f.last_check).getTime()) / 86400e3); }
// Popup an einem Marker öffnen. Leaflets eigener Klick-Umschalter wird entfernt: sonst öffnet unser Klick-Handler das Popup
// und Leaflet schließt es im selben Klick wieder, sodass ein zweiter Tipp auf denselben Marker scheinbar nichts tut.
function openMarkerPopup(layer, html, opts) {
  layer.bindPopup(html, opts);
  layer.off('click', layer._openPopup, layer);
  layer.openPopup();
  return layer.getPopup().getElement();
}
function openFeaturePopup(marker, f, occ) {
  const planned = state.plans.filter(p => p.status === 'offen' && p.feature_id === f.id);
  const service = f.interval_days ? `<div class="small ${serviceOverdue(f) ? 'season-closed' : 'season-ok'}">${f.kind === 'kamera' ? 'Kartentausch' : 'Beschickung'} alle ${f.interval_days} Tage · zuletzt ${f.last_service ? ageText(f.last_service) : 'nie'}${serviceOverdue(f) ? ' · fällig!' : ''}</div>` : '';
  const wind = f.kind === 'kanzel' && f.wind_dirs ? `<div class="small ${windClass(f) === 'wind-ok' ? 'season-ok' : windClass(f) === 'wind-bad' ? 'season-closed' : ''}">Guter Wind aus ${esc(f.wind_dirs.replace(/,/g, ', '))}${state.weather?.current ? ` · aktuell ${compass8(state.weather.current.wind_direction_10m)} ${windClass(f) === 'wind-ok' ? '✓ passt' : '✕ passt nicht'}` : ''}</div>` : '';
  const check = f.kind === 'kanzel' ? `<div class="small ${checkAge(f) === null || checkAge(f) > 365 ? 'season-closed' : 'season-ok'}">Standsicherheitsprüfung: ${checkAge(f) === null ? 'keine dokumentiert' : `vor ${checkAge(f)} Tagen`}${checkAge(f) === null || checkAge(f) > 365 ? ' · fällig' : ''}</div>` : '';
  const phone = f.phone ? `<div class="row" style="margin-top:.3rem"><a class="btn sm primary" href="tel:${esc(f.phone.replace(/\s+/g, ''))}">📞 ${esc(f.phone)}</a></div>` : '';
  const html = `<h3>${esc(f.name)}</h3><div class="muted small">${featureKinds[f.kind]}${f.notes ? ' · ' + esc(f.notes) : ''}</div>${phone}${service}${wind}${check}
    ${occ ? `<p><b style="color:var(--danger)">Besetzt:</b> ${esc(occ.user_name)} (${ago(occ.started_at)})</p>` : ''}
    ${planned.map(p => `<p class="small">Angekündigt: ${esc(p.user_name)} ${fmtDT(p.planned_at)}</p>`).join('')}
    <div class="row">
      ${f.kind === 'kanzel' && !occ ? `<button class="btn sm primary" data-act="checkin">Hier einchecken</button>` : ''}
      ${f.kind === 'kanzel' ? `<button class="btn sm" data-act="plan">Ankündigen</button>` : ''}
      ${f.kind === 'kirrung' ? `<button class="btn sm" data-log="beschickt">Beschickt</button>` : ''}
      ${f.kind === 'kamera' ? `<button class="btn sm" data-log="karte">Karte getauscht</button><button class="btn sm" data-log="batterie">Batterie</button>` : ''}
      ${f.kind === 'kanzel' ? `<button class="btn sm" data-act="check">Prüfung erledigt</button>` : ''}
      <button class="btn sm" data-act="edit">Bearbeiten</button>
    </div>`;
  const pop = openMarkerPopup(marker, html);
  $('[data-act="checkin"]', pop)?.addEventListener('click', () => { map.closePopup(); doCheckin('kanzel', f.id, ''); });
  $('[data-act="plan"]', pop)?.addEventListener('click', () => { map.closePopup(); location.hash = 'ansitz'; state.checkinMode = 'kanzel'; renderCheckinForm(); $('#checkin-stand').value = f.id; $('#plan-form').classList.remove('hidden'); });
  $('[data-act="edit"]', pop)?.addEventListener('click', () => { map.closePopup(); editFeature(f.id); });
  $$('[data-log]', pop).forEach(b => b.onclick = async () => { map.closePopup(); try { await api(`/features/${f.id}/logs`, { body: { kind: b.dataset.log } }); toast('Eingetragen'); } catch (e) { toast(e.message, 'error'); } });
  $('[data-act="check"]', pop)?.addEventListener('click', async () => {
    map.closePopup();
    try {
      const r = await api('/tasks', { body: { title: `Standsicherheitsprüfung ${f.name}`, kind: 'kanzelpruefung', feature_id: f.id, assignee: state.me.name } });
      await api('/tasks/' + r.id, { method: 'PUT', body: { done: true } }); toast('Prüfung dokumentiert');
    } catch (e) { toast(e.message, 'error'); }
  });
}
function editFeature(id) {
  const f = state.revier.features.find(x => x.id === id); if (!f) return;
  openDialog(`<h2>${featureKinds[f.kind]} bearbeiten</h2>
    <label>Name<input id="f-name" value="${esc(f.name)}" maxlength="80"></label>
    <label>Art<select id="f-kind">${Object.entries(featureKinds).map(([k, v]) => `<option value="${k}" ${k === f.kind ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label>Telefon${f.kind === 'nachbar' ? ' des Reviernachbarn' : ' (optional)'}<input id="f-phone" type="tel" maxlength="40" value="${esc(f.phone || '')}" placeholder="z. B. 0172 1234567"></label>
    <label>Notizen<textarea id="f-notes" maxlength="1000">${esc(f.notes)}</textarea></label>
    <label id="f-interval-l" class="${f.kind === 'kirrung' || f.kind === 'kamera' ? '' : 'hidden'}">${f.kind === 'kamera' ? 'Kartentausch / Kontrolle alle … Tage' : 'Beschickung alle … Tage'}<input id="f-interval" type="number" min="1" max="365" value="${f.interval_days || ''}" placeholder="z. B. 7 (leer = keine Erinnerung)"></label>
    <div id="f-wind-l" class="${f.kind === 'kanzel' ? '' : 'hidden'}"><label>Guter Wind aus Richtung (Wind weht von …)</label><div class="signs">${COMPASS8.map(d => `<label><input type="checkbox" name="f-wind" value="${d}" ${(f.wind_dirs || '').split(',').includes(d) ? 'checked' : ''}>${d}</label>`).join('')}</div></div>
    <p class="muted small">Position: ${f.lat.toFixed(5)}, ${f.lng.toFixed(5)} – Marker auf der Karte lässt sich verschieben.</p>
    <div class="row"><button class="btn primary" id="f-save">Speichern</button><button class="btn danger" id="f-del">Löschen</button><button class="btn" data-close>Abbrechen</button></div>`, d => {
    $('#f-kind', d).onchange = () => { const k = $('#f-kind', d).value; $('#f-interval-l', d).classList.toggle('hidden', !(k === 'kirrung' || k === 'kamera')); $('#f-wind-l', d).classList.toggle('hidden', k !== 'kanzel'); };
    $('#f-save', d).onclick = async () => { await api('/features/' + f.id, { method: 'PUT', body: { name: $('#f-name', d).value, kind: $('#f-kind', d).value, notes: $('#f-notes', d).value, phone: $('#f-phone', d).value, interval_days: $('#f-interval', d).value || null, wind_dirs: $$('input[name=f-wind]:checked', d).map(x => x.value).join(',') } }); closeDialog(); };
    $('#f-del', d).onclick = async () => { if (confirm(`„${f.name}“ wirklich löschen?`)) { await api('/features/' + f.id, { method: 'DELETE' }); closeDialog(); } };
  });
}
function renderCheckinMarkers() {
  if (!map) return;
  checkinLayer.clearLayers();
  for (const c of state.checkins.active) {
    if (c.mode === 'pirsch') {
      // Pirschgänger am Revier-Mittelpunkt bzw. an der Grenze anzeigen
      const b = boundaryLayer.getBounds();
      const pos = b.isValid() ? b.getCenter() : map.getCenter();
      const m = L.marker(pos, { icon: L.divIcon({ className: '', html: `<div class="pirsch-marker" style="background:${esc(c.user_color)}">${esc(initials(c.user_name))}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }), zIndexOffset: 1000 });
      m.bindTooltip(`${c.user_name} – auf der Pirsch (${ago(c.started_at)})`);
      checkinLayer.addLayer(m);
    }
  }
}

// ---------- Wind auf der Karte ----------
function renderWindBadge() {
  const w = state.weather?.current; if (!w) return;
  $('#wind-arrow-g').style.transformOrigin = '20px 20px';
  // Pfeil zeigt, wohin der Wind weht (Richtung + 180°)
  $('#wind-arrow-g').style.transform = `rotate(${w.wind_direction_10m + 180}deg)`;
  $('#wind-badge-dir').textContent = `${compass(w.wind_direction_10m)} ${Math.round(w.wind_direction_10m)}°`;
  $('#wind-badge-speed').textContent = `${Math.round(w.wind_speed_10m)} km/h · Böen ${Math.round(w.wind_gusts_10m)}`;
}

// ---------- Check-ins ----------
async function loadCheckins() {
  state.checkins = await api('/checkins');
  renderActive(); renderHistory(); scheduleRender(renderMapFeatures); renderOnline();
}
function renderActive() {
  const mine = state.checkins.active.find(c => c.user_id === state.me.id);
  $('#checkin-self').innerHTML = mine
    ? `<button class="btn sm danger" id="btn-checkout-map">Auschecken</button>`
    : `<button class="btn sm primary" id="btn-checkin-map">Einchecken</button>`;
  $('#btn-checkout-map')?.addEventListener('click', doCheckout);
  $('#btn-checkin-map')?.addEventListener('click', () => { location.hash = 'ansitz'; });
  $('#active-list').innerHTML = state.checkins.active.length ? state.checkins.active.map(c => `
    <div class="person" style="border-left-color:${esc(c.user_color)}">${avatar(c)}
      <div class="who"><b>${esc(c.user_name)}${c.user_id === state.me.id ? ' (ich)' : ''}</b><span>${spotText(c.mode, c.feature_name)}${c.note ? ' · ' + esc(c.note) : ''}</span></div>
      <div class="since">${ago(c.started_at)}</div>
    </div>`).join('') : '<p class="muted small">Niemand ist eingecheckt. Waidmannsheil!</p>';
  const ansitzCard = $('#btn-checkin');
  if (ansitzCard) { ansitzCard.textContent = mine ? 'Wechseln (neu einchecken)' : 'Jetzt einchecken'; }
  $('#checkout-row')?.remove();
  if (mine) {
    const row = document.createElement('div'); row.id = 'checkout-row'; row.className = 'hunt-tip';
    row.innerHTML = `Du bist seit ${fmtTime(sqlToIso(mine.started_at))} ${spotText(mine.mode, mine.feature_name)}. <button class="btn sm danger" id="btn-checkout">Auschecken</button>`;
    $('#checkin-card h2').after(row);
    $('#btn-checkout').onclick = doCheckout;
  }
}
function renderHistory() {
  $('#history-list').innerHTML = state.checkins.history.length ? state.checkins.history.map(c => `
    <div class="item">${avatar(c)}<div><b>${esc(c.user_name)}</b> ${spotText(c.mode, c.feature_name)}<div class="muted small">${fmtDT(sqlToIso(c.started_at))} – ${fmtTime(sqlToIso(c.ended_at))}${c.note ? ' · ' + esc(c.note) : ''}</div></div></div>`).join('')
    : '<p class="muted small">Noch keine Einträge.</p>';
}
function renderStandSelect() {
  const sel = $('#checkin-stand');
  const stands = state.revier.features.filter(f => f.kind === 'kanzel');
  const occupied = new Set(state.checkins.active.map(c => c.feature_id));
  const cur = sel.value;
  sel.innerHTML = stands.length ? stands.map(f => `<option value="${f.id}" ${occupied.has(f.id) ? 'data-occ="1"' : ''}>${esc(f.name)}${occupied.has(f.id) ? ' (besetzt)' : ''}${windClass(f) === 'wind-ok' ? ' ✓ Wind passt' : windClass(f) === 'wind-bad' ? ' ✕ Wind ungünstig' : ''}</option>`).join('')
    : '<option value="">Noch keine Kanzel angelegt – auf der Karte setzen</option>';
  if (cur) sel.value = cur;
}
function renderCheckinForm() {
  $$('#checkin-mode button').forEach(b => b.classList.toggle('active', b.dataset.mode === state.checkinMode));
  $('#checkin-stand-label').classList.toggle('hidden', state.checkinMode !== 'kanzel');
}
$$('#checkin-mode button').forEach(b => b.onclick = () => { state.checkinMode = b.dataset.mode; renderCheckinForm(); });
$('#btn-checkin').onclick = () => doCheckin(state.checkinMode, Number($('#checkin-stand').value) || null, $('#checkin-note').value);
$('#btn-plan-toggle').onclick = () => {
  const f = $('#plan-form'); f.classList.toggle('hidden');
  if (!$('#plan-time').value) { const d = new Date(Date.now() + 2 * 3600e3); d.setMinutes(0, 0, 0); $('#plan-time').value = toLocalInput(d); }
  renderPlanTwilight();
};
function renderPlanTwilight() {
  let box = $('#plan-twilight'); if (!box) { box = document.createElement('div'); box.id = 'plan-twilight'; box.className = 'twilight'; $('#plan-time').closest('label').after(box); }
  const d = new Date($('#plan-time').value); if (Number.isNaN(d.getTime())) { box.innerHTML = ''; return; }
  box.innerHTML = twilightHtml(d);
}
$('#plan-time').addEventListener('change', renderPlanTwilight);
function revierCenter() { const b = boundaryLayer?.getBounds(); return b && b.isValid() ? b.getCenter() : state.revier.center; }
function twilightHtml(d) {
  const c = revierCenter(); const t = sunTimes(d, c.lat, c.lng); const m = moonPhaseClient(d);
  const f = x => x ? x.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '–';
  return `<span>🌅 Dämmerung ${f(t.dawn)} · Aufgang ${f(t.sunrise)}</span><span>🌇 Untergang ${f(t.sunset)} · Dämmerung bis ${f(t.dusk)}</span><span>${moonIcon(m.index)} ${m.name} ${m.illumination} %</span>`;
}
// Sonnenauf-/-untergang und bürgerliche Dämmerung (NOAA-Näherung, auf wenige Minuten genau)
function sunTimes(date, lat, lng) {
  const rad = Math.PI / 180;
  const day = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const n = Math.floor(day / 86400000) - 10957.5; // Tage seit J2000
  const M = (357.5291 + 0.98560028 * n) % 360;
  const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
  const lam = (M + C + 180 + 102.9372) % 360;
  const decl = Math.asin(Math.sin(lam * rad) * Math.sin(23.44 * rad));
  const eqt = 4 * (M + C + 102.9372 + 180 - lam) ; // Minuten, nähert sich der Zeitgleichung
  const solarNoonUtc = 720 - 4 * lng - eqtCorrect(n); // Minuten UTC
  function eqtCorrect(n) { const g = (357.528 + 0.9856003 * n) * rad; const q = (280.459 + 0.98564736 * n); const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad; const e = 23.439 * rad; const RA = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / rad; return ((q - ((RA % 360) + 360) % 360 + 540) % 360 - 180) * 4; }
  const ha = alt => { const cosH = (Math.sin(alt * rad) - Math.sin(lat * rad) * Math.sin(decl)) / (Math.cos(lat * rad) * Math.cos(decl)); return cosH < -1 || cosH > 1 ? null : Math.acos(cosH) / rad * 4; };
  const mk = mins => mins === null ? null : new Date(day + mins * 60000);
  const h0 = ha(-0.833), h6 = ha(-6);
  void eqt;
  return { sunrise: mk(h0 === null ? null : solarNoonUtc - h0), sunset: mk(h0 === null ? null : solarNoonUtc + h0), dawn: mk(h6 === null ? null : solarNoonUtc - h6), dusk: mk(h6 === null ? null : solarNoonUtc + h6) };
}
function moonPhaseClient(date) {
  const synodic = 29.53058867, ref = Date.UTC(2000, 0, 6, 18, 14);
  const age = (((date.getTime() - ref) / 86400000) % synodic + synodic) % synodic, fraction = age / synodic;
  const names = ['Neumond', 'Zunehmende Sichel', 'Erstes Viertel', 'Zunehmender Mond', 'Vollmond', 'Abnehmender Mond', 'Letztes Viertel', 'Abnehmende Sichel'];
  return { illumination: Math.round((1 - Math.cos(fraction * 2 * Math.PI)) / 2 * 100), name: names[Math.round(fraction * 8) % 8], index: Math.round(fraction * 8) % 8 };
}
const toLocalInput = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
$('#btn-plan').onclick = async () => {
  try {
    await api('/plans', { body: { mode: state.checkinMode, feature_id: Number($('#checkin-stand').value) || null, planned_at: new Date($('#plan-time').value).toISOString(), note: $('#checkin-note').value } });
    $('#plan-form').classList.add('hidden'); $('#checkin-note').value = '';
    toast('Ankündigung gesendet – alle Nutzer wurden benachrichtigt');
  } catch (e) { toast(e.message, 'error'); }
};
async function doCheckin(mode, featureId, note, planId = null) {
  try {
    const stand = state.revier.features.find(f => f.id === featureId);
    const occ = state.checkins.active.find(c => c.feature_id === featureId && c.user_id !== state.me.id);
    if (occ && !confirm(`${stand?.name} ist von ${occ.user_name} besetzt. Trotzdem einchecken?`)) return;
    await api('/checkins', { body: { mode, feature_id: featureId, note, plan_id: planId } });
    $('#checkin-note').value = '';
    toast(`Eingecheckt ${spotText(mode, stand?.name)}`);
    location.hash = 'karte';
  } catch (e) { toast(e.message, 'error'); }
}
async function doCheckout() {
  try { await api('/checkins/checkout', { method: 'POST' }); toast('Ausgecheckt – Waidmannsdank!'); } catch (e) { toast(e.message, 'error'); }
}

// ---------- Angekündigte Ansitze ----------
async function loadPlans() {
  state.plans = await api('/plans');
  renderPlans(); scheduleRender(renderMapFeatures);
  const unread = state.plans.some(p => p.status === 'offen' && p.user_id !== state.me.id && !p.receipts.find(r => r.user_id === state.me.id)?.read_at);
  $('#nav-ansitz-dot').classList.toggle('hidden', !unread);
  if (state.view === 'ansitz') markPlansRead();
}
function markPlansRead() {
  for (const p of state.plans) {
    if (p.user_id === state.me.id) continue;
    const r = p.receipts.find(r => r.user_id === state.me.id);
    if (r && !r.read_at) api(`/plans/${p.id}/read`, { method: 'POST' }).catch(() => {});
  }
}
function renderPlans() {
  const list = $('#plans-list');
  if (!state.plans.length) { list.innerHTML = '<p class="muted small">Keine Ankündigungen. Kündige deinen Ansitz an, damit die anderen Bescheid wissen.</p>'; return; }
  list.innerHTML = state.plans.map(p => {
    const mine = p.user_id === state.me.id;
    const myReceipt = p.receipts.find(r => r.user_id === state.me.id);
    const cls = ['plan', mine ? 'mine' : '', p.status === 'abgesagt' ? 'cancelled' : '', p.status === 'gestartet' ? 'started' : ''].join(' ');
    const statusTag = { offen: '<span class="status-tag warn">Geplant</span>', gestartet: '<span class="status-tag ok">Eingecheckt</span>', abgesagt: '<span class="status-tag danger">Abgesagt</span>' }[p.status];
    const receipts = p.receipts.map(r => `<span class="chip ${r.confirmed_at ? 'confirmed' : r.read_at ? 'read' : ''}" title="${r.confirmed_at ? 'Bestätigt ' + fmtTime(sqlToIso(r.confirmed_at)) : r.read_at ? 'Gelesen ' + fmtTime(sqlToIso(r.read_at)) : 'Noch nicht gelesen'}">${r.confirmed_at ? '✓✓' : r.read_at ? '✓' : '○'} ${esc(r.user_name)}${r.comment ? ' „' + esc(r.comment) + '“' : ''}</span>`).join('');
    const actions = p.status !== 'offen' ? '' : mine
      ? `<button class="btn sm primary" data-act="start">Jetzt einchecken</button><button class="btn sm danger" data-act="cancel">Absagen</button>`
      : (myReceipt?.confirmed_at ? '<span class="chip confirmed">Von dir bestätigt</span>' : `<button class="btn sm primary" data-act="confirm">Bestätigen</button><button class="btn sm" data-act="confirm-comment">Mit Kommentar</button>`);
    return `<div class="${cls}" id="plan-${p.id}" data-id="${p.id}">
      <div class="plan-head"><div><div class="time">${fmtDT(p.planned_at)}</div><div>${avatar(p)} <b>${esc(p.user_name)}${mine ? ' (ich)' : ''}</b> ${spotText(p.mode, p.feature_name)}</div></div>${statusTag}</div>
      ${p.note ? `<div class="note">„${esc(p.note)}“</div>` : ''}
      ${p.status === 'offen' ? `<div class="twilight">${twilightHtml(new Date(p.planned_at))}</div>` : ''}
      <div class="receipts">${receipts || '<span class="muted small">Keine weiteren Nutzer.</span>'}</div>
      <div class="row" style="margin-top:.5rem">${actions}</div>
    </div>`;
  }).join('');
  $$('.plan [data-act]', list).forEach(b => b.onclick = async () => {
    const id = Number(b.closest('.plan').dataset.id); const p = state.plans.find(x => x.id === id);
    try {
      if (b.dataset.act === 'start') await doCheckin(p.mode, p.feature_id, p.note, p.id);
      if (b.dataset.act === 'cancel' && confirm('Ankündigung absagen?')) await api(`/plans/${id}/cancel`, { method: 'POST' });
      if (b.dataset.act === 'confirm') { await api(`/plans/${id}/confirm`, { body: { comment: '' } }); toast('Bestätigung gesendet'); }
      if (b.dataset.act === 'confirm-comment') {
        openDialog(`<h2>Bestätigen</h2><label>Kommentar<input id="c-text" maxlength="200" placeholder="z. B. Ich gehe dann auf Kanzel 3"></label><div class="row"><button class="btn primary" id="c-ok">Bestätigen</button><button class="btn" data-close>Abbrechen</button></div>`, d => {
          $('#c-ok', d).onclick = async () => { await api(`/plans/${id}/confirm`, { body: { comment: $('#c-text', d).value } }); closeDialog(); toast('Bestätigung gesendet'); };
        });
      }
    } catch (e) { toast(e.message, 'error'); }
  });
}

// ---------- Entfernungsmesser ----------
let measurePoints = [];
const fmtDist = m => m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
function bearingDeg(a, b) {
  const r = Math.PI / 180, dLng = (b.lng - a.lng) * r;
  const y = Math.sin(dLng) * Math.cos(b.lat * r), x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos(dLng);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}
function addMeasurePoint(latlng) { measurePoints.push(L.latLng(latlng)); renderMeasure(); }
function renderMeasure() {
  measureLayer.clearLayers();
  let total = 0, last = 0, lastBearing = null;
  measurePoints.forEach((p, i) => {
    measureLayer.addLayer(L.marker(p, { icon: L.divIcon({ className: '', html: '<div class="measure-point"></div>', iconSize: [12, 12], iconAnchor: [6, 6] }), interactive: false }));
    if (i > 0) {
      const a = measurePoints[i - 1], d = a.distanceTo(p); total += d; last = d; lastBearing = bearingDeg(a, p);
      const line = L.polyline([a, p], { color: '#9b3b2d', weight: 3, dashArray: '6 6' });
      line.bindTooltip(fmtDist(d), { permanent: true, direction: 'center', className: 'measure-label' });
      measureLayer.addLayer(line);
    }
  });
  $('#measure-total').textContent = measurePoints.length > 1 ? `Gesamt ${fmtDist(total)}` : measurePoints.length === 1 ? 'Zweiten Punkt antippen' : 'Punkte auf der Karte antippen';
  $('#measure-last').textContent = measurePoints.length > 1 ? `Letzter Abschnitt ${fmtDist(last)} · Richtung ${Math.round(lastBearing)}° ${compass(lastBearing)}` : '';
}
$('#measure-undo').onclick = () => { measurePoints.pop(); renderMeasure(); };
$('#measure-clear').onclick = () => { measurePoints = []; renderMeasure(); };
$('#measure-done').onclick = () => { setTool(null); };

// ---------- Anschüsse / Nachsuche ----------
const SHOT_SIGNS = ['Schweiß hell', 'Schweiß dunkel', 'Lungenschweiß (schaumig)', 'Schnitthaar', 'Knochensplitter', 'Panseninhalt', 'Wildbret', 'Kein Pirschzeichen'];
const SHOT_STATUS = { offen: ['Offen', 'warn'], nachsuche: ['Nachsuche läuft', 'danger'], gefunden: ['Gefunden', 'ok'], abgebrochen: ['Abgebrochen', ''] };
const destPoint = (lat, lng, bearing, meters) => {
  const R = 6371000, r = Math.PI / 180, b = bearing * r, la = lat * r, lo = lng * r, dr = meters / R;
  const la2 = Math.asin(Math.sin(la) * Math.cos(dr) + Math.cos(la) * Math.sin(dr) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(dr) * Math.cos(la), Math.cos(dr) - Math.sin(la) * Math.sin(la2));
  return [la2 / r, lo2 / r];
};
async function loadShots() { state.shots = await api('/shots'); renderShots(); scheduleRender(renderShotMarkers); }
function renderShotMarkers() {
  if (!map) return;
  shotLayer.clearLayers();
  for (const sh of state.shots) {
    const m = L.marker([sh.lat, sh.lng], { zIndexOffset: 800, draggable: canDrag(sh.user_id === state.me.id || !!state.me.is_admin),
      icon: L.divIcon({ className: '', html: `<div class="shot ${sh.status}"><span class="ico ico-anschuss"></span></div>`, iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -16] }) });
    m.bindTooltip(`Anschuss ${sh.species} · ${SHOT_STATUS[sh.status][0]} · ${ageText(sh.shot_at)}`);
    m.on('dragend', async () => { const p = m.getLatLng(); await api('/shots/' + sh.id, { method: 'PUT', body: { lat: p.lat, lng: p.lng } }); });
    m.on('click', () => { if (markerClickDuringPlacement(m.getLatLng())) return; openShotPopup(m, sh); });
    shotLayer.addLayer(m);
    const path = parsePathClient(sh);
    if (path.length) {
      const pts = [[sh.lat, sh.lng], ...path];
      shotLayer.addLayer(L.polyline(pts, { color: '#9b3b2d', weight: 3, dashArray: '8 6', interactive: false }));
      const a = pts[pts.length - 2], b = pts[pts.length - 1];
      const rot = bearingDeg(L.latLng(a), L.latLng(b));
      shotLayer.addLayer(L.marker(b, { interactive: false, icon: L.divIcon({ className: '', html: `<div class="flight-arrow" style="transform:rotate(${Math.round(rot)}deg)"></div>`, iconSize: [18, 18], iconAnchor: [9, 11] }) }));
    }
    if (sh.track_m > 0 && state.layerFilter.tracks && tracksCache.get(sh.id)?.sum !== sh.track_m) loadTracksFor(sh.id);
    if (sh.found_lat && sh.found_lng) {
      const fm = L.marker([sh.found_lat, sh.found_lng], { interactive: true, icon: L.divIcon({ className: '', html: '<div class="found-marker"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }) });
      fm.bindTooltip(`Fundort ${sh.species}`); shotLayer.addLayer(fm);
    }
  }
}
function renderShots() {
  const open = state.shots.filter(s => s.status === 'offen' || s.status === 'nachsuche');
  $('#shots-section').classList.toggle('hidden', !state.shots.length);
  $('#shots-count').textContent = open.length ? `${open.length} offen` : 'alle erledigt';
  $('#shots-list').innerHTML = state.shots.slice(0, 8).map(sh => `
    <div class="person" data-id="${sh.id}" style="border-left-color:${sh.status === 'gefunden' ? 'var(--ok)' : sh.status === 'abgebrochen' ? '#999' : 'var(--danger)'};cursor:pointer">
      <span class="shot ${sh.status}" style="width:28px;height:28px;border-width:2px"><span class="ico ico-anschuss" style="width:18px;height:18px"></span></span>
      <div class="who"><b>${esc(sh.species)} <span class="status-tag ${SHOT_STATUS[sh.status][1]}">${SHOT_STATUS[sh.status][0]}</span></b><span>${esc(sh.user_name || '')}${sh.feature_name ? ' · ' + esc(sh.feature_name) : ''}${Number.isFinite(sh.flight_bearing) ? ' · Flucht ' + compass(sh.flight_bearing) : ''}${sh.photo_count ? ' · ' + sh.photo_count + ' Foto' + (sh.photo_count > 1 ? 's' : '') : ''}${sh.track_m > 0 ? ' · ' + fmtDist(sh.track_m) + ' gelaufen' : ''}</span></div>
      <div class="since">${ageText(sh.shot_at)}</div></div>`).join('');
  $$('#shots-list [data-id]').forEach(el => el.onclick = () => { const sh = state.shots.find(x => x.id === Number(el.dataset.id)); if (sh && map) { map.setView([sh.lat, sh.lng], Math.max(map.getZoom(), 16)); shotLayer.eachLayer(l => { if (l.getLatLng && l.getLatLng().lat === sh.lat && l.getLatLng().lng === sh.lng && l.options.draggable !== undefined) l.fire('click'); }); } });
}
async function openShotPopup(marker, sh) {
  const mine = sh.user_id === state.me.id || state.me.is_admin;
  const signs = sh.signs ? sh.signs.split(',').map(x => `<span class="chip">${esc(x.trim())}</span>`).join(' ') : '';
  openMarkerPopup(marker, `<h3>Anschuss ${esc(sh.species)} <span class="status-tag ${SHOT_STATUS[sh.status][1]}">${SHOT_STATUS[sh.status][0]}</span></h3>
    <div>${fmtDT(sh.shot_at)} (${ageText(sh.shot_at)}) · ${esc(sh.user_name || '')}${sh.feature_name ? ' · von ' + esc(sh.feature_name) : ''}</div>
    <div class="small">${parsePathClient(sh).length ? `Fluchtweg ${parsePathClient(sh).length} Punkt${parsePathClient(sh).length > 1 ? 'e' : ''}, Richtung ${Math.round(sh.flight_bearing)}° ${compass(sh.flight_bearing)}` : '<span class="muted">Kein Fluchtweg eingetragen</span>'}${sh.track_m > 0 ? ` · Nachsuche ${fmtDist(sh.track_m)} gelaufen` : ''}</div>
    ${signs ? `<div class="receipts">${signs}</div>` : ''}${sh.note ? `<div class="muted small">„${esc(sh.note)}“</div>` : ''}
    <div class="photo-grid" id="shot-photos-${sh.id}">${sh.photo_count ? '<span class="muted small">Fotos werden geladen …</span>' : ''}</div>
    <div class="row">
      ${mine && sh.status !== 'gefunden' ? `<button class="btn sm" data-act="status" data-val="${sh.status === 'nachsuche' ? 'gefunden' : 'nachsuche'}">${sh.status === 'nachsuche' ? 'Gefunden' : 'Nachsuche starten'}</button>` : ''}
      ${sh.status !== 'gefunden' && sh.status !== 'abgebrochen' ? `<button class="btn sm" data-act="track">${track?.shotId === sh.id ? 'Aufzeichnung läuft' : 'Nachsuche aufzeichnen'}</button>` : ''}
      ${mine ? `<button class="btn sm" data-act="flucht">${parsePathClient(sh).length ? 'Fluchtweg bearbeiten' : 'Fluchtweg setzen'}</button><button class="btn sm" data-act="edit">Bearbeiten</button><button class="btn sm danger" data-act="del">Löschen</button>` : ''}
    </div>`, { maxWidth: 320 });
  if (sh.track_m > 0) loadTracksFor(sh.id);
  const popEl = marker.getPopup().getElement();
  $('[data-act="track"]', popEl)?.addEventListener('click', () => { map.closePopup(); if (track?.shotId !== sh.id) startTrack(sh); });
  const gespanne = state.contacts.filter(c => c.role === 'nachsuche' && c.phone);
  const nachbarn = state.revier.features.filter(f => f.kind === 'nachbar' && f.phone).map(f => ({ ...f, d: L.latLng(sh.lat, sh.lng).distanceTo([f.lat, f.lng]) })).sort((a, b) => a.d - b.d).slice(0, 2);
  if ((gespanne.length || nachbarn.length) && sh.status !== 'gefunden') {
    const div = document.createElement('div'); div.className = 'row'; div.style.marginTop = '.4rem';
    div.innerHTML = gespanne.map(c => `<a class="btn sm primary" href="tel:${esc(c.phone.replace(/\s+/g, ''))}">📞 ${esc(c.name)}</a>`).join('')
      + nachbarn.map(f => `<a class="btn sm" href="tel:${esc(f.phone.replace(/\s+/g, ''))}" title="Reviernachbar, ${fmtDist(f.d)} entfernt">📞 ${esc(f.name)} (${fmtDist(f.d)})</a>`).join('');
    $('.leaflet-popup-content', popEl)?.appendChild(div);
  }
  const pop = marker.getPopup().getElement();
  $('[data-act="status"]', pop)?.addEventListener('click', async () => {
    const val = $('[data-act="status"]', pop).dataset.val; map.closePopup();
    try {
      if (val === 'gefunden' && confirm('Fundort jetzt auf der Karte markieren? (Abbrechen = nur als gefunden melden)')) {
        pendingFound = sh.id; setTool('fund');
      } else await api('/shots/' + sh.id, { method: 'PUT', body: { status: val } });
    } catch (e) { toast(e.message, 'error'); }
  });
  $('[data-act="flucht"]', pop)?.addEventListener('click', () => { map.closePopup(); startPathEdit(sh); });
  $('[data-act="edit"]', pop)?.addEventListener('click', () => { map.closePopup(); shotDialog(sh); });
  $('[data-act="del"]', pop)?.addEventListener('click', async () => { if (confirm('Anschuss-Markierung löschen?')) { map.closePopup(); await api('/shots/' + sh.id, { method: 'DELETE' }); } });
  if (sh.photo_count) {
    try {
      const photos = await api(`/shots/${sh.id}/photos`);
      const grid = $(`#shot-photos-${sh.id}`); if (!grid) return;
      grid.innerHTML = photos.map(p => `<span class="ph"><img src="${p.data}" alt="Foto" data-full="${p.id}">${mine ? `<button data-delphoto="${p.id}" title="Foto löschen">✕</button>` : ''}</span>`).join('');
      $$('img', grid).forEach(img => img.onclick = () => openDialog(`<img class="photo-full" src="${img.src}"><div class="row" style="margin-top:.6rem"><button class="btn" data-close>Schließen</button></div>`));
      $$('[data-delphoto]', grid).forEach(b => b.onclick = async () => { if (confirm('Foto löschen?')) { await api(`/shots/${sh.id}/photos/${b.dataset.delphoto}`, { method: 'DELETE' }); map.closePopup(); } });
    } catch {}
  }
}
let pendingFound = null;
// Fluchtweg: gespeicherte Punktliste oder (ältere Daten) eine einzelne Richtung
function parsePathClient(sh) {
  try { const p = sh.flight_path ? JSON.parse(sh.flight_path) : null; if (Array.isArray(p) && p.length) return p; } catch {}
  if (sh.flight_lat && sh.flight_lng) return [[sh.flight_lat, sh.flight_lng]];
  if (Number.isFinite(sh.flight_bearing)) return [destPoint(sh.lat, sh.lng, sh.flight_bearing, 150)];
  return [];
}
let pathPoints = [];
function startPathEdit(sh) {
  pendingFlightShot = sh.id; pathPoints = parsePathClient(sh).map(p => [p[0], p[1]]);
  setTool('flucht'); renderPathEdit();
}
function renderPathEdit() {
  pathLayer.clearLayers();
  const sh = state.shots.find(x => x.id === pendingFlightShot); if (!sh) return;
  const pts = [[sh.lat, sh.lng], ...pathPoints];
  pathLayer.addLayer(L.polyline(pts, { color: '#9b3b2d', weight: 4, dashArray: '8 6', interactive: false }));
  pathPoints.forEach((pt, i) => {
    const v = L.marker(pt, { draggable: true, zIndexOffset: 1200, icon: L.divIcon({ className: '', html: '<div class="path-vertex"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }) });
    v.on('drag', () => { const ll = v.getLatLng(); pathPoints[i] = [ll.lat, ll.lng]; const line = pathLayer.getLayers().find(l => l instanceof L.Polyline); line?.setLatLngs([[sh.lat, sh.lng], ...pathPoints]); });
    v.on('dragend', () => renderPathEdit());
    pathLayer.addLayer(v);
  });
  let total = 0; for (let i = 1; i < pts.length; i++) total += L.latLng(pts[i - 1]).distanceTo(L.latLng(pts[i]));
  $('#path-title').textContent = `Fluchtweg ${sh.species}`;
  $('#path-info').textContent = pathPoints.length ? `${pathPoints.length} Punkt${pathPoints.length > 1 ? 'e' : ''} · ${fmtDist(total)} · Punkte ziehen oder weitere antippen` : 'Punkte in Fluchtrichtung antippen';
}
$('#path-undo').onclick = () => { pathPoints.pop(); renderPathEdit(); };
$('#path-clear').onclick = () => { pathPoints = []; renderPathEdit(); };
$('#path-cancel').onclick = () => setTool(null);
$('#path-save').onclick = async () => {
  const id = pendingFlightShot, pts = pathPoints.slice(); setTool(null);
  try { await api('/shots/' + id, { method: 'PUT', body: { flight_path: pts } }); toast(pts.length ? 'Fluchtweg gespeichert' : 'Fluchtweg entfernt'); } catch (e) { toast(e.message, 'error'); }
};

// ---------- Nachsuche-Strecke aufzeichnen (GPS) ----------
let track = null; // { shotId, trackId, points, watchId, startedAt, lastSave }
const tracksCache = new Map();
async function loadTracksFor(shotId) {
  try {
    const list = await api(`/shots/${shotId}/tracks`);
    tracksCache.set(shotId, { list, sum: list.reduce((a, t) => a + t.distance_m, 0) });
    trackLayer.eachLayer(l => { if (l.shotId === shotId) trackLayer.removeLayer(l); });
    for (const t of list) {
      if (t.points.length < 2) continue;
      const pl = L.polyline(t.points, { color: '#2a7a3b', weight: 4, opacity: .85 });
      pl.shotId = shotId; pl.bindTooltip(`Nachsuche ${esc(t.user_name || '')}: ${fmtDist(t.distance_m)}`);
      trackLayer.addLayer(pl);
    }
  } catch {}
}
async function startTrack(sh) {
  if (track) return toast('Es läuft bereits eine Aufzeichnung', 'error');
  if (!navigator.geolocation) return toast('GPS nicht verfügbar', 'error');
  try {
    const r = await api(`/shots/${sh.id}/tracks`, { body: { points: [] }, silent: true });
    track = { shotId: sh.id, trackId: r.id, points: [], startedAt: Date.now(), lastSave: 0, dist: 0, line: null };
    track.watchId = navigator.geolocation.watchPosition(onTrackPosition, err => toast('GPS-Fehler: ' + err.message, 'error'), { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
    $('#track-box').classList.remove('hidden'); $('#track-info').textContent = `Nachsuche ${sh.species} – Bildschirm anlassen`;
    toast('Aufzeichnung gestartet');
  } catch (e) { toast(e.message, 'error'); }
}
function onTrackPosition(pos) {
  if (!track) return;
  const { latitude: lat, longitude: lng, accuracy } = pos.coords;
  if (accuracy > 40) return; // ungenaue Positionen verwerfen
  const last = track.points[track.points.length - 1];
  if (last) { const d = L.latLng(last).distanceTo([lat, lng]); if (d < 4) return; track.dist += d; }
  track.points.push([lat, lng]);
  if (!track.line) { track.line = L.polyline(track.points, { color: '#2a7a3b', weight: 4 }); track.line.shotId = track.shotId; trackLayer.addLayer(track.line); } else track.line.setLatLngs(track.points);
  const mins = Math.round((Date.now() - track.startedAt) / 60000);
  $('#track-dist').textContent = fmtDist(track.dist); $('#track-info').textContent = `${mins} Min. · ${track.points.length} Punkte · Bildschirm anlassen`;
  if (Date.now() - track.lastSave > 20000) saveTrack(false);
}
async function saveTrack(ended) {
  if (!track) return; track.lastSave = Date.now();
  try { await api(`/shots/${track.shotId}/tracks/${track.trackId}`, { method: 'PUT', body: { points: track.points, ended }, silent: !ended }); } catch (e) { console.warn('Track speichern', e.message); }
}
$('#track-stop').onclick = async () => {
  if (!track) return;
  navigator.geolocation.clearWatch(track.watchId);
  await saveTrack(true);
  toast(`Aufzeichnung beendet: ${fmtDist(track.dist)}`);
  const sid = track.shotId; track = null; $('#track-box').classList.add('hidden'); loadTracksFor(sid);
};
// Foto verkleinern, damit es als Daten-URL in die Datenbank passt (max. 1280 px, JPEG)
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const max = 1280, scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.72));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bild konnte nicht gelesen werden')); };
    img.src = url;
  });
}
function shotDialog(sh) {
  const isNew = !sh.id;
  const when = sh.shot_at ? new Date(sh.shot_at) : new Date();
  const mine = state.checkins.active.find(c => c.user_id === state.me.id);
  const stands = state.revier.features.filter(f => f.kind === 'kanzel');
  const chosen = new Set((sh.signs || '').split(',').map(x => x.trim()).filter(Boolean));
  const dirs = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const curDir = Number.isFinite(sh.flight_bearing) ? dirs[Math.round(sh.flight_bearing / 22.5) % 16] : '';
  let photos = [];
  openDialog(`<h2>${isNew ? 'Anschuss markieren' : 'Anschuss bearbeiten'}</h2>
    <label>Wildart<input id="sh-species" list="species-list" maxlength="60" value="${esc(sh.species || '')}" placeholder="z. B. Schwarzwild, Rehwild (Bock)"><datalist id="species-list">${SPECIES.map(x => `<option value="${x}">`).join('')}</datalist></label>
    <label>Zeitpunkt des Schusses<input type="datetime-local" id="sh-time" value="${toLocalInput(when)}"></label>
    <label>Von welcher Kanzel<select id="sh-stand"><option value="">– keine / Pirsch –</option>${stands.map(f => `<option value="${f.id}" ${(sh.feature_id ?? mine?.feature_id) === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>
    <label>Fluchtrichtung (grob; den genauen Fluchtweg setzt du danach auf der Karte)<select id="sh-dir"><option value="">– unbekannt / später auf Karte setzen –</option>${dirs.map((d, i) => `<option value="${i * 22.5}" ${d === curDir ? 'selected' : ''}>${d} (${i * 22.5}°)</option>`).join('')}</select></label>
    <label>Pirschzeichen am Anschuss</label><div class="signs">${SHOT_SIGNS.map(x => `<label><input type="checkbox" value="${x}" ${chosen.has(x) ? 'checked' : ''}>${x}</label>`).join('')}</div>
    <label>Notiz<textarea id="sh-note" maxlength="1000" placeholder="Schusszeichen, Verhalten des Stücks, Entfernung, Trefferlage …">${esc(sh.note || '')}</textarea></label>
    <label>Fotos vom Anschuss<input type="file" id="sh-photos" accept="image/*" capture="environment" multiple></label>
    <div class="photo-grid" id="sh-preview"></div>
    <div class="row"><button class="btn primary" id="sh-save">${isNew ? 'Anschuss melden' : 'Speichern'}</button><button class="btn" data-close>Abbrechen</button></div>
    ${isNew ? '<p class="muted small">Alle Nutzer erhalten eine Push-Nachricht. Direkt danach tippst du den Fluchtweg Punkt für Punkt auf der Karte an. Über die Markierung lässt sich der Weg später bearbeiten, die Nachsuche aufzeichnen und der Stand melden.</p>' : ''}`, d => {
    $('#sh-photos', d).onchange = async () => {
      for (const f of [...$('#sh-photos', d).files].slice(0, 5 - photos.length)) { try { photos.push(await compressImage(f)); } catch (e) { toast(e.message, 'error'); } }
      $('#sh-preview', d).innerHTML = photos.map((p, i) => `<span class="ph"><img src="${p}" alt=""><button data-i="${i}">✕</button></span>`).join('');
      $$('#sh-preview button', d).forEach(b => b.onclick = () => { photos.splice(Number(b.dataset.i), 1); $('#sh-photos', d).onchange(); });
    };
    $('#sh-save', d).onclick = async () => {
      const body = { species: $('#sh-species', d).value, shot_at: new Date($('#sh-time', d).value).toISOString(), feature_id: $('#sh-stand', d).value || null,
        flight_bearing: $('#sh-dir', d).value === '' ? null : Number($('#sh-dir', d).value), signs: $$('.signs input:checked', d).map(x => x.value).join(', '),
        note: $('#sh-note', d).value, lat: sh.lat, lng: sh.lng, photos };
      if (!body.species.trim()) return toast('Bitte Wildart angeben', 'error');
      $('#sh-save', d).disabled = true;
      try {
        if (isNew) { const created = await api('/shots', { body }); toast('Anschuss gemeldet – jetzt den Fluchtweg auf der Karte setzen'); closeDialog(); await loadShots(); startPathEdit(state.shots.find(x => x.id === created.id) || created); return; }
        else { await api('/shots/' + sh.id, { method: 'PUT', body }); toast('Gespeichert'); }
        closeDialog();
      } catch (e) { toast(e.message, 'error'); $('#sh-save', d).disabled = false; }
    };
  });
}

// ---------- Fährten / Wildbeobachtungen ----------
const SPECIES = ['Schwarzwild', 'Rehwild', 'Rotwild', 'Damwild', 'Muffelwild', 'Fuchs', 'Dachs', 'Waschbär', 'Wolf', 'Sonstiges'];
const SIGHTING_KINDS = { faehrte: 'Fährte / Spuren', sichtung: 'Sichtung', losung: 'Losung', wuehlstelle: 'Wühlstelle', suhle: 'Suhle / Malbaum', wildschaden: 'Wildschaden', riss: 'Riss', fallwild: 'Fallwild', wildkamera: 'Wildkamera-Aufnahme' };
const spClass = sp => 'sp-' + sp.replace('ä', 'ae').replace('ö', 'oe').replace('ü', 'ue');
function ageText(iso) {
  const h = (Date.now() - new Date(iso).getTime()) / 3600e3;
  if (h < 1) return 'gerade eben'; if (h < 24) return `vor ${Math.round(h)} Std.`;
  const d = Math.floor(h / 24); return d === 1 ? 'gestern' : `vor ${d} Tagen`;
}
async function loadSightings() {
  state.sightings = await api('/sightings');
  renderSightings(); scheduleRender(renderSightingMarkers);
}
function renderSightingMarkers() {
  if (!map) return;
  sightingLayer.clearLayers();
  for (const sg of state.sightings) {
    const ageDays = (Date.now() - new Date(sg.observed_at).getTime()) / 86400e3;
    if (ageDays > 14) continue;
    const opacity = Math.max(0.35, 1 - ageDays / 16);
    const m = L.marker([sg.lat, sg.lng], { opacity, zIndexOffset: 500, draggable: canDrag(sg.user_id === state.me.id || !!state.me.is_admin),
      icon: L.divIcon({ className: '', html: `<div class="sighting ${spClass(sg.species)} ${ageDays < 1 ? 'fresh' : ''}"><span class="ico ico-faehrte"></span></div>`, iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -14] }) });
    m.bindTooltip(`${sg.species} · ${SIGHTING_KINDS[sg.kind] || sg.kind} · ${ageText(sg.observed_at)}`);
    m.on('dragend', async () => { const p = m.getLatLng(); await api('/sightings/' + sg.id, { method: 'PUT', body: { lat: p.lat, lng: p.lng } }); });
    m.on('click', () => {
      if (markerClickDuringPlacement(m.getLatLng())) return;
      const mine = sg.user_id === state.me.id || state.me.is_admin;
      openMarkerPopup(m, `<h3>${esc(sg.species)}</h3><div>${esc(SIGHTING_KINDS[sg.kind] || sg.kind)} · ${fmtDT(sg.observed_at)} (${ageText(sg.observed_at)})</div>
        ${sg.note ? `<div class="muted small">„${esc(sg.note)}“</div>` : ''}<div class="muted small">gemeldet von ${esc(sg.user_name || 'unbekannt')}</div>
        ${mine ? `<div class="row"><button class="btn sm" data-act="edit">Bearbeiten</button><button class="btn sm danger" data-act="del">Löschen</button></div>` : ''}`);
      const pop = m.getPopup().getElement();
      $('[data-act="edit"]', pop)?.addEventListener('click', () => { map.closePopup(); sightingDialog(sg); });
      $('[data-act="del"]', pop)?.addEventListener('click', async () => { if (confirm('Meldung löschen?')) { map.closePopup(); await api('/sightings/' + sg.id, { method: 'DELETE' }); } });
    });
    sightingLayer.addLayer(m);
  }
}
function renderSightings() {
  const recent = state.sightings.filter(sg => (Date.now() - new Date(sg.observed_at).getTime()) / 86400e3 <= 14);
  $('#sightings-count').textContent = recent.length ? `${recent.length} in den letzten 14 Tagen` : '';
  $('#sightings-list').innerHTML = recent.length ? recent.slice(0, 12).map(sg => `
    <div class="person sighting-item" data-id="${sg.id}" style="border-left-color:var(--antler);cursor:pointer"><span class="dot ${spClass(sg.species)}"><span class="ico ico-faehrte"></span></span>
      <div class="who"><b>${esc(sg.species)} · ${esc(SIGHTING_KINDS[sg.kind] || sg.kind)}</b><span>${sg.note ? esc(sg.note) + ' · ' : ''}${esc(sg.user_name || '')}</span></div>
      <div class="since">${ageText(sg.observed_at)}</div></div>`).join('')
    : '<p class="muted small">Keine aktuellen Fährten. Mit dem Werkzeug „Fährte“ auf der Karte melden.</p>';
  $$('#sightings-list [data-id]').forEach(el => el.onclick = () => { const sg = state.sightings.find(x => x.id === Number(el.dataset.id)); if (sg && map) map.setView([sg.lat, sg.lng], Math.max(map.getZoom(), 15)); });
}
function sightingDialog(sg) {
  const isNew = !sg.id;
  const when = sg.observed_at ? new Date(sg.observed_at) : new Date();
  openDialog(`<h2>${isNew ? 'Fährte / Beobachtung melden' : 'Meldung bearbeiten'}</h2>
    <label>Wildart<select id="sg-species">${SPECIES.map(x => `<option ${x === (sg.species || 'Schwarzwild') ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <label>Was<select id="sg-kind">${Object.entries(SIGHTING_KINDS).map(([k, v]) => `<option value="${k}" ${k === (sg.kind || 'faehrte') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label>Wann<div class="seg" id="sg-when"><button type="button" data-w="now">Jetzt</button><button type="button" data-w="night">Heute Nacht</button><button type="button" data-w="yesterday">Gestern</button><button type="button" data-w="custom">Genau</button></div>
      <input type="datetime-local" id="sg-time" value="${toLocalInput(when)}"></label>
    <label>Notiz<input id="sg-note" maxlength="300" value="${esc(sg.note || '')}" placeholder="z. B. Rotte mit Frischlingen Richtung Maisfeld"></label>
    <div class="row"><button class="btn primary" id="sg-save">${isNew ? 'Melden' : 'Speichern'}</button><button class="btn" data-close>Abbrechen</button></div>
    ${isNew ? '<p class="muted small">Alle Nutzer erhalten eine Push-Nachricht. Die Markierung verblasst mit der Zeit und verschwindet nach 14 Tagen von der Karte.</p>' : ''}`, d => {
    $$('#sg-when button', d).forEach(b => b.onclick = () => {
      const t = new Date();
      if (b.dataset.w === 'night') { t.setHours(2, 0, 0, 0); }
      if (b.dataset.w === 'yesterday') { t.setDate(t.getDate() - 1); t.setHours(18, 0, 0, 0); }
      if (b.dataset.w !== 'custom') $('#sg-time', d).value = toLocalInput(t);
      $$('#sg-when button', d).forEach(x => x.classList.toggle('active', x === b));
      if (b.dataset.w === 'custom') $('#sg-time', d).focus();
    });
    $('#sg-save', d).onclick = async () => {
      const body = { species: $('#sg-species', d).value, kind: $('#sg-kind', d).value, note: $('#sg-note', d).value, observed_at: new Date($('#sg-time', d).value).toISOString(), lat: sg.lat, lng: sg.lng };
      try {
        if (isNew) { await api('/sightings', { body }); toast('Fährte gemeldet'); }
        else { await api('/sightings/' + sg.id, { method: 'PUT', body }); toast('Gespeichert'); }
        closeDialog();
      } catch (e) { toast(e.message, 'error'); }
    };
  });
}

// ---------- Wetter ----------
const WMO = {
  0: ['Klar', '☀️'], 1: ['Überwiegend klar', '🌤️'], 2: ['Teils bewölkt', '⛅'], 3: ['Bedeckt', '☁️'], 45: ['Nebel', '🌫️'], 48: ['Reifnebel', '🌫️'],
  51: ['Leichter Nieselregen', '🌦️'], 53: ['Nieselregen', '🌦️'], 55: ['Starker Nieselregen', '🌧️'], 56: ['Gefrierender Niesel', '🌧️'], 57: ['Gefrierender Niesel', '🌧️'],
  61: ['Leichter Regen', '🌧️'], 63: ['Regen', '🌧️'], 65: ['Starker Regen', '🌧️'], 66: ['Gefrierender Regen', '🌧️'], 67: ['Gefrierender Regen', '🌧️'],
  71: ['Leichter Schneefall', '🌨️'], 73: ['Schneefall', '🌨️'], 75: ['Starker Schneefall', '❄️'], 77: ['Schneegriesel', '🌨️'],
  80: ['Regenschauer', '🌦️'], 81: ['Regenschauer', '🌧️'], 82: ['Heftige Schauer', '⛈️'], 85: ['Schneeschauer', '🌨️'], 86: ['Schneeschauer', '❄️'],
  95: ['Gewitter', '⛈️'], 96: ['Gewitter mit Hagel', '⛈️'], 99: ['Gewitter mit Hagel', '⛈️'],
};
const wmo = (code, isDay = 1) => { const w = WMO[code] || ['Unbekannt', '🌡️']; return isDay === 0 && code <= 1 ? [code === 0 ? 'Klar' : 'Überwiegend klar', '🌙'] : w; };
const moonIcon = i => ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'][i];

async function loadWeather() {
  try {
    const c = boundaryLayer?.getBounds().isValid() ? boundaryLayer.getBounds().getCenter() : state.revier.center;
    state.weather = await api(`/weather?lat=${c.lat}&lng=${c.lng}`);
    renderWeather(); renderWindBadge(); scheduleRender(renderMapFeatures); renderStandSelect();
  } catch (e) { $('#weather-content').innerHTML = `<div class="card"><p class="muted">Wetter konnte nicht geladen werden: ${esc(e.message)}</p></div>`; }
}
function huntingTip(w) {
  const tips = [];
  const cur = w.current;
  if (cur.wind_speed_10m < 8) tips.push('Schwacher Wind – Witterung trägt wenig, aber Wind kann drehen. Auf Thermik achten.');
  else if (cur.wind_speed_10m > 30) tips.push('Starker Wind – Wild ist unruhig und sichert stärker. Deckungsreiche Stände bevorzugen.');
  else tips.push(`Beständiger Wind aus ${compass(cur.wind_direction_10m)} – Ansitz so wählen, dass der Wind vom Wechsel zum Stand steht.`);
  if (cur.pressure_msl > 1020) tips.push('Hoher Luftdruck, stabile Lage – gute Aussichten auf Wildbewegung.');
  if (cur.pressure_msl < 1005) tips.push('Tiefdruck – vor Wetterwechseln ist Wild oft früher aktiv.');
  if (w.moon.illumination > 80) tips.push(`${w.moon.name} (${w.moon.illumination} %) – helle Nächte, Sauen kommen oft später.`);
  if (cur.precipitation > 0) tips.push('Niederschlag – nach dem Regen ziehen Wild gerne auf die Wiesen.');
  return tips.join(' ');
}
function renderWeather() {
  const w = state.weather; if (!w) return;
  const cur = w.current, [desc, icon] = wmo(cur.weather_code, cur.is_day);
  const nowIdx = Math.max(0, w.hourly.time.findIndex(t => new Date(t) >= new Date(Date.now() - 3600e3)));
  const hours = w.hourly.time.slice(nowIdx, nowIdx + 24).map((t, i) => ({ i: nowIdx + i, t }));
  const sunrise = w.daily.sunrise[0], sunset = w.daily.sunset[0];
  const dir = cur.wind_direction_10m;
  $('#weather-content').innerHTML = `
    <div class="weather-hero">
      <div><div class="temp">${Math.round(cur.temperature_2m)}°</div><div class="desc">${desc}</div>
        <div class="meta">Gefühlt ${Math.round(cur.apparent_temperature)}° · Luftfeuchte ${cur.relative_humidity_2m} % · ${Math.round(cur.pressure_msl)} hPa</div>
        <div class="meta">🌅 ${fmtTime(sunrise)} · 🌇 ${fmtTime(sunset)} · ${moonIcon(w.moon.index)} ${w.moon.name} ${w.moon.illumination} %</div></div>
      <div class="icon">${icon}</div>
    </div>
    <div class="card"><h2>Wind</h2>
      <div class="wind-card">
        <svg class="compass" viewBox="0 0 170 170">
          <circle class="ring" cx="85" cy="85" r="78"/>
          ${[...Array(16)].map((_, i) => { const a = i * 22.5 * Math.PI / 180, r1 = i % 4 === 0 ? 62 : 70; return `<line class="tick" x1="${85 + Math.sin(a) * r1}" y1="${85 - Math.cos(a) * r1}" x2="${85 + Math.sin(a) * 76}" y2="${85 - Math.cos(a) * 76}"/>`; }).join('')}
          <text x="85" y="22" text-anchor="middle">N</text><text x="150" y="90" text-anchor="middle">O</text><text x="85" y="156" text-anchor="middle">S</text><text x="20" y="90" text-anchor="middle">W</text>
          <g class="needle" style="transform:rotate(${dir + 180}deg)"><path d="M85 28 L96 62 L85 56 L74 62 Z"/><rect x="82" y="56" width="6" height="56" rx="3" fill="var(--forest)"/></g>
          <circle cx="85" cy="85" r="6" fill="var(--antler)"/>
        </svg>
        <div class="grid">
          <div class="stat"><div class="label">Richtung</div><div class="value">${compass(dir)} <small>${Math.round(dir)}° – Wind weht nach ${compass((dir + 180) % 360)}</small></div></div>
          <div class="stat"><div class="label">Geschwindigkeit</div><div class="value">${Math.round(cur.wind_speed_10m)} <small>km/h</small></div></div>
          <div class="stat"><div class="label">Böen</div><div class="value">${Math.round(cur.wind_gusts_10m)} <small>km/h</small></div></div>
          <div class="stat"><div class="label">Bewölkung</div><div class="value">${cur.cloud_cover} <small>%</small></div></div>
        </div>
      </div>
      <div class="hunt-tip">🦌 ${huntingTip(w)}</div>
    </div>
    ${renderWindStandsCard()}
    ${renderSeasonsTodayCard()}
    <div class="card"><h2>Nächste 24 Stunden</h2>
      <div class="hourly">${hours.map(({ i, t }, k) => { const [, ic] = wmo(w.hourly.weather_code[i], new Date(t) > new Date(sunrise) && new Date(t) < new Date(sunset) ? 1 : 0); return `
        <div class="hour ${k === 0 ? 'now' : ''}"><div>${fmtTime(t)}</div><div>${ic}</div><div class="t">${Math.round(w.hourly.temperature_2m[i])}°</div>
        <div class="w"><span class="arrow" style="transform:rotate(${w.hourly.wind_direction_10m[i] + 180}deg)">⬆</span> ${Math.round(w.hourly.wind_speed_10m[i])}</div>
        <div class="w">💧 ${w.hourly.precipitation_probability[i] ?? 0} %</div></div>`; }).join('')}</div>
    </div>
    <div class="card"><h2>7-Tage-Vorhersage</h2>
      <div class="daily">${w.daily.time.map((t, i) => { const [d, ic] = wmo(w.daily.weather_code[i]); return `
        <div class="day"><div>${new Date(t).toLocaleDateString('de-DE', { weekday: 'short' })}</div><div>${ic}</div><div>${d}<div class="wind">Wind ${compass(w.daily.wind_direction_10m_dominant[i])} ${Math.round(w.daily.wind_speed_10m_max[i])} km/h · Böen ${Math.round(w.daily.wind_gusts_10m_max[i])} · 💧 ${w.daily.precipitation_probability_max[i] ?? 0} % · 🌅 ${fmtTime(w.daily.sunrise[i])} 🌇 ${fmtTime(w.daily.sunset[i])}</div></div>
        <div class="range">${Math.round(w.daily.temperature_2m_max[i])}° / ${Math.round(w.daily.temperature_2m_min[i])}°</div></div>`; }).join('')}</div>
      <p class="muted small">Stand: ${fmtDT(w.fetched_at)} · Daten: Open-Meteo</p>
    </div>`;
}

// ---------- Drückjagd ----------
const ROLE_NAMES = { jagdleiter: 'Jagdleiter', schuetze: 'Schütze', treiber: 'Treiber', hundefuehrer: 'Hundeführer', ansteller: 'Ansteller', helfer: 'Helfer' };
const HUNT_STATUS = { planung: ['In Planung', 'warn'], bestaetigt: ['Bestätigt', 'ok'], abgeschlossen: ['Abgeschlossen', ''], abgesagt: ['Abgesagt', 'danger'] };
const HUNT_TYPES = { drueckjagd: 'Drückjagd', ansitz: 'Gemeinschaftsansitz', buschieren: 'Buschieren', vogeljagd: 'Vogeljagd / Entenstrich', frettieren: 'Frettieren', fallenjagd: 'Fallenjagd', revierarbeit: 'Revierarbeit', sonstiges: 'Sonstiges' };
const EVENT_STATUS = { zusage: ['Zusage', 'ok'], vielleicht: ['Vielleicht', 'warn'], absage: ['Absage', 'danger'], offen: ['Offen', ''] };
async function loadHunts() { state.hunts = await api('/hunts'); if (state.view === 'jagd' && !state.hunt) renderHunts(); }
async function loadEvents() { state.events = await api('/events'); if (state.view === 'jagd' && !state.hunt) renderHunts(); }
function renderEvents() {
  const today = new Date().toISOString().slice(0, 10);
  const list = state.events.filter(e => e.date >= today);
  return `<div class="row" style="justify-content:space-between;margin:1.2rem 0 .8rem"><h2 style="margin:0">Termine</h2><button class="btn" id="btn-new-event">+ Termin</button></div>
    ${list.length ? list.map(e => { const d = new Date(e.date); const mine = e.responses.find(r => r.user_id === state.me.id); const yes = e.responses.filter(r => r.status === 'zusage'); return `
      <div class="event" id="termin-${e.id}" data-id="${e.id}">
        <div class="date-box"><b>${d.getDate()}</b><span>${d.toLocaleDateString('de-DE', { month: 'short' })}</span></div>
        <div><div class="row" style="justify-content:space-between"><h3>${esc(e.title)}</h3><button class="btn sm" data-edit-event="${e.id}">Bearbeiten</button></div>
          <div class="muted small">${d.toLocaleDateString('de-DE', { weekday: 'long' })}${e.time ? ' · ' + esc(e.time) + ' Uhr' : ''}${e.place ? ' · ' + esc(e.place) : ''}</div>
          ${e.description ? `<div class="small" style="white-space:pre-wrap;margin-top:.3rem">${esc(e.description)}</div>` : ''}
          <div class="resp">${['zusage', 'vielleicht', 'absage'].map(k => `<button class="btn sm ${mine?.status === k ? 'active' : ''}" data-resp="${k}">${EVENT_STATUS[k][0]}</button>`).join('')}</div>
          <div class="inline-form" style="margin-top:.4rem"><label>Ich bringe mit<input data-brings maxlength="200" value="${esc(mine?.brings || '')}" placeholder="z. B. Beamer, Kuchen"></label><button class="btn sm" data-brings-save>OK</button></div>
          <div class="receipts" style="margin-top:.5rem">${e.responses.length ? e.responses.map(r => `<span class="chip ${r.status === 'zusage' ? 'confirmed' : r.status === 'vielleicht' ? 'read' : ''}">${r.status === 'zusage' ? '✓' : r.status === 'absage' ? '✕' : '?'} ${esc(r.user_name)}${r.brings ? ' – ' + esc(r.brings) : ''}</span>`).join('') : '<span class="muted small">Noch keine Rückmeldungen</span>'}</div>
          <div class="muted small" style="margin-top:.3rem">${yes.length} Zusage${yes.length === 1 ? '' : 'n'}</div>
        </div></div>`; }).join('') : '<div class="card"><p class="muted small">Keine anstehenden Termine. Trage Hegeringsitzung, Trophäenschau oder Revierversammlung ein – alle werden benachrichtigt.</p></div>'}`;
}
function bindEvents(root) {
  $('#btn-new-event', root)?.addEventListener('click', () => eventDialog());
  $$('[data-edit-event]', root).forEach(b => b.onclick = () => eventDialog(state.events.find(e => e.id === Number(b.dataset.editEvent))));
  $$('.event [data-resp]', root).forEach(b => b.onclick = async () => { const id = Number(b.closest('.event').dataset.id); try { await api(`/events/${id}/respond`, { body: { status: b.dataset.resp } }); } catch (e) { toast(e.message, 'error'); } });
  $$('.event [data-brings-save]', root).forEach(b => b.onclick = async () => { const el = b.closest('.event'); try { await api(`/events/${el.dataset.id}/respond`, { body: { brings: $('[data-brings]', el).value } }); toast('Gespeichert'); } catch (e) { toast(e.message, 'error'); } });
}
function eventDialog(e = null) {
  openDialog(`<h2>${e ? 'Termin bearbeiten' : 'Neuer Termin'}</h2>
    <label>Titel<input id="ev-title" maxlength="120" value="${esc(e?.title || '')}" placeholder="z. B. Hegeringsitzung, Trophäenschau"></label>
    <label>Datum<input id="ev-date" type="date" value="${esc(e?.date || '')}"></label>
    <label>Uhrzeit<input id="ev-time" type="time" value="${esc(e?.time || '')}"></label>
    <label>Ort<input id="ev-place" maxlength="200" value="${esc(e?.place || '')}"></label>
    <label>Beschreibung<textarea id="ev-desc" maxlength="4000" placeholder="Tagesordnung, Hinweise, was mitzubringen ist …">${esc(e?.description || '')}</textarea></label>
    <div class="row"><button class="btn primary" id="ev-save">Speichern</button>${e ? '<button class="btn danger" id="ev-del">Löschen</button>' : ''}<button class="btn" data-close>Abbrechen</button></div>`, d => {
    $('#ev-save', d).onclick = async () => {
      const body = { title: $('#ev-title', d).value, date: $('#ev-date', d).value, time: $('#ev-time', d).value, place: $('#ev-place', d).value, description: $('#ev-desc', d).value };
      try { if (e) await api('/events/' + e.id, { method: 'PUT', body }); else await api('/events', { body }); closeDialog(); } catch (err) { toast(err.message, 'error'); }
    };
    $('#ev-del', d)?.addEventListener('click', async () => { if (confirm('Termin löschen?')) { await api('/events/' + e.id, { method: 'DELETE' }); closeDialog(); } });
  });
}
async function loadHunt(id) { try { state.hunt = await api('/hunts/' + id); renderHuntDetail(); } catch { state.hunt = null; renderHunts(); } }
function renderHunts() {
  $('#hunts-content').innerHTML = `
    <div class="row" style="justify-content:space-between;margin-bottom:.8rem"><h2 style="margin:0">Jagden</h2><button class="btn primary" id="btn-new-hunt">+ Neue Jagd</button></div>
    <div class="hunt-list">${state.hunts.length ? state.hunts.map(h => { const d = new Date(h.date); const [s, cls] = HUNT_STATUS[h.status]; return `
      <div class="hunt" data-id="${h.id}">
        <div class="date-box"><b>${d.getDate()}</b><span>${d.toLocaleDateString('de-DE', { month: 'short' })} ${d.getFullYear()}</span></div>
        <div><h3>${esc(h.title)} <span class="hunt-type">${HUNT_TYPES[h.type] || 'Jagd'}</span></h3><div class="muted small">${h.leader ? 'Leitung: ' + esc(h.leader) + ' · ' : ''}${h.participant_count} Teilnehmer${h.meet_time ? ' · Treffen ' + esc(h.meet_time) : ''}</div></div>
        <span class="status-tag ${cls}">${s}</span></div>`; }).join('') : '<div class="card"><p class="muted">Noch keine Jagd geplant. Drückjagd, Gemeinschaftsansitz, Buschieren, Vogeljagd, Frettieren oder Revierarbeit anlegen – alle Nutzer werden benachrichtigt.</p></div>'}</div>
    ${renderEvents()}`;
  $('#btn-new-hunt').onclick = () => editHuntDialog();
  $$('.hunt', $('#hunts-content')).forEach(el => el.onclick = () => { location.hash = 'jagd-' + el.dataset.id; });
  bindEvents($('#hunts-content'));
}
function editHuntDialog(h = null) {
  openDialog(`<h2>${h ? 'Jagd bearbeiten' : 'Neue Jagd planen'}</h2>
    <label>Jagdart<select id="h-type">${Object.entries(HUNT_TYPES).map(([k, v]) => `<option value="${k}" ${k === (h?.type || 'drueckjagd') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label>Titel<input id="h-title" value="${esc(h?.title || '')}" placeholder="z. B. Herbstdrückjagd Nordrevier, Entenstrich am Teich" maxlength="120"></label>
    <label>Datum<input id="h-date" type="date" value="${esc(h?.date || '')}"></label>
    <label>Treffpunkt-Zeit<input id="h-time" type="time" value="${esc(h?.meet_time || '08:00')}"></label>
    <label>Treffpunkt<input id="h-point" value="${esc(h?.meet_point || '')}" placeholder="z. B. Parkplatz Forsthaus" maxlength="200"></label>
    <label>Leitung / Organisation<input id="h-leader" value="${esc(h?.leader || '')}" maxlength="80"></label>
    ${h ? `<label>Status<select id="h-status">${Object.entries(HUNT_STATUS).map(([k, [v]]) => `<option value="${k}" ${k === h.status ? 'selected' : ''}>${v}</option>`).join('')}</select></label>` : ''}
    <label>Beschreibung / Belehrung<textarea id="h-desc" maxlength="4000" placeholder="Freigabe, Sicherheitshinweise, Signale, Ablauf …">${esc(h?.description || '')}</textarea></label>
    <div class="row"><button class="btn primary" id="h-save">Speichern</button>${h ? '<button class="btn danger" id="h-del">Löschen</button>' : ''}<button class="btn" data-close>Abbrechen</button></div>`, d => {
    $('#h-save', d).onclick = async () => {
      const body = { type: $('#h-type', d).value, title: $('#h-title', d).value, date: $('#h-date', d).value, meet_time: $('#h-time', d).value, meet_point: $('#h-point', d).value, leader: $('#h-leader', d).value, description: $('#h-desc', d).value, status: $('#h-status', d)?.value };
      try {
        const r = h ? await api('/hunts/' + h.id, { method: 'PUT', body }) : await api('/hunts', { body });
        closeDialog(); location.hash = 'jagd-' + r.id; state.hunt = r; renderHuntDetail();
      } catch (e) { toast(e.message, 'error'); }
    };
    $('#h-del', d)?.addEventListener('click', async () => { if (confirm('Jagd wirklich löschen?')) { await api('/hunts/' + h.id, { method: 'DELETE' }); closeDialog(); state.hunt = null; location.hash = 'jagd'; renderHunts(); } });
  });
}
function renderHuntDetail() {
  const h = state.hunt; if (!h) return renderHunts();
  const [s, cls] = HUNT_STATUS[h.status];
  const stands = state.revier.features.filter(f => f.kind === 'kanzel');
  const isDrive = h.type === 'drueckjagd' || !h.type;
  const tabs = { uebersicht: 'Übersicht', teilnehmer: `Teilnehmer (${h.participants.length})`, ...(isDrive ? { treiben: `Treiben (${h.drives.length})` } : {}), material: `Material (${h.items.length})`, checkliste: `Checkliste (${h.tasks.filter(t => t.done).length}/${h.tasks.length})`, strecke: `Strecke (${h.bag.reduce((a, b) => a + b.count, 0)})` };
  if (!tabs[state.huntTab]) state.huntTab = 'uebersicht';
  const byRole = r => h.participants.filter(p => p.role === r).length;
  let body = '';
  if (state.huntTab === 'uebersicht') body = `<div class="card">
      <dl class="kv"><dt>Datum</dt><dd>${new Date(h.date).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}</dd>
      <dt>Treffen</dt><dd>${esc(h.meet_time || '–')} ${h.meet_point ? ' · ' + esc(h.meet_point) : ''}</dd>
      <dt>Jagdleitung</dt><dd>${esc(h.leader || '–')}</dd>
      <dt>Angelegt von</dt><dd>${esc(h.created_by_name || '–')}</dd></dl>
      ${h.description ? `<h3 style="margin-top:.8rem">Beschreibung / Belehrung</h3><p style="white-space:pre-wrap">${esc(h.description)}</p>` : ''}
    </div>
    <div class="grid">
      <div class="stat"><div class="label">Schützen</div><div class="value">${byRole('schuetze')}</div></div>
      <div class="stat"><div class="label">Treiber</div><div class="value">${byRole('treiber')}</div></div>
      <div class="stat"><div class="label">Hundeführer</div><div class="value">${byRole('hundefuehrer')}</div></div>
      <div class="stat"><div class="label">Zugesagt</div><div class="value">${h.participants.filter(p => p.confirmed).length} <small>/ ${h.participants.length}</small></div></div>
    </div>
    <div class="card" style="margin-top:1rem"><h2>Standverteilung</h2>${stands.length ? `<table class="table"><tr><th>Stand</th><th>Schütze</th><th>Treiben</th></tr>${stands.map(f => { const p = h.participants.find(x => x.feature_id === f.id); return `<tr><td><b>${esc(f.name)}</b></td><td>${p ? esc(p.name) : '<span class="muted">frei</span>'}</td><td>${p?.drive_id ? esc(h.drives.find(d => d.id === p.drive_id)?.name || '') : ''}</td></tr>`; }).join('')}</table>` : '<p class="muted small">Keine Kanzeln auf der Karte angelegt.</p>'}</div>`;

  if (state.huntTab === 'teilnehmer') body = `<div class="card">
      <div class="table-wrap"><table class="table"><tr><th>Name</th><th>Rolle</th><th>Stand</th><th>Treiben</th><th>Zusage</th><th></th></tr>
      ${h.participants.map(p => `<tr data-pid="${p.id}">
        <td><b>${esc(p.name)}</b>${p.phone ? `<div class="muted small">${esc(p.phone)}</div>` : ''}${p.notes ? `<div class="muted small">${esc(p.notes)}</div>` : ''}</td>
        <td><select data-f="role">${Object.entries(ROLE_NAMES).map(([k, v]) => `<option value="${k}" ${k === p.role ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
        <td><select data-f="feature_id"><option value="">–</option>${stands.map(f => `<option value="${f.id}" ${f.id === p.feature_id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></td>
        <td><select data-f="drive_id"><option value="">–</option>${h.drives.map(d => `<option value="${d.id}" ${d.id === p.drive_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></td>
        <td><input type="checkbox" data-f="confirmed" ${p.confirmed ? 'checked' : ''}></td>
        <td><button class="btn sm danger" data-del="${p.id}">✕</button></td></tr>`).join('')}
      </table></div>
      <div class="inline-form"><label>Neuer Teilnehmer<input id="p-name" placeholder="Name" maxlength="80"></label>
        <label>Rolle<select id="p-role">${Object.entries(ROLE_NAMES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label>Telefon<input id="p-phone" placeholder="optional" maxlength="40"></label><button class="btn primary" id="p-add">Hinzufügen</button></div>
      <p class="muted small">Tipp: Alle Nutzer dieser App als Teilnehmer: ${state.users.map(u => `<a href="#" data-quick="${esc(u.name)}">${esc(u.name)}</a>`).join(', ')}</p>
    </div>`;

  if (state.huntTab === 'treiben') body = `<div class="card">
      ${h.drives.length ? h.drives.map(d => `<div class="plan" data-did="${d.id}"><div class="plan-head"><div><div class="time">${esc(d.name)}</div><div class="muted small">${esc(d.start_time || '–')} – ${esc(d.end_time || '–')} · ${h.participants.filter(p => p.drive_id === d.id).length} Personen</div></div>
        <div class="row"><button class="btn sm" data-edit-drive="${d.id}">Bearbeiten</button><button class="btn sm danger" data-del-drive="${d.id}">✕</button></div></div>
        ${d.notes ? `<div class="note">${esc(d.notes)}</div>` : ''}
        <div class="muted small">${h.participants.filter(p => p.drive_id === d.id).map(p => `${esc(p.name)} (${ROLE_NAMES[p.role]}${p.feature_name ? ', ' + esc(p.feature_name) : ''})`).join(' · ')}</div></div>`).join('') : '<p class="muted">Noch keine Treiben angelegt.</p>'}
      <div class="inline-form"><label>Neues Treiben<input id="d-name" placeholder="z. B. Treiben 1 – Buchenhang" maxlength="80"></label><label>Von<input id="d-start" type="time" value="09:00"></label><label>Bis<input id="d-end" type="time" value="11:00"></label><button class="btn primary" id="d-add">Anlegen</button></div>
    </div>`;

  if (state.huntTab === 'material') body = `<div class="card">
      <p class="muted small">Was wird gebraucht und wer bringt es mit? Trage dich bei freien Positionen ein.</p>
      ${h.items.length ? h.items.map(it => `<div class="task ${it.done ? 'done' : ''}" data-iid="${it.id}"><input type="checkbox" ${it.done ? 'checked' : ''} title="Erledigt / eingepackt"><span><b>${esc(it.text)}</b> ${it.person ? `<em class="muted small">– bringt ${esc(it.person)}</em>` : `<button class="btn sm" data-take="${it.id}">Ich bringe das mit</button>`}</span><button class="btn sm" data-del-item="${it.id}">✕</button></div>`).join('') : '<p class="muted">Noch nichts eingetragen.</p>'}
      <div class="inline-form"><label>Material<input id="i-text" placeholder="z. B. Wildwanne, Funkgeräte, Kaffee" maxlength="200"></label><label>Bringt mit<input id="i-who" placeholder="optional" maxlength="80" value=""></label><button class="btn primary" id="i-add">Hinzufügen</button></div>
    </div>`;

  if (state.huntTab === 'checkliste') body = `<div class="card">
      ${h.tasks.map(t => `<div class="task ${t.done ? 'done' : ''}" data-tid="${t.id}"><input type="checkbox" ${t.done ? 'checked' : ''}><span>${esc(t.text)}${t.assignee ? ` <em class="muted small">– ${esc(t.assignee)}</em>` : ''}</span><button class="btn sm" data-del-task="${t.id}">✕</button></div>`).join('')}
      <div class="inline-form"><label>Neue Aufgabe<input id="t-text" placeholder="Was ist zu erledigen?" maxlength="200"></label><label>Zuständig<input id="t-who" placeholder="optional" maxlength="80"></label><button class="btn primary" id="t-add">Hinzufügen</button></div>
    </div>`;

  if (state.huntTab === 'strecke') body = `<div class="card">
      ${h.bag.length ? `<table class="table"><tr><th>Wildart</th><th>Stück</th><th>Erleger</th><th>Notiz</th><th></th></tr>${h.bag.map(b => `<tr><td><b>${esc(b.species)}</b></td><td>${b.count}</td><td>${esc(b.shooter)}</td><td class="muted small">${esc(b.notes)}</td><td><button class="btn sm" data-del-bag="${b.id}">✕</button></td></tr>`).join('')}</table>` : '<p class="muted">Noch keine Strecke erfasst.</p>'}
      <div class="row" style="margin-top:.5rem"><button class="btn sm" id="b-print">Streckenmeldung drucken / PDF</button></div>
      <div class="inline-form"><label>Wildart<select id="b-species">${speciesOptions()}</select></label>
        <label>Stück<input id="b-count" type="number" min="1" value="1"></label><label>Erleger<input id="b-shooter" maxlength="80" list="shooter-list"><datalist id="shooter-list">${h.participants.map(p => `<option value="${esc(p.name)}">`).join('')}</datalist></label><label>Notiz<input id="b-notes" maxlength="300"></label><button class="btn primary" id="b-add">Eintragen</button></div>
    </div>`;

  $('#hunts-content').innerHTML = `
    <button class="back" id="btn-back">← Alle Jagden und Termine</button>
    <div class="row" style="justify-content:space-between;align-items:flex-start"><div><h2 style="margin:0">${esc(h.title)}</h2><div class="muted"><span class="hunt-type">${HUNT_TYPES[h.type] || 'Jagd'}</span> ${fmtDate(h.date)} · <span class="status-tag ${cls}">${s}</span></div></div><button class="btn sm" id="btn-edit-hunt">Bearbeiten</button></div>
    <div class="tabs">${Object.entries(tabs).map(([k, v]) => `<button data-tab="${k}" class="${k === state.huntTab ? 'active' : ''}">${v}</button>`).join('')}</div>
    ${body}`;
  const root = $('#hunts-content');
  $('#btn-back').onclick = () => { state.hunt = null; location.hash = 'jagd'; };
  $('#btn-edit-hunt').onclick = () => editHuntDialog(h);
  $$('.tabs button', root).forEach(b => b.onclick = () => { state.huntTab = b.dataset.tab; renderHuntDetail(); });
  const H = `/hunts/${h.id}`;
  const act = async (fn) => { try { state.hunt = await fn(); renderHuntDetail(); } catch (e) { toast(e.message, 'error'); } };
  // Teilnehmer
  $$('tr[data-pid] [data-f]', root).forEach(el => el.onchange = () => {
    const pid = el.closest('tr').dataset.pid; const f = el.dataset.f;
    const val = el.type === 'checkbox' ? el.checked : (el.value === '' ? null : (f === 'role' ? el.value : Number(el.value)));
    act(() => api(`${H}/participants/${pid}`, { method: 'PUT', body: { [f]: val } }));
  });
  $$('[data-del]', root).forEach(b => b.onclick = () => act(() => api(`${H}/participants/${b.dataset.del}`, { method: 'DELETE' })));
  $('#p-add', root)?.addEventListener('click', () => act(() => api(`${H}/participants`, { body: { name: $('#p-name').value, role: $('#p-role').value, phone: $('#p-phone').value } })));
  $$('[data-quick]', root).forEach(a => a.onclick = e => { e.preventDefault(); $('#p-name').value = a.dataset.quick; });
  // Treiben
  $('#d-add', root)?.addEventListener('click', () => act(() => api(`${H}/drives`, { body: { name: $('#d-name').value, start_time: $('#d-start').value, end_time: $('#d-end').value } })));
  $$('[data-del-drive]', root).forEach(b => b.onclick = () => confirm('Treiben löschen?') && act(() => api(`${H}/drives/${b.dataset.delDrive}`, { method: 'DELETE' })));
  $$('[data-edit-drive]', root).forEach(b => b.onclick = () => {
    const d = h.drives.find(x => x.id === Number(b.dataset.editDrive));
    openDialog(`<h2>Treiben bearbeiten</h2><label>Name<input id="e-name" value="${esc(d.name)}"></label><label>Von<input id="e-start" type="time" value="${esc(d.start_time)}"></label><label>Bis<input id="e-end" type="time" value="${esc(d.end_time)}"></label><label>Notizen (Anstellen, Ablauf, Signale)<textarea id="e-notes">${esc(d.notes)}</textarea></label><div class="row"><button class="btn primary" id="e-save">Speichern</button><button class="btn" data-close>Abbrechen</button></div>`, dlg => {
      $('#e-save', dlg).onclick = () => { closeDialog(); act(() => api(`${H}/drives/${d.id}`, { method: 'PUT', body: { name: $('#e-name', dlg).value, start_time: $('#e-start', dlg).value, end_time: $('#e-end', dlg).value, notes: $('#e-notes', dlg).value } })); };
    });
  });
  // Material
  $$('.task[data-iid] input[type=checkbox]', root).forEach(c => c.onchange = () => act(() => api(`${H}/items/${c.closest('.task').dataset.iid}`, { method: 'PUT', body: { done: c.checked } })));
  $$('[data-take]', root).forEach(b => b.onclick = () => act(() => api(`${H}/items/${b.dataset.take}`, { method: 'PUT', body: { person: state.me.name } })));
  $$('[data-del-item]', root).forEach(b => b.onclick = () => act(() => api(`${H}/items/${b.dataset.delItem}`, { method: 'DELETE' })));
  $('#i-add', root)?.addEventListener('click', () => act(() => api(`${H}/items`, { body: { text: $('#i-text').value, person: $('#i-who').value } })));
  // Checkliste
  $$('.task[data-tid] input[type=checkbox]', root).forEach(c => c.onchange = () => act(() => api(`${H}/tasks/${c.closest('.task').dataset.tid}`, { method: 'PUT', body: { done: c.checked } })));
  $$('[data-del-task]', root).forEach(b => b.onclick = () => act(() => api(`${H}/tasks/${b.dataset.delTask}`, { method: 'DELETE' })));
  $('#t-add', root)?.addEventListener('click', () => act(() => api(`${H}/tasks`, { body: { text: $('#t-text').value, assignee: $('#t-who').value } })));
  // Strecke
  $('#b-add', root)?.addEventListener('click', () => { if (!seasonConfirm($('#b-species').value, h.date)) return; act(() => api(`${H}/bag`, { body: { species: $('#b-species').value, count: $('#b-count').value, shooter: $('#b-shooter').value, notes: $('#b-notes').value } })); });
  $('#b-print', root)?.addEventListener('click', () => printHuntBag(h));
  $$('[data-del-bag]', root).forEach(b => b.onclick = () => act(() => api(`${H}/bag/${b.dataset.delBag}`, { method: 'DELETE' })));
}

// ===================== Revierbuch (Bereich „Mehr“) =====================
async function loadSeasons() { try { const r = await api('/seasons'); state.seasons = r.seasons; state.seasonsNote = r.note; } catch {} }
async function loadContacts() { state.contacts = await api('/contacts'); if (state.mehrPage === 'kontakte') renderMehr(); }
async function loadTasks() { state.tasks = await api('/tasks'); if (state.mehrPage === 'arbeiten') renderMehr(); }
async function loadHarvest(season) {
  const want = typeof season === 'string' && /^\d{4}\/\d{2}$/.test(season) ? season : state.harvest?.season;
  state.harvest = await api('/harvest' + (want ? `?season=${encodeURIComponent(want)}` : ''));
  if (state.mehrPage === 'strecke') renderMehr();
}
async function loadIncidents() { state.incidents = await api('/incidents'); scheduleRender(renderIncidentMarkers); if (state.mehrPage === 'vorfaelle') renderMehr(); }

// Jagdzeiten
function seasonFor(species) { return state.seasons.find(x => x.species === species) || state.seasons.find(x => species && (x.species.startsWith(species) || species.startsWith(x.species))); }
function inSeason(entry, date) {
  if (!entry) return null; if (!entry.from || !entry.to) return true;
  const md = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return entry.from <= entry.to ? (md >= entry.from && md <= entry.to) : (md >= entry.from || md <= entry.to);
}
const fmtMd = md => md ? `${md.slice(3)}.${md.slice(0, 2)}.` : '';
function speciesOptions(selected) { return (state.seasons.length ? state.seasons.map(x => x.species) : ['Rehwild', 'Schwarzwild', 'Rotwild', 'Damwild', 'Fuchs', 'Sonstiges']).concat(['Sonstiges']).map(x => `<option ${x === selected ? 'selected' : ''}>${esc(x)}</option>`).join(''); }
function seasonConfirm(species, dateStr) {
  const e = seasonFor(species); const ok = inSeason(e, dateStr ? new Date(dateStr) : new Date());
  if (ok === false) return confirm(`Achtung: Für „${species}“ ist am ${fmtDate(dateStr || new Date().toISOString())} Schonzeit (Jagdzeit ${fmtMd(e.from)} – ${fmtMd(e.to)}). Trotzdem eintragen?`);
  return true;
}
function renderSeasonsTodayCard() {
  if (!state.seasons.length) return '';
  const today = new Date();
  const open = state.seasons.filter(x => inSeason(x, today)), closed = state.seasons.filter(x => !inSeason(x, today));
  return `<div class="card"><h2>Jagdzeiten heute</h2><div class="receipts">${open.map(x => `<span class="chip confirmed">${esc(x.species)}</span>`).join('')}</div>
    ${closed.length ? `<p class="muted small" style="margin-top:.5rem">Schonzeit: ${closed.map(x => esc(x.species)).join(', ')}</p>` : ''}<p class="muted small">${esc(state.seasonsNote)} Änderbar unter Mehr → Jagdzeiten.</p></div>`;
}
function renderWindStandsCard() {
  const w = state.weather?.current; const stands = state.revier.features.filter(f => f.kind === 'kanzel' && f.wind_dirs);
  if (!w || !stands.length) return '';
  const good = stands.filter(windSuits), bad = stands.filter(f => !windSuits(f));
  return `<div class="card"><h2>Kanzeln bei ${compass8(w.wind_direction_10m)}-Wind</h2>
    <div class="receipts">${good.map(f => `<span class="chip confirmed">✓ ${esc(f.name)}</span>`).join('')}${bad.map(f => `<span class="chip">✕ ${esc(f.name)}</span>`).join('')}</div>
    <p class="muted small">Die guten Windrichtungen trägst du je Kanzel unter „Bearbeiten“ ein. Kanzeln ohne Angabe fehlen hier.</p></div>`;
}

// Druck / PDF
function openPrint(title, bodyHtml) {
  // Druckansicht innerhalb der App (kein neues Fenster: auf dem iPhone als Web-App gäbe es sonst keinen Weg zurück)
  const view = $('#print-view');
  $('#print-title').textContent = title;
  $('#print-body').innerHTML = `${bodyHtml}<p class="muted">Erstellt mit RevierApp am ${fmtDT(new Date().toISOString())}</p>`;
  view.classList.remove('hidden'); document.body.classList.add('printing'); window.scrollTo(0, 0);
  if (!history.state?.print) history.pushState({ print: 1 }, '', location.href);
}
function closePrint(fromHistory) {
  const view = $('#print-view');
  if (view.classList.contains('hidden')) return;
  view.classList.add('hidden'); document.body.classList.remove('printing');
  if (!fromHistory && history.state?.print) history.back();
}
function printNow() {
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  try { window.print(); } catch {}
  if (standalone) setTimeout(() => toast('Kein Druckdialog? Dann die App im Browser (Safari/Chrome) öffnen und dort drucken bzw. als PDF teilen'), 1500);
}
window.addEventListener('popstate', () => closePrint(true));
$('#print-close').onclick = () => closePrint(false);
$('#print-go').onclick = printNow;
function printHuntBag(h) {
  const rows = h.bag.map(b => `<tr><td>${esc(b.species)}</td><td>${b.count}</td><td>${esc(b.shooter)}</td><td>${esc(b.notes)}</td></tr>`).join('');
  openPrint(`Streckenmeldung ${h.title}`, `<h1>Streckenmeldung</h1><div class="muted">${esc(state.revier.name)}</div>
    <h2>${esc(h.title)}</h2><p>${HUNT_TYPES[h.type] || 'Jagd'} am ${fmtDate(h.date)}${h.meet_point ? ', Treffpunkt ' + esc(h.meet_point) : ''}${h.leader ? ' · Leitung: ' + esc(h.leader) : ''}</p>
    <table><tr><th>Wildart</th><th>Stück</th><th>Erleger</th><th>Bemerkung</th></tr>${rows || '<tr><td colspan="4">Keine Strecke</td></tr>'}<tr><th colspan="1">Gesamt</th><th>${h.bag.reduce((a, b) => a + b.count, 0)}</th><th colspan="2"></th></tr></table>
    <h2>Teilnehmer (${h.participants.length})</h2><p>${h.participants.map(p => esc(p.name) + ' (' + ROLE_NAMES[p.role] + ')').join(', ') || '–'}</p>
    <div class="sig"><div>Jagdleitung</div><div>Datum, Unterschrift</div></div>`);
}
function printHarvest(hv) {
  const rows = hv.entries.map(e => `<tr><td>${fmtDate(e.date)}</td><td>${esc(e.species)}</td><td>${e.count}</td><td>${esc(e.shooter)}</td><td>${e.weight_kg ?? ''}</td><td>${esc(e.notes)}</td></tr>`).join('');
  const bagRows = hv.hunt_bag.map(b => `<tr><td>${fmtDate(b.date)}</td><td>${esc(b.species)}</td><td>${b.count}</td><td>${esc(b.shooter)}</td><td></td><td>Drückjagd: ${esc(b.hunt_title)}</td></tr>`).join('');
  const quota = quotaRows(hv);
  openPrint(`Streckenbuch ${hv.season}`, `<h1>Streckenbuch Jagdjahr ${esc(hv.season)}</h1><div class="muted">${esc(state.revier.name)} · ${fmtDate(hv.from)} bis ${fmtDate(hv.to)}</div>
    <h2>Abschussplan</h2><table><tr><th>Wildart</th><th>Soll</th><th>Ist</th><th>Erfüllung</th></tr>${quota.map(q => `<tr><td>${esc(q.species)}</td><td>${q.target}</td><td>${q.actual}</td><td>${q.target ? Math.round(q.actual / q.target * 100) + ' %' : '–'}</td></tr>`).join('')}</table>
    <h2>Einzelstrecke</h2><table><tr><th>Datum</th><th>Wildart</th><th>Stück</th><th>Erleger</th><th>kg</th><th>Bemerkung</th></tr>${rows + bagRows || '<tr><td colspan="6">Keine Einträge</td></tr>'}</table>
    <div class="sig"><div>Jagdausübungsberechtigter</div><div>Datum, Unterschrift</div></div>`);
}
function printIncident(i) {
  openPrint(`${i.kind === 'wildschaden' ? 'Wildschaden' : 'Wildunfall'} ${fmtDate(i.happened_at)}`, `<h1>${i.kind === 'wildschaden' ? 'Wildschaden-Dokumentation' : 'Wildunfall-Protokoll'}</h1><div class="muted">${esc(state.revier.name)}</div>
    <table><tr><th>Datum / Zeit</th><td>${fmtDT(i.happened_at)}</td></tr><tr><th>Wildart</th><td>${esc(i.species || '–')}</td></tr><tr><th>Position</th><td>${i.lat.toFixed(5)}, ${i.lng.toFixed(5)}</td></tr>
    ${i.kind === 'wildschaden' ? `<tr><th>Kultur</th><td>${esc(i.crop || '–')}</td></tr><tr><th>Landwirt</th><td>${esc(i.farmer || '–')}</td></tr><tr><th>Fläche</th><td>${i.area_ha ? i.area_ha + ' ha' : '–'}</td></tr>` : `<tr><th>Straße</th><td>${esc(i.road || '–')}</td></tr><tr><th>Polizei-Aktenzeichen</th><td>${esc(i.police_ref || '–')}</td></tr>`}
    <tr><th>Status</th><td>${esc(i.status)}</td></tr><tr><th>Gemeldet von</th><td>${esc(i.user_name || '')}</td></tr><tr><th>Beschreibung</th><td>${esc(i.note || '–')}</td></tr></table>
    <div id="pics"></div><div class="sig"><div>Jagdausübungsberechtigter</div><div>${i.kind === 'wildschaden' ? 'Landwirt / Geschädigter' : 'Datum, Unterschrift'}</div></div>`);
  api(`/api/incidents/${i.id}/photos`).then(photos => {
    const pics = $('#pics'); if (!pics || !photos.length) return;
    pics.innerHTML = `<h2>Fotos (${photos.length})</h2><div class="print-pics">${photos.map(p => `<img src="${p.data}" alt="Foto">`).join('')}</div>`;
  }).catch(() => {});
}
function quotaRows(hv) {
  const counts = {};
  for (const e of hv.entries) counts[e.species] = (counts[e.species] || 0) + e.count;
  for (const b of hv.hunt_bag) counts[b.species] = (counts[b.species] || 0) + b.count;
  const rows = hv.quota.map(q => ({ ...q, actual: counts[q.species] || 0 }));
  for (const [sp, n] of Object.entries(counts)) if (!rows.find(r => r.species === sp)) rows.push({ species: sp, target: 0, actual: n });
  return rows;
}

// Unterseiten
function renderMehr() {
  const page = state.mehrPage;
  $('#mehr-hub').classList.toggle('hidden', !!page); $('#mehr-page').classList.toggle('hidden', !page);
  $$('#mehr-hub .hub button').forEach(b => b.onclick = () => { location.hash = 'mehr-' + b.dataset.page; });
  if (!page) return;
  const back = `<button class="back" id="mehr-back">← Revierbuch</button>`;
  const render = { strecke: pageStrecke, arbeiten: pageArbeiten, kirrungen: pageKirrungen, vorfaelle: pageVorfaelle, kontakte: pageKontakte, jagdzeiten: pageJagdzeiten, offline: pageOffline }[page];
  $('#mehr-page').innerHTML = back + (render ? render() : '<p class="muted">Unbekannte Seite.</p>');
  $('#mehr-back').onclick = () => { location.hash = 'mehr'; };
  const bind = { strecke: bindStrecke, arbeiten: bindArbeiten, kirrungen: bindKirrungen, vorfaelle: bindVorfaelle, kontakte: bindKontakte, jagdzeiten: bindJagdzeiten, offline: bindOffline }[page];
  bind?.($('#mehr-page'));
}
const act2 = async fn => { try { await fn(); } catch (e) { toast(e.message, 'error'); } };

// --- Streckenbuch & Abschussplan ---
function pageStrecke() {
  const hv = state.harvest;
  if (!hv) { loadHarvest(); return '<p class="muted">Lade …</p>'; }
  const rows = quotaRows(hv);
  const yearFrac = Math.min(1, Math.max(0, (Date.now() - new Date(hv.from).getTime()) / (new Date(hv.to).getTime() - new Date(hv.from).getTime())));
  const prev = `${Number(hv.season.slice(0, 4)) - 1}/${String(Number(hv.season.slice(0, 4))).slice(2)}`, next = `${Number(hv.season.slice(0, 4)) + 1}/${String(Number(hv.season.slice(0, 4)) + 2).slice(2)}`;
  return `<div class="row" style="justify-content:space-between"><h2 style="margin:0">Streckenbuch ${esc(hv.season)}</h2><div class="row"><button class="btn sm" data-season="${prev}">◀</button><button class="btn sm" data-season="${next}">▶</button><button class="btn sm" id="hv-print">Drucken / PDF</button></div></div>
    <div class="card"><h2>Abschussplan</h2>
      ${rows.length ? rows.map(q => { const pct = q.target ? Math.min(100, Math.round(q.actual / q.target * 100)) : 0; const cls = !q.target ? '' : q.actual >= q.target ? '' : pct / 100 < yearFrac - 0.25 ? 'danger' : pct / 100 < yearFrac ? 'warn' : ''; return `
        <div style="margin-bottom:.5rem"><div class="row" style="justify-content:space-between"><b>${esc(q.species)}</b><span>${q.actual} / ${q.target || '–'}${q.target ? ` (${pct} %)` : ''}</span></div><div class="bar ${cls}"><i style="width:${pct}%"></i></div></div>`; }).join('') : '<p class="muted small">Noch kein Abschussplan hinterlegt.</p>'}
      <p class="muted small">Jagdjahr ${fmtDate(hv.from)} bis ${fmtDate(hv.to)}, ${Math.round(yearFrac * 100)} % vergangen. Gelb: hinter der Zeit, rot: deutlich hinter der Zeit.</p>
      ${state.me.is_admin ? `<details><summary>Abschussplan bearbeiten (Admin)</summary><div id="quota-edit">${(state.seasons.map(x => x.species)).map(sp => { const q = hv.quota.find(x => x.species === sp); return `<div class="row" style="margin:.3rem 0"><span style="flex:1">${esc(sp)}</span><input type="number" min="0" data-quota="${esc(sp)}" value="${q?.target ?? ''}" style="width:90px;margin:0"></div>`; }).join('')}</div><button class="btn primary" id="quota-save">Abschussplan speichern</button></details>` : ''}
    </div>
    <div class="card"><h2>Strecke eintragen</h2>
      <div class="inline-form"><label>Wildart<select id="hv-species">${speciesOptions()}</select></label><label>Stück<input id="hv-count" type="number" min="1" value="1"></label>
        <label>Datum<input id="hv-date" type="date" value="${new Date().toISOString().slice(0, 10)}"></label><label>Erleger<input id="hv-shooter" value="${esc(state.me.name)}" maxlength="80"></label>
        <label>Gewicht kg<input id="hv-weight" type="number" step="0.1" min="0"></label><label>Bemerkung<input id="hv-notes" maxlength="500" placeholder="Ort, Klasse, Besonderheiten"></label>
        <label><input type="checkbox" id="hv-pos" style="width:auto;margin-right:.4rem">Standort speichern</label><button class="btn primary" id="hv-add">Eintragen</button></div>
    </div>
    <div class="card"><h2>Einträge (${hv.entries.length + hv.hunt_bag.length})</h2>
      <div class="table-wrap"><table class="table"><tr><th>Datum</th><th>Wildart</th><th>Stück</th><th>Erleger</th><th>kg</th><th></th></tr>
      ${hv.entries.map(e => `<tr><td>${fmtDate(e.date)}</td><td><b>${esc(e.species)}</b>${e.notes ? `<div class="muted small">${esc(e.notes)}</div>` : ''}</td><td>${e.count}</td><td>${esc(e.shooter)}</td><td>${e.weight_kg ?? ''}</td><td>${e.user_id === state.me.id || state.me.is_admin ? `<button class="btn sm" data-del-hv="${e.id}">✕</button>` : ''}</td></tr>`).join('')}
      ${hv.hunt_bag.map(b => `<tr><td>${fmtDate(b.date)}</td><td><b>${esc(b.species)}</b><div class="muted small">Jagd: ${esc(b.hunt_title)}</div></td><td>${b.count}</td><td>${esc(b.shooter)}</td><td></td><td></td></tr>`).join('')}
      </table></div></div>`;
}
function bindStrecke(root) {
  $$('[data-season]', root).forEach(b => b.onclick = () => loadHarvest(b.dataset.season));
  $('#hv-print', root)?.addEventListener('click', () => printHarvest(state.harvest));
  $('#quota-save', root)?.addEventListener('click', () => act2(async () => { await api('/quota', { method: 'PUT', body: { season: state.harvest.season, quota: $$('[data-quota]', root).map(i => ({ species: i.dataset.quota, target: i.value })) } }); toast('Abschussplan gespeichert'); }));
  $('#hv-add', root)?.addEventListener('click', () => act2(async () => {
    const species = $('#hv-species', root).value, date = $('#hv-date', root).value;
    if (!seasonConfirm(species, date)) return;
    const body = { species, count: $('#hv-count', root).value, date, shooter: $('#hv-shooter', root).value, weight_kg: $('#hv-weight', root).value || null, notes: $('#hv-notes', root).value };
    if ($('#hv-pos', root).checked && navigator.geolocation) await new Promise(r => navigator.geolocation.getCurrentPosition(p => { body.lat = p.coords.latitude; body.lng = p.coords.longitude; r(); }, () => r(), { timeout: 6000 }));
    await api('/harvest', { body }); toast('Strecke eingetragen – Waidmannsheil!');
  }));
  $$('[data-del-hv]', root).forEach(b => b.onclick = () => confirm('Eintrag löschen?') && act2(() => api('/harvest/' + b.dataset.delHv, { method: 'DELETE' })));
}

// --- Revierarbeiten ---
const TASK_KINDS = { kanzelpruefung: 'Kanzelprüfung', freischneiden: 'Freischneiden', reparatur: 'Reparatur', kirrung: 'Kirrung anlegen / pflegen', wegearbeit: 'Wegearbeit', sonstiges: 'Sonstiges' };
function pageArbeiten() {
  const open = state.tasks.filter(t => !t.done_at), done = state.tasks.filter(t => t.done_at);
  const today = new Date().toISOString().slice(0, 10);
  const stands = state.revier.features.filter(f => f.kind === 'kanzel');
  const unchecked = stands.filter(f => checkAge(f) === null || checkAge(f) > 365);
  const item = t => `<div class="task ${t.done_at ? 'done' : ''}" data-tid="${t.id}"><input type="checkbox" ${t.done_at ? 'checked' : ''}><span><b>${esc(t.title)}</b> <span class="role-tag">${TASK_KINDS[t.kind] || t.kind}</span><div class="muted small">${t.feature_name ? esc(t.feature_name) + ' · ' : ''}${t.assignee ? 'Zuständig: ' + esc(t.assignee) + ' · ' : ''}${t.due_date ? `<span class="${!t.done_at && t.due_date < today ? 'season-closed' : ''}">fällig ${fmtDate(t.due_date)}</span>` : ''}${t.done_at ? ` · erledigt ${fmtDate(t.done_at)}${t.done_by_name ? ' von ' + esc(t.done_by_name) : ''}` : ''}${t.notes ? '<br>' + esc(t.notes) : ''}</div></span><button class="btn sm" data-del-task2="${t.id}">✕</button></div>`;
  return `<h2>Revierarbeiten</h2>
    ${unchecked.length ? `<div class="hunt-tip">⚠️ Standsicherheitsprüfung fällig (älter als ein Jahr oder nie dokumentiert): ${unchecked.map(f => esc(f.name)).join(', ')}. Über das Kanzel-Popup „Prüfung erledigt“ dokumentieren.</div>` : '<div class="hunt-tip">✓ Alle Kanzeln innerhalb des letzten Jahres geprüft.</div>'}
    <div class="card"><h2>Offen (${open.length})</h2>${open.map(item).join('') || '<p class="muted small">Nichts offen.</p>'}
      <div class="inline-form"><label>Neue Arbeit<input id="tk-title" maxlength="160" placeholder="z. B. Leiter Kanzel Bachtal erneuern"></label><label>Art<select id="tk-kind">${Object.entries(TASK_KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label>Objekt<select id="tk-feature"><option value="">–</option>${state.revier.features.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select></label><label>Zuständig<input id="tk-who" maxlength="80" list="user-list"><datalist id="user-list">${state.users.map(u => `<option value="${esc(u.name)}">`).join('')}</datalist></label>
        <label>Fällig<input id="tk-due" type="date"></label><label>Notiz<input id="tk-notes" maxlength="1000"></label><button class="btn primary" id="tk-add">Anlegen</button></div></div>
    <div class="card"><h2>Erledigt (${done.length})</h2>${done.map(item).join('') || '<p class="muted small">Noch nichts erledigt.</p>'}</div>`;
}
function bindArbeiten(root) {
  $$('.task[data-tid] input[type=checkbox]', root).forEach(c => c.onchange = () => act2(() => api('/tasks/' + c.closest('.task').dataset.tid, { method: 'PUT', body: { done: c.checked } })));
  $$('[data-del-task2]', root).forEach(b => b.onclick = () => confirm('Arbeit löschen?') && act2(() => api('/tasks/' + b.dataset.delTask2, { method: 'DELETE' })));
  $('#tk-add', root)?.addEventListener('click', () => act2(async () => { await api('/tasks', { body: { title: $('#tk-title', root).value, kind: $('#tk-kind', root).value, feature_id: $('#tk-feature', root).value || null, assignee: $('#tk-who', root).value, due_date: $('#tk-due', root).value || null, notes: $('#tk-notes', root).value } }); toast('Angelegt'); }));
}

// --- Kirrungen & Kameras ---
function pageKirrungen() {
  const list = state.revier.features.filter(f => f.kind === 'kirrung' || f.kind === 'kamera');
  return `<h2>Kirrungen &amp; Wildkameras</h2>
    <div class="card">${list.length ? list.map(f => `<div class="person" style="border-left-color:${serviceOverdue(f) ? 'var(--warn)' : 'var(--ok)'}" data-fid="${f.id}">
      <span class="ico ico-${f.kind}" style="width:22px;height:22px;background:var(--oak)"></span>
      <div class="who"><b>${esc(f.name)}</b><span>${f.interval_days ? `alle ${f.interval_days} Tage · zuletzt ${f.last_service ? ageText(f.last_service) : 'nie'}${serviceOverdue(f) ? ' · <b class="season-closed">fällig</b>' : ''}` : 'kein Intervall gesetzt'}</span></div>
      <div class="row" style="flex:0 0 auto">${f.kind === 'kirrung' ? `<button class="btn sm" data-log2="beschickt">Beschickt</button>` : `<button class="btn sm" data-log2="karte">Karte</button><button class="btn sm" data-log2="batterie">Batterie</button>`}<button class="btn sm" data-log2="kontrolle">Kontrolle</button><button class="btn sm" data-hist="${f.id}">Verlauf</button></div></div>`).join('') : '<p class="muted small">Keine Kirrungen oder Kameras angelegt.</p>'}
    <p class="muted small">Intervall je Objekt im Karten-Popup unter „Bearbeiten“ setzen. Fällige Objekte sind auf der Karte gelb umrandet.</p></div><div id="log-hist"></div>`;
}
function bindKirrungen(root) {
  $$('[data-log2]', root).forEach(b => b.onclick = () => act2(async () => { await api(`/features/${b.closest('[data-fid]').dataset.fid}/logs`, { body: { kind: b.dataset.log2 } }); toast('Eingetragen'); }));
  $$('[data-hist]', root).forEach(b => b.onclick = () => act2(async () => {
    const logs = await api(`/features/${b.dataset.hist}/logs`); const f = state.revier.features.find(x => x.id === Number(b.dataset.hist));
    const names = { beschickt: 'Beschickt', karte: 'Karte getauscht', batterie: 'Batterie gewechselt', kontrolle: 'Kontrolle', notiz: 'Notiz' };
    $('#log-hist', root).innerHTML = `<div class="card"><h2>Verlauf ${esc(f?.name || '')}</h2>${logs.map(l => `<div class="history"><div class="item"><div><b>${names[l.kind] || l.kind}</b> ${l.note ? '– ' + esc(l.note) : ''}<div class="muted small">${fmtDT(l.created_at)} · ${esc(l.user_name || '')}</div></div></div></div>`).join('') || '<p class="muted small">Noch keine Einträge.</p>'}</div>`;
  }));
}

// --- Wildunfälle & Wildschäden ---
const INCIDENT_STATUS = { gemeldet: ['Gemeldet', 'warn'], besichtigt: ['Besichtigt', 'warn'], reguliert: ['Reguliert', 'ok'], erledigt: ['Erledigt', ''] };
function pageVorfaelle() {
  const row = i => `<div class="person" data-iid="${i.id}" style="border-left-color:${i.kind === 'wildschaden' ? '#b8862b' : '#2f4f4f'};cursor:pointer"><span class="incident ${i.kind}" style="width:28px;height:28px"><span class="ico ico-${i.kind === 'wildschaden' ? 'schaden' : 'unfall'}" style="width:16px;height:16px"></span></span>
    <div class="who"><b>${i.kind === 'wildschaden' ? 'Wildschaden' : 'Wildunfall'}${i.species ? ' · ' + esc(i.species) : ''} <span class="status-tag ${INCIDENT_STATUS[i.status]?.[1] || ''}">${INCIDENT_STATUS[i.status]?.[0] || i.status}</span></b><span>${fmtDT(i.happened_at)}${i.road ? ' · ' + esc(i.road) : ''}${i.crop ? ' · ' + esc(i.crop) : ''}${i.farmer ? ' · ' + esc(i.farmer) : ''}${i.area_ha ? ' · ' + i.area_ha + ' ha' : ''}${i.photo_count ? ' · ' + i.photo_count + ' Foto(s)' : ''}</span></div>
    <button class="btn sm" data-print-i="${i.id}">PDF</button></div>`;
  return `<h2>Wildunfälle &amp; Wildschäden</h2><div class="card"><p class="muted small">Neue Meldungen über die Kartenwerkzeuge „Unfall“ und „Schaden“. Antippen springt auf die Karte.</p>${state.incidents.map(row).join('') || '<p class="muted small">Keine Vorfälle.</p>'}</div>`;
}
function bindVorfaelle(root) {
  $$('[data-iid]', root).forEach(el => el.onclick = e => { if (e.target.closest('button')) return; const i = state.incidents.find(x => x.id === Number(el.dataset.iid)); location.hash = 'karte'; setTimeout(() => map.setView([i.lat, i.lng], 16), 100); });
  $$('[data-print-i]', root).forEach(b => b.onclick = () => printIncident(state.incidents.find(x => x.id === Number(b.dataset.printI))));
}
function renderIncidentMarkers() {
  if (!map) return;
  incidentLayer.clearLayers();
  for (const i of state.incidents) {
    const m = L.marker([i.lat, i.lng], { zIndexOffset: 600, draggable: canDrag(i.user_id === state.me.id || !!state.me.is_admin),
      icon: L.divIcon({ className: '', html: `<div class="incident ${i.kind} ${i.status}"><span class="ico ico-${i.kind === 'wildschaden' ? 'schaden' : 'unfall'}"></span></div>`, iconSize: [32, 32], iconAnchor: [16, 16], popupAnchor: [0, -16] }) });
    m.bindTooltip(`${i.kind === 'wildschaden' ? 'Wildschaden' : 'Wildunfall'}${i.species ? ' ' + i.species : ''} · ${ageText(i.happened_at)}`);
    m.on('dragend', async () => { const p = m.getLatLng(); await api('/incidents/' + i.id, { method: 'PUT', body: { lat: p.lat, lng: p.lng } }); });
    m.on('click', () => { if (markerClickDuringPlacement(m.getLatLng())) return; openIncidentPopup(m, i); });
    incidentLayer.addLayer(m);
  }
}
async function openIncidentPopup(marker, i) {
  const mine = i.user_id === state.me.id || state.me.is_admin;
  openMarkerPopup(marker, `<h3>${i.kind === 'wildschaden' ? 'Wildschaden' : 'Wildunfall'} <span class="status-tag ${INCIDENT_STATUS[i.status]?.[1] || ''}">${INCIDENT_STATUS[i.status]?.[0] || i.status}</span></h3>
    <div>${fmtDT(i.happened_at)}${i.species ? ' · ' + esc(i.species) : ''} · ${esc(i.user_name || '')}</div>
    <div class="small">${i.kind === 'wildschaden' ? `${i.crop ? 'Kultur: ' + esc(i.crop) : ''}${i.farmer ? ' · ' + esc(i.farmer) : ''}${i.area_ha ? ' · ' + i.area_ha + ' ha' : ''}` : `${i.road ? esc(i.road) : ''}${i.police_ref ? ' · Az. ' + esc(i.police_ref) : ''}`}</div>
    ${i.note ? `<div class="muted small">„${esc(i.note)}“</div>` : ''}<div class="photo-grid" id="inc-photos-${i.id}"></div>
    <div class="row"><select data-status style="width:auto;margin:0;padding:.3rem">${Object.entries(INCIDENT_STATUS).map(([k, [v]]) => `<option value="${k}" ${k === i.status ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <button class="btn sm" data-act="edit">Bearbeiten</button><button class="btn sm" data-act="print">PDF</button>${mine ? `<button class="btn sm danger" data-act="del">Löschen</button>` : ''}</div>`, { maxWidth: 320 });
  const pop = marker.getPopup().getElement();
  $('[data-status]', pop).onchange = e => act2(async () => { await api('/incidents/' + i.id, { method: 'PUT', body: { status: e.target.value } }); map.closePopup(); });
  $('[data-act="edit"]', pop)?.addEventListener('click', () => { map.closePopup(); incidentDialog(i); });
  $('[data-act="print"]', pop)?.addEventListener('click', () => printIncident(i));
  $('[data-act="del"]', pop)?.addEventListener('click', async () => { if (confirm('Meldung löschen?')) { map.closePopup(); await api('/incidents/' + i.id, { method: 'DELETE' }); } });
  if (i.photo_count) { try { const photos = await api(`/incidents/${i.id}/photos`); const grid = $(`#inc-photos-${i.id}`); if (grid) { grid.innerHTML = photos.map(p => `<span class="ph"><img src="${p.data}" alt="Foto"></span>`).join(''); $$('img', grid).forEach(img => img.onclick = () => openDialog(`<img class="photo-full" src="${img.src}"><div class="row" style="margin-top:.6rem"><button class="btn" data-close>Schließen</button></div>`)); } } catch {} }
}
function incidentDialog(i) {
  const isNew = !i.id, isDamage = i.kind === 'wildschaden';
  const when = i.happened_at ? new Date(i.happened_at) : new Date();
  let photos = [];
  openDialog(`<h2>${isDamage ? 'Wildschaden dokumentieren' : 'Wildunfall melden'}</h2>
    <label>Wildart<input id="in-species" list="species-list2" maxlength="80" value="${esc(i.species || '')}"><datalist id="species-list2">${SPECIES.map(x => `<option value="${x}">`).join('')}</datalist></label>
    <label>Zeitpunkt<input type="datetime-local" id="in-time" value="${toLocalInput(when)}"></label>
    ${isDamage ? `<label>Kultur / Fläche<input id="in-crop" maxlength="80" value="${esc(i.crop || '')}" placeholder="z. B. Mais, Grünland, Winterweizen"></label>
      <label>Landwirt / Geschädigter<input id="in-farmer" maxlength="120" value="${esc(i.farmer || '')}"></label>
      <label>Geschädigte Fläche in ha (geschätzt)<input id="in-area" type="number" step="0.01" min="0" value="${i.area_ha ?? ''}"></label>`
    : `<label>Straße / Stelle<input id="in-road" maxlength="120" value="${esc(i.road || '')}" placeholder="z. B. K12 Höhe Abzweig Forsthaus"></label>
      <label>Polizei-Aktenzeichen<input id="in-ref" maxlength="80" value="${esc(i.police_ref || '')}"></label>`}
    <label>Beschreibung<textarea id="in-note" maxlength="1000">${esc(i.note || '')}</textarea></label>
    <label>Fotos<input type="file" id="in-photos" accept="image/*" capture="environment" multiple></label><div class="photo-grid" id="in-preview"></div>
    <div class="row"><button class="btn primary" id="in-save">${isNew ? 'Melden' : 'Speichern'}</button><button class="btn" data-close>Abbrechen</button></div>
    ${isNew ? '<p class="muted small">Alle Nutzer erhalten eine Push-Nachricht. Aus der Meldung lässt sich ein PDF für Polizei, Versicherung oder Landwirt erzeugen.</p>' : ''}`, d => {
    $('#in-photos', d).onchange = async () => {
      for (const f of [...$('#in-photos', d).files].slice(0, 5 - photos.length)) { try { photos.push(await compressImage(f)); } catch (e) { toast(e.message, 'error'); } }
      $('#in-preview', d).innerHTML = photos.map((p, k) => `<span class="ph"><img src="${p}" alt=""><button data-i="${k}">✕</button></span>`).join('');
      $$('#in-preview button', d).forEach(b => b.onclick = () => { photos.splice(Number(b.dataset.i), 1); $('#in-photos', d).onchange(); });
    };
    $('#in-save', d).onclick = () => act2(async () => {
      const body = { kind: i.kind, species: $('#in-species', d).value, happened_at: new Date($('#in-time', d).value).toISOString(), note: $('#in-note', d).value, lat: i.lat, lng: i.lng, photos,
        ...(isDamage ? { crop: $('#in-crop', d).value, farmer: $('#in-farmer', d).value, area_ha: $('#in-area', d).value || null } : { road: $('#in-road', d).value, police_ref: $('#in-ref', d).value }) };
      $('#in-save', d).disabled = true;
      if (isNew) await api('/incidents', { body }); else await api('/incidents/' + i.id, { method: 'PUT', body });
      closeDialog(); toast(isNew ? 'Gemeldet' : 'Gespeichert');
    });
  });
}

// --- Kontakte ---
const CONTACT_ROLES = { nachsuche: 'Nachsuchengespann', tierarzt: 'Tierarzt', polizei: 'Polizei', forst: 'Forst', landwirt: 'Landwirt', wildhandel: 'Wildhandel', jagdbehoerde: 'Jagdbehörde', sonstiges: 'Sonstiges' };
function pageKontakte() {
  return `<h2>Kontakte</h2><div class="card">${state.contacts.length ? state.contacts.map(c => `<div class="contact" data-cid="${c.id}"><div class="who"><b>${esc(c.name)}</b> <span class="role-tag">${CONTACT_ROLES[c.role] || c.role}</span>${c.note ? `<div class="muted small">${esc(c.note)}</div>` : ''}</div>
      ${c.phone ? `<a class="btn sm primary" href="tel:${esc(c.phone.replace(/\s+/g, ''))}">📞 ${esc(c.phone)}</a>` : ''}<button class="btn sm" data-edit-c="${c.id}">✎</button></div>`).join('') : '<p class="muted small">Noch keine Kontakte.</p>'}
    <p class="muted small">Nachsuchengespanne erscheinen direkt im Anschuss-Popup zum Anrufen.</p>
    <div class="inline-form"><label>Name<input id="c-name" maxlength="80"></label><label>Rolle<select id="c-role">${Object.entries(CONTACT_ROLES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label><label>Telefon<input id="c-phone" maxlength="40" type="tel"></label><label>Notiz<input id="c-note" maxlength="300"></label><button class="btn primary" id="c-add">Hinzufügen</button></div></div>`;
}
function bindKontakte(root) {
  $('#c-add', root)?.addEventListener('click', () => act2(async () => { await api('/contacts', { body: { name: $('#c-name', root).value, role: $('#c-role', root).value, phone: $('#c-phone', root).value, note: $('#c-note', root).value } }); toast('Kontakt gespeichert'); }));
  $$('[data-edit-c]', root).forEach(b => b.onclick = () => {
    const c = state.contacts.find(x => x.id === Number(b.dataset.editC));
    openDialog(`<h2>Kontakt bearbeiten</h2><label>Name<input id="ce-name" value="${esc(c.name)}"></label><label>Rolle<select id="ce-role">${Object.entries(CONTACT_ROLES).map(([k, v]) => `<option value="${k}" ${k === c.role ? 'selected' : ''}>${v}</option>`).join('')}</select></label><label>Telefon<input id="ce-phone" value="${esc(c.phone)}"></label><label>Notiz<input id="ce-note" value="${esc(c.note)}"></label>
      <div class="row"><button class="btn primary" id="ce-save">Speichern</button><button class="btn danger" id="ce-del">Löschen</button><button class="btn" data-close>Abbrechen</button></div>`, d => {
      $('#ce-save', d).onclick = () => act2(async () => { await api('/contacts/' + c.id, { method: 'PUT', body: { name: $('#ce-name', d).value, role: $('#ce-role', d).value, phone: $('#ce-phone', d).value, note: $('#ce-note', d).value } }); closeDialog(); });
      $('#ce-del', d).onclick = () => act2(async () => { if (confirm('Kontakt löschen?')) { await api('/contacts/' + c.id, { method: 'DELETE' }); closeDialog(); } });
    });
  });
}

// --- Jagdzeiten ---
function pageJagdzeiten() {
  const today = new Date();
  return `<h2>Jagdzeiten</h2><div class="card"><p class="muted small">${esc(state.seasonsNote)}</p>
    <div class="table-wrap"><table class="table"><tr><th>Wildart</th><th>Jagdzeit</th><th>Heute</th>${state.me.is_admin ? '<th></th>' : ''}</tr>
    ${state.seasons.map((x, k) => `<tr data-k="${k}"><td>${state.me.is_admin ? `<input data-sp value="${esc(x.species)}">` : `<b>${esc(x.species)}</b>`}</td><td>${state.me.is_admin ? `<input data-from value="${esc(x.from)}" placeholder="MM-TT" style="width:70px"> – <input data-to value="${esc(x.to)}" placeholder="MM-TT" style="width:70px">` : (x.from ? `${fmtMd(x.from)} – ${fmtMd(x.to)}` : 'ganzjährig')}</td><td class="${inSeason(x, today) ? 'season-ok' : 'season-closed'}">${inSeason(x, today) ? 'offen' : 'Schonzeit'}</td>${state.me.is_admin ? `<td><button class="btn sm" data-del-season="${k}">✕</button></td>` : ''}</tr>`).join('')}
    </table></div>
    ${state.me.is_admin ? `<div class="row" style="margin-top:.6rem"><button class="btn sm" id="season-add">+ Wildart</button><button class="btn primary" id="season-save">Jagdzeiten speichern</button></div><label>Hinweistext<input id="season-note" value="${esc(state.seasonsNote)}" maxlength="300"></label><p class="muted small">Format Monat-Tag, z. B. 05-01 für 1. Mai. Beide Felder leer = ganzjährig.</p>` : '<p class="muted small">Nur der Admin kann die Zeiten anpassen.</p>'}</div>`;
}
function bindJagdzeiten(root) {
  const collect = () => $$('tr[data-k]', root).map(tr => ({ species: $('[data-sp]', tr).value, from: $('[data-from]', tr).value.trim(), to: $('[data-to]', tr).value.trim() }));
  $('#season-save', root)?.addEventListener('click', () => act2(async () => { await api('/seasons', { method: 'PUT', body: { seasons: collect(), note: $('#season-note', root).value } }); await loadSeasons(); renderMehr(); toast('Jagdzeiten gespeichert'); }));
  $('#season-add', root)?.addEventListener('click', () => { state.seasons = collect().concat([{ species: 'Neue Wildart', from: '', to: '' }]); renderMehr(); });
  $$('[data-del-season]', root).forEach(b => b.onclick = () => { state.seasons = collect(); state.seasons.splice(Number(b.dataset.delSeason), 1); renderMehr(); });
}

// --- Offline-Karte ---
function pageOffline() {
  return `<h2>Offline-Karte</h2><div class="card"><p>Speichert die Kartenkacheln des Reviers (aktuelle Kartenart, Zoomstufen 12 bis 16) auf diesem Gerät, damit die Karte auch ohne Empfang angezeigt wird. Eigene Marker, Fährten und Grenzen werden ohnehin beim letzten Laden gemerkt.</p>
    <p class="muted small" id="offline-status">Prüfe Speicher …</p>
    <div class="row"><button class="btn primary" id="offline-save">Revier offline speichern</button><button class="btn danger" id="offline-clear">Gespeicherte Kacheln löschen</button></div>
    <p class="muted small">Grundlage ist die Reviergrenze (sonst der aktuelle Kartenausschnitt). Maximal 1500 Kacheln, damit die Kartenserver nicht übermäßig belastet werden. Dauert je nach Verbindung ein bis drei Minuten.</p></div>`;
}
async function tileCacheCount() { try { const c = await caches.open('revier-tiles'); return (await c.keys()).length; } catch { return 0; } }
function bindOffline(root) {
  const status = $('#offline-status', root);
  tileCacheCount().then(n => { status.textContent = n ? `${n} Kacheln gespeichert.` : 'Noch keine Kacheln gespeichert.'; });
  $('#offline-clear', root).onclick = async () => { await caches.delete('revier-tiles'); status.textContent = 'Gelöscht.'; };
  $('#offline-save', root).onclick = async () => {
    if (!('caches' in window)) return toast('Offline-Speicher wird von diesem Browser nicht unterstützt', 'error');
    const b = boundaryLayer?.getBounds().isValid() ? boundaryLayer.getBounds().pad(0.1) : map.getBounds();
    const key = localStorage.getItem('layer') || 'topo';
    const tpl = { topo: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', osm: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', sat: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}' }[key];
    const subs = ['a', 'b', 'c'];
    const urls = [];
    for (let z = 12; z <= 16; z++) {
      const t = ll => ({ x: Math.floor((ll.lng + 180) / 360 * 2 ** z), y: Math.floor((1 - Math.log(Math.tan(ll.lat * Math.PI / 180) + 1 / Math.cos(ll.lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z) });
      const a = t(b.getNorthWest()), c = t(b.getSouthEast());
      for (let x = a.x; x <= c.x; x++) for (let y = a.y; y <= c.y; y++) urls.push(tpl.replace('{s}', subs[(x + y) % 3]).replace('{z}', z).replace('{x}', x).replace('{y}', y));
    }
    if (urls.length > 1500) { toast(`Zu groß (${urls.length} Kacheln). Bitte Grenze enger ziehen oder weiter hineinzoomen.`, 'error'); return; }
    const cache = await caches.open('revier-tiles'); let done = 0, failed = 0;
    status.textContent = `Lade 0 / ${urls.length} …`;
    const worker = async () => { while (urls.length) { const u = urls.shift(); try { if (!(await cache.match(u))) { const r = await fetch(u, { mode: 'no-cors' }); await cache.put(u, r); } done++; } catch { failed++; } if ((done + failed) % 20 === 0) status.textContent = `Lade ${done + failed} / ${done + failed + urls.length} …`; } };
    await Promise.all([worker(), worker(), worker(), worker()]);
    status.textContent = `Fertig: ${done} Kacheln gespeichert${failed ? `, ${failed} fehlgeschlagen` : ''}.`; toast('Offline-Karte gespeichert');
  };
}

// ---------- Benachrichtigungen ----------
async function loadNotifications() {
  state.notifications = await api('/notifications');
  const unread = state.notifications.filter(n => !n.read).length;
  $('#notif-badge').textContent = unread; $('#notif-badge').classList.toggle('hidden', !unread);
  renderNotifications();
}
function renderNotifications() {
  $('#notif-list').innerHTML = state.notifications.length ? state.notifications.map(n => `<div class="notif ${n.read ? '' : 'unread'}" data-url="${esc(n.url)}"><b>${esc(n.title)}</b>${esc(n.body)}<div class="when">${fmtDT(sqlToIso(n.created_at))}</div></div>`).join('') : '<p class="muted">Keine Benachrichtigungen.</p>';
  $$('.notif').forEach(el => el.onclick = () => { $('#notif-drawer').classList.add('hidden'); location.hash = el.dataset.url.replace(/^\/?#?/, ''); });
}
$('#btn-notifications').onclick = async () => {
  $('#notif-drawer').classList.toggle('hidden');
  if (state.notifications.some(n => !n.read)) { await api('/notifications/read', { method: 'POST' }); loadNotifications(); }
};
$('#btn-notif-close').onclick = () => $('#notif-drawer').classList.add('hidden');
$('#btn-me').onclick = () => { location.hash = 'mehr'; };

// ---------- Push ----------
let swReg;
async function registerSw() {
  if (!('serviceWorker' in navigator)) return;
  try { swReg = await navigator.serviceWorker.register('/sw.js'); } catch (e) { console.warn('SW', e); }
  updatePushStatus();
  // Auto-Abo erneuern, wenn schon erlaubt
  if (Notification.permission === 'granted') subscribePush(true);
}
async function subscribePush(silent = false) {
  try {
    if (!swReg) swReg = await navigator.serviceWorker.ready;
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { if (!silent) toast('Benachrichtigungen wurden nicht erlaubt', 'error'); return updatePushStatus(); }
    const { publicKey } = await api('/push/key');
    const sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(publicKey) });
    await api('/push/subscribe', { body: sub.toJSON() });
    if (!silent) toast('Push-Benachrichtigungen aktiviert');
  } catch (e) { if (!silent) toast('Push nicht möglich: ' + e.message, 'error'); }
  updatePushStatus();
}
function urlB64ToUint8Array(s) { const p = '='.repeat((4 - s.length % 4) % 4); const b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...b].map(c => c.charCodeAt(0))); }
async function updatePushStatus() {
  const el = $('#push-status'); if (!el) return;
  if (!('PushManager' in window)) { el.textContent = 'Push wird von diesem Browser nicht unterstützt (iOS: App zum Home-Bildschirm hinzufügen).'; return; }
  const sub = swReg && await swReg.pushManager.getSubscription();
  el.textContent = Notification.permission === 'denied' ? 'Benachrichtigungen sind im Browser blockiert.' : sub ? 'Push-Benachrichtigungen sind auf diesem Gerät aktiv.' : 'Push ist auf diesem Gerät noch nicht aktiviert.';
  $('#btn-push-enable').textContent = sub ? 'Erneut verbinden' : 'Push aktivieren';
}
$('#btn-push-enable').onclick = () => subscribePush();
$('#btn-push-test').onclick = async () => { try { await api('/push/test', { method: 'POST' }); toast('Testnachricht gesendet'); } catch (e) { toast(e.message, 'error'); } };

// ---------- Einstellungen ----------
async function renderSettings() {
  $('#set-revier-name').value = state.revier.name;
  $('#me-admin').classList.toggle('hidden', !state.me.is_admin);
  $('#admin-card').classList.toggle('hidden', !state.me.is_admin);
  if (state.me.is_admin) renderAdmin();
  $('#features-list').innerHTML = state.revier.features.length ? state.revier.features.map(f => `<div class="item"><span class="ico ico-${f.kind === 'sonstiges' ? 'locate' : f.kind}"></span><span><b>${esc(f.name)}</b> <span class="muted small">${featureKinds[f.kind]}</span></span><button class="btn sm" data-edit="${f.id}">Bearbeiten</button></div>`).join('') : '<p class="muted small">Noch nichts angelegt. Nutze die Werkzeuge auf der Karte.</p>';
  $$('#features-list [data-edit]').forEach(b => b.onclick = () => editFeature(Number(b.dataset.edit)));
  updatePushStatus();
}
$('#btn-pw-change').onclick = async () => {
  try {
    await api('/auth/password', { body: { old_password: $('#pw-old').value, new_password: $('#pw-new').value } });
    toast('Passwort geändert – bitte neu anmelden'); setToken(null); setTimeout(() => location.reload(), 1200);
  } catch (e) { toast(e.message, 'error'); }
};
async function renderAdmin() {
  try {
    const inv = await api('/admin/invite');
    $('#admin-invite').value = inv.code || ''; $('#admin-invite').disabled = inv.fromEnv; $('#btn-invite-save').disabled = inv.fromEnv;
  } catch {}
  $('#admin-users').innerHTML = state.users.map(u => `<div class="item" style="display:flex;align-items:center;gap:.6rem;padding:.4rem 0;border-bottom:1px dashed var(--parchment-dark)">${avatar(u)}
    <span style="flex:1"><b>${esc(u.name)}</b>${u.is_admin ? ' <span class="status-tag ok">Admin</span>' : ''}${u.id === state.me.id ? ' <span class="muted small">(ich)</span>' : ''}</span>
    ${u.id !== state.me.id ? `<button class="btn sm" data-reset="${u.id}" title="Neues Startpasswort erzeugen">Passwort</button><button class="btn sm" data-admin="${u.id}" data-val="${u.is_admin ? 0 : 1}">${u.is_admin ? 'Admin entziehen' : 'Zum Admin'}</button><button class="btn sm danger" data-deluser="${u.id}">✕</button>` : ''}</div>`).join('');
  $$('#admin-users [data-reset]').forEach(b => b.onclick = async () => {
    const u = state.users.find(x => x.id === Number(b.dataset.reset));
    if (!confirm(`Neues Passwort für ${u.name} erzeugen? Das alte gilt dann nicht mehr.`)) return;
    try { const r = await api(`/admin/users/${u.id}/reset-password`, { method: 'POST' });
      openDialog(`<h2>Startpasswort für ${esc(r.name)}</h2><p>Bitte persönlich weitergeben. ${esc(r.name)} sollte es unter „Mehr → Konto“ ändern.</p><p style="font-size:1.6rem;font-family:var(--font-head);text-align:center;letter-spacing:.1em"><b>${esc(r.password)}</b></p><div class="row"><button class="btn primary" data-close>Schließen</button></div>`);
    } catch (e) { toast(e.message, 'error'); }
  });
  $$('#admin-users [data-admin]').forEach(b => b.onclick = async () => { try { await api(`/admin/users/${b.dataset.admin}/admin`, { method: 'PUT', body: { is_admin: b.dataset.val === '1' } }); } catch (e) { toast(e.message, 'error'); } });
  $$('#admin-users [data-deluser]').forEach(b => b.onclick = async () => {
    const u = state.users.find(x => x.id === Number(b.dataset.deluser));
    if (confirm(`${u.name} wirklich entfernen? Check-ins und Ankündigungen dieses Nutzers werden gelöscht.`)) { try { await api(`/admin/users/${u.id}`, { method: 'DELETE' }); toast(`${u.name} entfernt`); } catch (e) { toast(e.message, 'error'); } }
  });
}
$('#btn-invite-save').onclick = async () => { try { await api('/admin/invite', { method: 'PUT', body: { code: $('#admin-invite').value } }); toast('Einladungscode gespeichert'); } catch (e) { toast(e.message, 'error'); } };
$('#btn-invite-share').onclick = async () => {
  const text = `Einladung zur RevierApp „${state.revier.name}“\n\n1. Link öffnen: ${location.origin}\n2. Auf „Neu registrieren“ tippen, Name und eigenes Passwort wählen\n3. Einladungscode: ${$('#admin-invite').value}\n\nTipp fürs Handy: Seite über „Teilen → Zum Home-Bildschirm“ installieren, dann unter „Mehr“ Push-Benachrichtigungen aktivieren.`;
  try { if (navigator.share) await navigator.share({ title: 'Einladung RevierApp', text }); else { await navigator.clipboard.writeText(text); toast('Einladungstext in die Zwischenablage kopiert'); } } catch {}
};
$('#btn-save-revier').onclick = async () => { await api('/revier/settings', { method: 'PUT', body: { name: $('#set-revier-name').value } }); toast('Gespeichert'); };
$('#btn-save-center').onclick = async () => { const c = map.getCenter(); await api('/revier/settings', { method: 'PUT', body: { center: { lat: c.lat, lng: c.lng, zoom: map.getZoom() } } }); toast('Mittelpunkt gespeichert'); loadWeather(); };

renderCheckinForm();
boot();
