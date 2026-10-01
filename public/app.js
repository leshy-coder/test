/* RevierApp – Frontend (ES-Modul, ohne Framework) */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  token: localStorage.getItem('token'),
  me: null, users: [], online: [],
  revier: { name: 'Mein Revier', center: { lat: 51.1657, lng: 10.4515, zoom: 6 }, boundaries: [], features: [] },
  checkins: { active: [], history: [] },
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
  return data;
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
  try { authStatus = await (await fetch('/api/auth/status')).json(); } catch {}
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
  await Promise.all([loadRevier(), loadUsers(), loadCheckins(), loadPlans(), loadHunts(), loadNotifications()]);
  loadWeather();
  connectWs();
  registerSw();
  routeFromHash();
  setInterval(() => { if (state.view === 'karte') renderActive(); }, 60000);
  setInterval(loadWeather, 15 * 60 * 1000);
}

// ---------- WebSocket ----------
let ws, wsTimer;
function connectWs() {
  if (ws) ws.close();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${state.token}`);
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'presence': state.online = msg.data.online; renderOnline(); break;
      case 'revier': loadRevier(); break;
      case 'users': loadUsers().then(() => { if (state.view === 'mehr') renderSettings(); }); break;
      case 'checkins': loadCheckins(); loadNotifications(); break;
      case 'plans': loadPlans(); loadNotifications(); break;
      case 'hunts': loadHunts(); if (state.hunt && (!msg.data.hunt_id || msg.data.hunt_id === state.hunt.id)) loadHunt(state.hunt.id); loadNotifications(); break;
    }
  };
  ws.onclose = () => { clearTimeout(wsTimer); wsTimer = setTimeout(connectWs, 3000); setStatus('Verbindung getrennt – verbinde neu …'); };
  ws.onopen = () => setStatus('Verbunden');
}
function setStatus(t) { $('#topbar-status').textContent = t; }
function renderOnline() {
  $('#online-users').innerHTML = state.online.filter(u => u.id !== state.me.id).map(u => avatar(u)).join('');
  const n = state.online.length;
  setStatus(`${n} online · ${state.checkins.active.length} im Revier`);
}

// ---------- Navigation ----------
$$('.nav button').forEach(b => b.onclick = () => { location.hash = b.dataset.view; });
window.addEventListener('hashchange', routeFromHash);
function routeFromHash() {
  const h = location.hash.replace('#', '') || 'karte';
  let view = h;
  if (h.startsWith('plan-')) { view = 'ansitz'; setTimeout(() => $(`#plan-${h.slice(5)}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 200); }
  if (h.startsWith('jagd-')) { view = 'jagd'; loadHunt(Number(h.slice(5))); }
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
  if (v === 'mehr') renderSettings();
}

// ---------- Users ----------
async function loadUsers() { state.users = await api('/users'); }

// ---------- Revier / Map ----------
let map, layers = {}, boundaryLayer, featureLayer, checkinLayer, drawControl, activeTool = null, meMarker;
const featureKinds = { kanzel: 'Kanzel', kamera: 'Wildkamera', kirrung: 'Kirrung', sonstiges: 'Sonstiges' };

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
  featureLayer = new L.FeatureGroup().addTo(map);
  checkinLayer = new L.FeatureGroup().addTo(map);

  map.on('click', onMapClick);
  map.on(L.Draw.Event.CREATED, async e => {
    const geo = e.layer.toGeoJSON();
    await api('/boundaries', { body: { geojson: geo, name: 'Reviergrenze' } });
    setTool(null); toast('Reviergrenze gespeichert');
  });
  map.on(L.Draw.Event.EDITED, async e => {
    for (const layer of Object.values(e.layers._layers)) {
      if (layer.boundaryId) await api('/boundaries/' + layer.boundaryId, { method: 'PUT', body: { geojson: layer.toGeoJSON() } });
    }
    toast('Grenze aktualisiert');
  });
  map.on(L.Draw.Event.DELETED, async e => {
    for (const layer of Object.values(e.layers._layers)) if (layer.boundaryId) await api('/boundaries/' + layer.boundaryId, { method: 'DELETE' });
  });

  $$('.map-toolbar .tool').forEach(b => b.onclick = () => onTool(b.dataset.tool));
  $('#wind-badge').onclick = () => { location.hash = 'wetter'; };
}

function onTool(tool) {
  if (tool === 'layer') return showLayerMenu();
  if (tool === 'locate') return locateMe();
  setTool(activeTool === tool ? null : tool);
}
function setTool(tool) {
  activeTool = tool;
  $$('.map-toolbar .tool').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  const hint = $('#map-hint');
  if (drawControl) { map.removeControl(drawControl); drawControl = null; }
  if (!tool) { hint.classList.add('hidden'); $('#map').style.cursor = ''; return; }
  hint.classList.remove('hidden');
  if (tool === 'grenze') {
    hint.textContent = 'Grenze: Polygon zeichnen oder bestehende bearbeiten (Werkzeuge links)';
    drawControl = new L.Control.Draw({
      position: 'topleft',
      draw: { polygon: { allowIntersection: false, shapeOptions: { color: '#9b3b2d', weight: 3, fillOpacity: .06 } }, polyline: false, rectangle: false, circle: false, marker: false, circlemarker: false },
      edit: { featureGroup: boundaryLayer },
    });
    map.addControl(drawControl);
  } else {
    hint.textContent = `Tippe auf die Karte, um eine ${featureKinds[tool]} zu setzen`;
    $('#map').style.cursor = 'crosshair';
  }
}
async function onMapClick(e) {
  if (!activeTool || activeTool === 'grenze') return;
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
  renderMapFeatures();
  renderStandSelect();
  if (state.view === 'mehr') renderSettings();
}

function markerIcon(kind, cls = '') {
  return L.divIcon({ className: '', html: `<div class="marker ${kind} ${cls}"><span class="ico ico-${kind === 'sonstiges' ? 'locate' : kind}"></span></div>`, iconSize: [36, 36], iconAnchor: [18, 36], popupAnchor: [0, -34] });
}
let firstFit = true;
function renderMapFeatures() {
  if (!map) return;
  boundaryLayer.clearLayers(); featureLayer.clearLayers();
  for (const b of state.revier.boundaries) {
    const l = L.geoJSON(b.geojson, { style: { color: '#9b3b2d', weight: 3, dashArray: '8 6', fillColor: '#6b8e23', fillOpacity: .06 } });
    l.eachLayer(x => { x.boundaryId = b.id; x.bindTooltip(b.name, { sticky: true }); boundaryLayer.addLayer(x); });
  }
  const occupied = new Map(state.checkins.active.filter(c => c.feature_id).map(c => [c.feature_id, c]));
  const planned = new Set(state.plans.filter(p => p.status === 'offen' && p.feature_id).map(p => p.feature_id));
  for (const f of state.revier.features) {
    const occ = occupied.get(f.id);
    const m = L.marker([f.lat, f.lng], { icon: markerIcon(f.kind, (occ ? 'occupied ' : '') + (planned.has(f.id) ? 'planned' : '')), draggable: true });
    m.bindTooltip(f.name, { permanent: true, direction: 'bottom', offset: [0, 2], className: 'marker-label' });
    m.on('dragend', async () => { const p = m.getLatLng(); await api('/features/' + f.id, { method: 'PUT', body: { lat: p.lat, lng: p.lng } }); });
    m.on('click', () => openFeaturePopup(m, f, occ));
    featureLayer.addLayer(m);
  }
  if (firstFit) {
    firstFit = false;
    const all = new L.FeatureGroup([boundaryLayer, featureLayer]);
    const bounds = all.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.15));
    else map.setView([state.revier.center.lat, state.revier.center.lng], state.revier.center.zoom || 6);
  }
  renderCheckinMarkers();
}
function openFeaturePopup(marker, f, occ) {
  const planned = state.plans.filter(p => p.status === 'offen' && p.feature_id === f.id);
  const html = `<h3>${esc(f.name)}</h3><div class="muted small">${featureKinds[f.kind]}${f.notes ? ' · ' + esc(f.notes) : ''}</div>
    ${occ ? `<p><b style="color:var(--danger)">Besetzt:</b> ${esc(occ.user_name)} (${ago(occ.started_at)})</p>` : ''}
    ${planned.map(p => `<p class="small">Angekündigt: ${esc(p.user_name)} ${fmtDT(p.planned_at)}</p>`).join('')}
    <div class="row">
      ${f.kind === 'kanzel' && !occ ? `<button class="btn sm primary" data-act="checkin">Hier einchecken</button>` : ''}
      ${f.kind === 'kanzel' ? `<button class="btn sm" data-act="plan">Ankündigen</button>` : ''}
      <button class="btn sm" data-act="edit">Bearbeiten</button>
    </div>`;
  marker.bindPopup(html).openPopup();
  const pop = marker.getPopup().getElement();
  $('[data-act="checkin"]', pop)?.addEventListener('click', () => { map.closePopup(); doCheckin('kanzel', f.id, ''); });
  $('[data-act="plan"]', pop)?.addEventListener('click', () => { map.closePopup(); location.hash = 'ansitz'; state.checkinMode = 'kanzel'; renderCheckinForm(); $('#checkin-stand').value = f.id; $('#plan-form').classList.remove('hidden'); });
  $('[data-act="edit"]', pop)?.addEventListener('click', () => { map.closePopup(); editFeature(f.id); });
}
function editFeature(id) {
  const f = state.revier.features.find(x => x.id === id); if (!f) return;
  openDialog(`<h2>${featureKinds[f.kind]} bearbeiten</h2>
    <label>Name<input id="f-name" value="${esc(f.name)}" maxlength="80"></label>
    <label>Art<select id="f-kind">${Object.entries(featureKinds).map(([k, v]) => `<option value="${k}" ${k === f.kind ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label>Notizen<textarea id="f-notes" maxlength="1000">${esc(f.notes)}</textarea></label>
    <p class="muted small">Position: ${f.lat.toFixed(5)}, ${f.lng.toFixed(5)} – Marker auf der Karte lässt sich verschieben.</p>
    <div class="row"><button class="btn primary" id="f-save">Speichern</button><button class="btn danger" id="f-del">Löschen</button><button class="btn" data-close>Abbrechen</button></div>`, d => {
    $('#f-save', d).onclick = async () => { await api('/features/' + f.id, { method: 'PUT', body: { name: $('#f-name', d).value, kind: $('#f-kind', d).value, notes: $('#f-notes', d).value } }); closeDialog(); };
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
  renderActive(); renderHistory(); renderMapFeatures(); renderOnline();
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
  sel.innerHTML = stands.length ? stands.map(f => `<option value="${f.id}" ${occupied.has(f.id) ? 'data-occ="1"' : ''}>${esc(f.name)}${occupied.has(f.id) ? ' (besetzt)' : ''}</option>`).join('')
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
};
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
  renderPlans(); renderMapFeatures();
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
    renderWeather(); renderWindBadge();
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
async function loadHunts() { state.hunts = await api('/hunts'); if (state.view === 'jagd' && !state.hunt) renderHunts(); }
async function loadHunt(id) { try { state.hunt = await api('/hunts/' + id); renderHuntDetail(); } catch { state.hunt = null; renderHunts(); } }
function renderHunts() {
  $('#hunts-content').innerHTML = `
    <div class="row" style="justify-content:space-between;margin-bottom:.8rem"><h2 style="margin:0">Drückjagden</h2><button class="btn primary" id="btn-new-hunt">+ Neue Drückjagd</button></div>
    <div class="hunt-list">${state.hunts.length ? state.hunts.map(h => { const d = new Date(h.date); const [s, cls] = HUNT_STATUS[h.status]; return `
      <div class="hunt" data-id="${h.id}">
        <div class="date-box"><b>${d.getDate()}</b><span>${d.toLocaleDateString('de-DE', { month: 'short' })} ${d.getFullYear()}</span></div>
        <div><h3>${esc(h.title)}</h3><div class="muted small">${h.leader ? 'Jagdleitung: ' + esc(h.leader) + ' · ' : ''}${h.participant_count} Teilnehmer${h.meet_time ? ' · Treffen ' + esc(h.meet_time) : ''}</div></div>
        <span class="status-tag ${cls}">${s}</span></div>`; }).join('') : '<div class="card"><p class="muted">Noch keine Drückjagd geplant. Lege die erste an – alle Nutzer werden benachrichtigt.</p></div>'}</div>`;
  $('#btn-new-hunt').onclick = () => editHuntDialog();
  $$('.hunt', $('#hunts-content')).forEach(el => el.onclick = () => { location.hash = 'jagd-' + el.dataset.id; });
}
function editHuntDialog(h = null) {
  openDialog(`<h2>${h ? 'Drückjagd bearbeiten' : 'Neue Drückjagd'}</h2>
    <label>Titel<input id="h-title" value="${esc(h?.title || '')}" placeholder="z. B. Herbstdrückjagd Nordrevier" maxlength="120"></label>
    <label>Datum<input id="h-date" type="date" value="${esc(h?.date || '')}"></label>
    <label>Treffpunkt-Zeit<input id="h-time" type="time" value="${esc(h?.meet_time || '08:00')}"></label>
    <label>Treffpunkt<input id="h-point" value="${esc(h?.meet_point || '')}" placeholder="z. B. Parkplatz Forsthaus" maxlength="200"></label>
    <label>Jagdleitung<input id="h-leader" value="${esc(h?.leader || '')}" maxlength="80"></label>
    ${h ? `<label>Status<select id="h-status">${Object.entries(HUNT_STATUS).map(([k, [v]]) => `<option value="${k}" ${k === h.status ? 'selected' : ''}>${v}</option>`).join('')}</select></label>` : ''}
    <label>Beschreibung / Belehrung<textarea id="h-desc" maxlength="4000" placeholder="Freigabe, Sicherheitshinweise, Signale, Ablauf …">${esc(h?.description || '')}</textarea></label>
    <div class="row"><button class="btn primary" id="h-save">Speichern</button>${h ? '<button class="btn danger" id="h-del">Löschen</button>' : ''}<button class="btn" data-close>Abbrechen</button></div>`, d => {
    $('#h-save', d).onclick = async () => {
      const body = { title: $('#h-title', d).value, date: $('#h-date', d).value, meet_time: $('#h-time', d).value, meet_point: $('#h-point', d).value, leader: $('#h-leader', d).value, description: $('#h-desc', d).value, status: $('#h-status', d)?.value };
      try {
        const r = h ? await api('/hunts/' + h.id, { method: 'PUT', body }) : await api('/hunts', { body });
        closeDialog(); location.hash = 'jagd-' + r.id; state.hunt = r; renderHuntDetail();
      } catch (e) { toast(e.message, 'error'); }
    };
    $('#h-del', d)?.addEventListener('click', async () => { if (confirm('Drückjagd wirklich löschen?')) { await api('/hunts/' + h.id, { method: 'DELETE' }); closeDialog(); state.hunt = null; location.hash = 'jagd'; renderHunts(); } });
  });
}
function renderHuntDetail() {
  const h = state.hunt; if (!h) return renderHunts();
  const [s, cls] = HUNT_STATUS[h.status];
  const stands = state.revier.features.filter(f => f.kind === 'kanzel');
  const tabs = { uebersicht: 'Übersicht', teilnehmer: `Teilnehmer (${h.participants.length})`, treiben: `Treiben (${h.drives.length})`, checkliste: `Checkliste (${h.tasks.filter(t => t.done).length}/${h.tasks.length})`, strecke: `Strecke (${h.bag.reduce((a, b) => a + b.count, 0)})` };
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

  if (state.huntTab === 'checkliste') body = `<div class="card">
      ${h.tasks.map(t => `<div class="task ${t.done ? 'done' : ''}" data-tid="${t.id}"><input type="checkbox" ${t.done ? 'checked' : ''}><span>${esc(t.text)}${t.assignee ? ` <em class="muted small">– ${esc(t.assignee)}</em>` : ''}</span><button class="btn sm" data-del-task="${t.id}">✕</button></div>`).join('')}
      <div class="inline-form"><label>Neue Aufgabe<input id="t-text" placeholder="Was ist zu erledigen?" maxlength="200"></label><label>Zuständig<input id="t-who" placeholder="optional" maxlength="80"></label><button class="btn primary" id="t-add">Hinzufügen</button></div>
    </div>`;

  if (state.huntTab === 'strecke') body = `<div class="card">
      ${h.bag.length ? `<table class="table"><tr><th>Wildart</th><th>Stück</th><th>Erleger</th><th>Notiz</th><th></th></tr>${h.bag.map(b => `<tr><td><b>${esc(b.species)}</b></td><td>${b.count}</td><td>${esc(b.shooter)}</td><td class="muted small">${esc(b.notes)}</td><td><button class="btn sm" data-del-bag="${b.id}">✕</button></td></tr>`).join('')}</table>` : '<p class="muted">Noch keine Strecke erfasst.</p>'}
      <div class="inline-form"><label>Wildart<select id="b-species"><option>Schwarzwild – Frischling</option><option>Schwarzwild – Überläufer</option><option>Schwarzwild – Bache</option><option>Schwarzwild – Keiler</option><option>Rehwild – Bock</option><option>Rehwild – Ricke</option><option>Rehwild – Kitz</option><option>Rotwild</option><option>Damwild</option><option>Fuchs</option><option>Sonstiges</option></select></label>
        <label>Stück<input id="b-count" type="number" min="1" value="1"></label><label>Erleger<input id="b-shooter" maxlength="80" list="shooter-list"><datalist id="shooter-list">${h.participants.map(p => `<option value="${esc(p.name)}">`).join('')}</datalist></label><label>Notiz<input id="b-notes" maxlength="300"></label><button class="btn primary" id="b-add">Eintragen</button></div>
    </div>`;

  $('#hunts-content').innerHTML = `
    <button class="back" id="btn-back">← Alle Drückjagden</button>
    <div class="row" style="justify-content:space-between;align-items:flex-start"><div><h2 style="margin:0">${esc(h.title)}</h2><div class="muted">${fmtDate(h.date)} · <span class="status-tag ${cls}">${s}</span></div></div><button class="btn sm" id="btn-edit-hunt">Bearbeiten</button></div>
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
  // Checkliste
  $$('.task input[type=checkbox]', root).forEach(c => c.onchange = () => act(() => api(`${H}/tasks/${c.closest('.task').dataset.tid}`, { method: 'PUT', body: { done: c.checked } })));
  $$('[data-del-task]', root).forEach(b => b.onclick = () => act(() => api(`${H}/tasks/${b.dataset.delTask}`, { method: 'DELETE' })));
  $('#t-add', root)?.addEventListener('click', () => act(() => api(`${H}/tasks`, { body: { text: $('#t-text').value, assignee: $('#t-who').value } })));
  // Strecke
  $('#b-add', root)?.addEventListener('click', () => act(() => api(`${H}/bag`, { body: { species: $('#b-species').value, count: $('#b-count').value, shooter: $('#b-shooter').value, notes: $('#b-notes').value } })));
  $$('[data-del-bag]', root).forEach(b => b.onclick = () => act(() => api(`${H}/bag/${b.dataset.delBag}`, { method: 'DELETE' })));
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
