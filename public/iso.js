'use strict';

// Изометрия: тайл-ромб TWxTH, спрайт-биллборд высотой SH
const TW = 64, TH = 32, SH = 56;
let ORIGIN_X = 0, ORIGIN_Y = SH;
function project(gx, gy) { return { x: ORIGIN_X + (gx - gy) * (TW / 2), y: ORIGIN_Y + (gx + gy) * (TH / 2) }; }
function unproject(px, py) {
  const fx = (px - ORIGIN_X) / (TW / 2);          // gx - gy
  const fy = (py - ORIGIN_Y - TH / 2) / (TH / 2); // gx + gy (по центру ромба)
  return { x: Math.round((fx + fy) / 2), y: Math.round((fy - fx) / 2) };
}
function diamond(px, py) { // ромб от верхней вершины (px,py)
  ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + TW / 2, py + TH / 2);
  ctx.lineTo(px, py + TH); ctx.lineTo(px - TW / 2, py + TH / 2); ctx.closePath();
}
const COLORS = {
  road: '#6b7280', house: '#e8c07d',
  well: '#8fc7e8', farm: '#d9c26a', clinic: '#e88f8f', police: '#8f9fe8',
  park: '#86c28b', cafe: '#c9a882', shop: '#7fb3d5', gym: '#c98ac9',
  school: '#9fd0a0', theater: '#c98ab0', factory: '#9aa0a6',
};

const S = {
  ws: null, connected: false, outbox: [],
  pid: null, code: null, hostPid: null,
  gridSize: 18, state: null,
  selected: 'house', bulldoze: false,
  hover: null, mouse: { x: 0, y: 0 },
  catalog: {}, needs: [], tierLabels: {}, sprites: {}, houseCap: 5,
  jobs: {}, terrain: '', terrainMeta: {}, terrainSprites: {},
  districts: [], paper: null, day: 0, dayTicks: 8, tickInDay: 0, lastSeenDay: 0,
  treasury: 0,
};
const IMAGES = {};

const $ = (id) => document.getElementById(id);
const lobby = $('lobby'), game = $('game');
const canvas = $('board'), ctx = canvas.getContext('2d');

// ---------- WebSocket ----------
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  S.ws = ws;
  ws.onopen = () => {
    S.connected = true;
    const s = loadSession();
    if (s.code && s.pid) wsSend({ type: 'join', code: s.code, pid: s.pid, name: s.name });
    S.outbox.splice(0).forEach((m) => ws.send(JSON.stringify(m)));
  };
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } handle(m); };
  ws.onclose = () => { S.connected = false; setTimeout(connect, 1500); };
}
function wsSend(o) {
  if (S.connected && S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(o));
  else S.outbox.push(o);
}

// ---------- Сессия ----------
function saveSession() {
  sessionStorage.setItem('cb_pid', S.pid || '');
  sessionStorage.setItem('cb_code', S.code || '');
  sessionStorage.setItem('cb_name', $('nameInput').value || '');
}
function loadSession() {
  return { pid: sessionStorage.getItem('cb_pid'), code: sessionStorage.getItem('cb_code'), name: sessionStorage.getItem('cb_name') };
}

// ---------- Спрайты ----------
function syncSprites() {
  for (const type in S.sprites) {
    if (IMAGES[type]) continue;
    const img = new Image();
    IMAGES[type] = { img, ready: false };
    img.onload = () => { IMAGES[type].ready = true; render(); };
    img.onerror = () => { IMAGES[type] = { failed: true }; };
    img.src = S.sprites[type];
  }
  for (const code in S.terrainSprites) {
    const key = 'terrain:' + code;
    if (IMAGES[key]) continue;
    const img = new Image();
    IMAGES[key] = { img, ready: false };
    img.onload = () => { IMAGES[key].ready = true; render(); };
    img.onerror = () => { IMAGES[key] = { failed: true }; };
    img.src = S.terrainSprites[code];
  }
}

// ---------- Сообщения ----------
function handle(msg) {
  if (msg.type === 'error') return showToast(msg.message);
  if (msg.type === 'joined') {
    S.pid = msg.pid; S.code = msg.code; saveSession();
    if (msg.gridSize) S.gridSize = msg.gridSize;
    if (msg.terrain) S.terrain = msg.terrain;
    enterGame(); $('codeCopy').textContent = msg.code; return;
  }
  if (msg.type === 'state') {
    S.state = msg; S.hostPid = msg.hostPid; S.gridSize = msg.gridSize;
    S.catalog = msg.catalog; S.needs = msg.needs; S.tierLabels = msg.tierLabels; S.houseCap = msg.houseCap;
    S.sprites = msg.sprites || {}; S.districts = msg.districts || [];
    S.jobs = msg.jobs || {}; S.terrainMeta = msg.terrainMeta || {}; S.terrainSprites = msg.terrainSprites || {};
    if (msg.terrain) S.terrain = msg.terrain;
    S.reserve = msg.reserve || S.reserve || []; S.tileMax = msg.tileMax || S.tileMax || 100;
    S.day = msg.day; S.dayTicks = msg.dayTicks; S.tickInDay = msg.tickInDay; S.treasury = msg.treasury;
    if (msg.paper && msg.day > S.lastSeenDay) { S.lastSeenDay = msg.day; S.paper = msg.paper; renderPaper(); flashPaper(msg.day); }
    else if (msg.paper && !S.paper) { S.paper = msg.paper; renderPaper(); }
    syncSprites();
    if (!$('palette').childElementCount) renderPalette();
    renderBudget(); renderTaxes(); renderScoreboard(); renderDayline(); render();
  }
}

// ---------- Лобби ----------
function initLobby() {
  const s = loadSession();
  if (s.name) $('nameInput').value = s.name;
  $('createBtn').onclick = () => { const name = $('nameInput').value.trim(); if (!name) return lobbyError('Введите имя'); wsSend({ type: 'join', name }); };
  $('joinBtn').onclick = () => {
    const name = $('nameInput').value.trim(), code = $('codeInput').value.trim();
    if (!name) return lobbyError('Введите имя');
    if (!/^\d{6}$/.test(code)) return lobbyError('Код — это 6 цифр');
    wsSend({ type: 'join', name, code });
  };
  $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
}
function lobbyError(t) { const el = $('lobbyError'); el.textContent = t; el.hidden = false; }
function enterGame() { lobby.hidden = true; game.hidden = false; sizeCanvas(); }

// ---------- Палитра ----------
function renderPalette() {
  const wrap = $('palette'); wrap.innerHTML = '';
  addPaletteGroup(wrap, 'Основа', ['house', 'road']);
  for (let t = 1; t <= 5; t++) {
    const types = [...new Set(S.needs.filter((n) => n.tier === t).flatMap((n) => n.providers))];
    addPaletteGroup(wrap, `${t}. ${S.tierLabels[t]}`, types);
  }
  addPaletteGroup(wrap, '💰 Экономика', ['factory']);
  updatePaletteState();
}
function addPaletteGroup(wrap, title, types) {
  const h = document.createElement('div'); h.className = 'pal-group'; h.textContent = title; wrap.appendChild(h);
  const row = document.createElement('div'); row.className = 'pal-row';
  for (const key of types) {
    const def = S.catalog[key]; if (!def) continue;
    const el = document.createElement('div');
    el.className = 'pal-item'; el.dataset.key = key;
    const up = def.upkeep ? ` · −${def.upkeep}/т` : '';
    const rng = def.range ? `${SHAPE_NAME[def.range.shape]} r${def.range.r}` : '';
    el.title = [rng, def.upkeep ? `содержание ${def.upkeep}/тик` : '', def.emits ? '⚠ вредит соседям' : ''].filter(Boolean).join(' · ');
    el.innerHTML = `<span class="pal-glyph" style="background:${COLORS[key] || '#ccc'}">${def.glyph}</span>
      <span class="pal-meta"><span class="pal-name">${def.label}</span><span class="pal-cost">$${def.cost}${up}</span></span>`;
    el.onclick = () => { S.selected = key; S.bulldoze = false; updatePaletteState(); };
    row.appendChild(el);
  }
  wrap.appendChild(row);
}
function updatePaletteState() {
  document.querySelectorAll('.pal-item').forEach((el) => {
    const def = S.catalog[el.dataset.key];
    el.classList.toggle('active', el.dataset.key === S.selected && !S.bulldoze);
    el.classList.toggle('broke', def && S.treasury < def.cost); // не по карману казне
  });
  $('bulldozeBtn').classList.toggle('active', S.bulldoze);
}

// ---------- Бюджет / налоги / счёт / день ----------
function renderBudget() {
  const st = S.state;
  $('treasury').textContent = st.treasury;
  const net = st.flows.net;
  const nEl = $('net');
  nEl.textContent = `${net >= 0 ? '+' : '−'}${Math.abs(net)} / тик`;
  nEl.classList.toggle('neg', net < 0);
  $('population').textContent = st.population;
  $('employed').textContent = st.flows.employed;
  $('jobs').textContent = st.flows.jobs;
  $('revenue').textContent = st.flows.revenue;
  $('upkeep').textContent = st.flows.upkeep;
  $('deficit').hidden = !st.deficit;
  updatePaletteState();
}
let taxInit = false;
function renderTaxes() {
  const t = S.state.taxes;
  $('tRes').textContent = t.residential; $('tCom').textContent = t.commercial; $('tProp').textContent = t.property;
  // не перебиваем ползунок, пока пользователь его тащит
  if (!taxInit) {
    $('taxRes').value = t.residential; $('taxCom').value = t.commercial; $('taxProp').value = t.property;
    const bind = (id, kind, lbl) => {
      const el = $(id);
      el.addEventListener('input', () => { $(lbl).textContent = el.value; });
      el.addEventListener('change', () => wsSend({ type: 'settax', kind, value: Number(el.value) }));
    };
    bind('taxRes', 'residential', 'tRes'); bind('taxCom', 'commercial', 'tCom'); bind('taxProp', 'property', 'tProp');
    taxInit = true;
  } else {
    if (document.activeElement !== $('taxRes')) $('taxRes').value = t.residential;
    if (document.activeElement !== $('taxCom')) $('taxCom').value = t.commercial;
    if (document.activeElement !== $('taxProp')) $('taxProp').value = t.property;
  }
}
function renderScoreboard() {
  const ul = $('players'); ul.innerHTML = '';
  for (const p of S.state.players) {
    const li = document.createElement('li');
    li.className = 'player-row' + (p.pid === S.pid ? ' me' : '');
    const crown = p.pid === S.hostPid ? '<span class="crown">👑</span>' : '';
    li.innerHTML = `<span class="dot" style="background:${p.color}"></span>
      <span class="player-name ${p.online ? '' : 'offline'}">${escapeHtml(p.name)}${crown}</span>`;
    ul.appendChild(li);
  }
}
function renderDayline() { $('dayLabel').textContent = `День ${S.day}`; $('dayfill').style.width = `${(S.tickInDay / S.dayTicks) * 100}%`; }

// ---------- Газета ----------
const KIND_ICON = { snob: '💅', crime: '🚨', boom: '📈', exodus: '📉', reform: '🗺', quiet: '☕', epidemic: '🦠', festival: '🎉', gridlock: '🚧', district: '🏙' };
function renderPaper() {
  if (!S.paper) return;
  $('paperDay').textContent = `Выпуск №${S.paper.day}`;
  const ul = $('news'); ul.innerHTML = '';
  for (const it of S.paper.items) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="news-ic">${KIND_ICON[it.kind] || '•'}</span><span>${escapeHtml(it.text)}</span>`;
    ul.appendChild(li);
  }
  const st = S.paper.standings, box = $('standings');
  box.innerHTML = st && (st.richest || st.crime)
    ? (st.richest ? `<span>🏆 Богаче всех: <b>${escapeHtml(st.richest.name)}</b></span>` : '') +
      (st.crime && st.crime.value > 0 ? `<span>🚨 Криминал: <b>${escapeHtml(st.crime.name)}</b></span>` : '')
    : '';
}
function flashPaper(day) { showToast(`📰 Свежий выпуск, день ${day}`); const p = $('paper'); p.classList.remove('flash'); void p.offsetWidth; p.classList.add('flash'); }

// ---------- Canvas ----------
function sizeCanvas() {
  const n = S.gridSize, dpr = window.devicePixelRatio || 1;
  ORIGIN_X = (n - 1) * TW / 2 + TW / 2;
  ORIGIN_Y = SH;
  const w = n * TW, h = SH + n * TH;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}
function districtOf(x, y) {
  let bestId = -1, bd = Infinity;
  for (const d of S.districts) {
    const dx = x - d.seed.x, dy = y - d.seed.y, dist = dx * dx + dy * dy;
    if (dist < bd) { bd = dist; bestId = d.id; } else if (dist === bd && d.id < bestId) { bestId = d.id; }
  }
  return bestId;
}
function districtById(id) { return S.districts.find((d) => d.id === id); }
function covers(shape, dx, dy, r) {
  switch (shape) {
    case 'diamond': return Math.abs(dx) + Math.abs(dy) <= r;
    case 'circle': return dx * dx + dy * dy <= r * r + r;
    case 'cross': return (dx === 0 && Math.abs(dy) <= r) || (dy === 0 && Math.abs(dx) <= r);
    default: return Math.max(Math.abs(dx), Math.abs(dy)) <= r;
  }
}
const SHAPE_NAME = { square: 'квадрат', diamond: 'ромб', circle: 'круг', cross: 'крест' };

function render() {
  if (!S.state) return;
  const n = S.gridSize;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Земля — цветные ромбы (выцветают по мере истощения) + лёгкий тинт района
  for (let gy = 0; gy < n; gy++)
    for (let gx = 0; gx < n; gx++) {
      const p = project(gx, gy);
      const idx = gy * n + gx;
      const code = S.terrain ? S.terrain[idx] : 'g';
      const col = (S.terrainMeta[code] && S.terrainMeta[code].color) || '#cfe0c3';
      const depl = (S.reserve && (code === 'f' || code === 'w' || code === 's'));
      if (depl) { // подложка-трава, чтобы истощённый тайл бледнел к ней
        const g = (S.terrainMeta['g'] && S.terrainMeta['g'].color) || '#cfe0c3';
        diamond(p.x, p.y); ctx.fillStyle = g; ctx.fill();
      }
      const frac = depl ? Math.max(0, Math.min(1, (S.reserve[idx] || 0) / (S.tileMax || 100))) : 1;
      ctx.globalAlpha = depl ? (0.25 + 0.75 * frac) : 1;
      diamond(p.x, p.y); ctx.fillStyle = col; ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,.07)'; ctx.stroke();
      const d = districtById(districtOf(gx, gy));
      if (d) { ctx.globalAlpha = 0.14; diamond(p.x, p.y); ctx.fillStyle = d.color; ctx.fill(); ctx.globalAlpha = 1; }
    }

  // Превью зоны (ромбами) на земле
  if (S.hover) {
    const hc = S.state.grid[`${S.hover.x},${S.hover.y}`];
    if (hc) drawCoverage(S.hover.x, S.hover.y, hc.type);
    else {
      const code = S.terrain ? S.terrain[S.hover.y * n + S.hover.x] : 'g';
      const def = S.catalog[S.selected];
      const allow = (def && def.allow) || ['g', 'f'];
      if (!S.bulldoze && def && !allow.includes(code)) { const p = project(S.hover.x, S.hover.y); diamond(p.x, p.y); ctx.fillStyle = 'rgba(200,70,55,0.4)'; ctx.fill(); }
      else if (def && (def.range || def.emits) && !S.bulldoze) drawCoverage(S.hover.x, S.hover.y, S.selected);
    }
    const p = project(S.hover.x, S.hover.y);
    diamond(p.x, p.y); ctx.strokeStyle = S.bulldoze ? '#d98a7a' : 'rgba(42,38,34,.75)'; ctx.lineWidth = 2; ctx.stroke();
  }

  // Здания — от дальних к ближним (сортировка по глубине)
  const cells = [];
  for (const key in S.state.grid) { const [x, y] = key.split(',').map(Number); cells.push({ x, y, cell: S.state.grid[key] }); }
  cells.sort((a, b) => (a.x + a.y) - (b.x + b.y) || a.y - b.y);
  for (const c of cells) drawCell(c.x, c.y, c.cell);

  for (const d of S.districts) drawDistrictLabel(d);
}
function fillZone(cx, cy, shape, r, color) {
  const n = S.gridSize;
  ctx.fillStyle = color;
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      if (!covers(shape, dx, dy, r)) continue;
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      const p = project(x, y); diamond(p.x, p.y); ctx.fill();
    }
}
function drawCoverage(cx, cy, type) {
  const def = S.catalog[type]; if (!def) return;
  if (def.range) fillZone(cx, cy, def.range.shape, def.range.r, 'rgba(52,150,84,0.22)');
  if (def.emits) for (const e of def.emits) fillZone(cx, cy, e.shape, e.r, 'rgba(200,70,55,0.24)');
}
function roundRect(x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function drawCell(x, y, cell) {
  const def = S.catalog[cell.type] || { glyph: '?' };
  const p = project(x, y);
  const cx = p.x, baseY = p.y + TH;           // передний низ ромба
  const sp = IMAGES[cell.type];
  let topY;
  if (sp && sp.ready) {
    const w = TW, h = SH; topY = baseY - h;
    ctx.drawImage(sp.img, cx - w / 2, topY, w, h); // спрайт стоймя на тайле
  } else {
    diamond(p.x, p.y); ctx.fillStyle = COLORS[cell.type] || '#999'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = cell.ownerColor; ctx.stroke();
    ctx.fillStyle = '#2a2622'; ctx.font = '18px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(def.glyph, cx, p.y + TH * 0.72);
    topY = p.y - 2;
  }
  if (cell.type === 'house') {
    const hp = cell.happy != null ? cell.happy : 0;
    ctx.fillStyle = `hsl(${(hp / 100) * 120}, 70%, 44%)`;
    ctx.beginPath(); ctx.arc(cx + 11, topY + 5, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(42,38,34,.85)'; ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(`${cell.pop || 0}/${cell.cap || S.houseCap}`, cx, topY - 1);
  }
}
function drawDistrictLabel(d) {
  const p = project(d.seed.x, d.seed.y); const cxp = p.x, cyp = p.y + TH / 2;
  const tag = (d.epidemic ? '🦠 ' : '') + (d.crime ? '🚨 ' : '') + (d.gridlock ? '🚧 ' : '') + (d.snob ? '💅 ' : '') + (d.festival ? '🎉 ' : '') + d.name;
  ctx.font = '600 11px "Baloo 2", system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const w = ctx.measureText(tag).width + 14;
  roundRect(cxp - w / 2, cyp - 9, w, 18, 9);
  ctx.fillStyle = 'rgba(247,244,236,.9)'; ctx.fill();
  ctx.lineWidth = 1.5; ctx.strokeStyle = d.color; ctx.stroke();
  ctx.fillStyle = '#2a2622'; ctx.fillText(tag, cxp, cyp + 1);
}
function tileFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  const scale = (S.gridSize * TW) / rect.width;
  const px = (e.clientX - rect.left) * scale, py = (e.clientY - rect.top) * scale;
  const t = unproject(px, py);
  if (t.x < 0 || t.y < 0 || t.x >= S.gridSize || t.y >= S.gridSize) return null;
  return t;
}
function initCanvas() {
  canvas.addEventListener('mousemove', (e) => {
    S.mouse = { x: e.clientX, y: e.clientY };
    const t = tileFromEvent(e);
    if (t && (!S.hover || t.x !== S.hover.x || t.y !== S.hover.y)) { S.hover = t; render(); }
    updateTooltip();
  });
  canvas.addEventListener('mouseleave', () => { S.hover = null; hideTooltip(); render(); });
  canvas.addEventListener('click', (e) => {
    const t = tileFromEvent(e); if (!t) return;
    if (S.bulldoze) wsSend({ type: 'bulldoze', x: t.x, y: t.y });
    else wsSend({ type: 'place', x: t.x, y: t.y, building: S.selected });
  });
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); const t = tileFromEvent(e); if (t) wsSend({ type: 'bulldoze', x: t.x, y: t.y }); });
  $('bulldozeBtn').onclick = () => { S.bulldoze = !S.bulldoze; updatePaletteState(); };
  $('codeCopy').onclick = () => { if (!S.code) return; navigator.clipboard?.writeText(S.code).then(() => showToast('Код скопирован'), () => showToast('Код: ' + S.code)); };
  $('helpBtn').onclick = () => { buildHelp(); $('help').hidden = false; };
  $('helpClose').onclick = () => { $('help').hidden = true; };
  window.addEventListener('resize', () => { if (!game.hidden) render(); });
}

// ---------- Тултип ----------
function updateTooltip() {
  const tip = $('tooltip');
  if (!S.hover || !S.state) return hideTooltip();
  const cell = S.state.grid[`${S.hover.x},${S.hover.y}`];
  const did = districtOf(S.hover.x, S.hover.y);
  const dName = districtById(did) ? districtById(did).name : '';
  if (!cell) {
    const idx = S.hover.y * S.gridSize + S.hover.x;
    const code = S.terrain ? S.terrain[idx] : 'g';
    const tm = S.terrainMeta[code];
    const parts = [];
    if (tm) {
      let lbl = tm.label;
      if (S.reserve && (code === 'f' || code === 'w' || code === 's')) lbl += ` · запас ${Math.round(S.reserve[idx] || 0)}/${S.tileMax || 100}`;
      if (tm.build === false) lbl += ' · не застроить';
      parts.push(lbl);
    }
    if (dName) parts.push('район «' + escapeHtml(dName) + '»');
    if (!parts.length) return hideTooltip();
    tip.innerHTML = `<span class="tip-lvl">${parts.join(' · ')}</span>`;
    return placeTooltip(tip);
  }
  const def = S.catalog[cell.type] || {};
  let html = `<b>${def.label || cell.type}</b> <span class="tip-dist">· ${escapeHtml(dName)}</span>`;
  if (cell.type === 'house') {
    const lvl = cell.level || 0, hp = cell.happy != null ? cell.happy : 0;
    html += `<div class="tip-lvl">👥 ${cell.pop || 0}/${cell.cap || S.houseCap} · счастье ${hp}%</div>`;
    html += `<div class="tip-lvl">Уровень ${lvl}/5${lvl ? ' — ' + S.tierLabels[lvl] : ' — базовые нужды не закрыты'}</div>`;
    const move = (cell.savings || 0) >= 40;
    html += `<div class="tip-lvl">💰 накопления ${cell.savings || 0}${hp <= 35 ? (move ? ' · копят на переезд в район получше' : ' · денег на переезд нет') : ''}</div>`;
    const nz = nuisancesAt(S.hover.x, S.hover.y);
    if (nz.length) html += `<div class="tip-lvl tip-bad">⚠ рядом: ${nz.join(', ')}</div>`;
    html += '<div class="tip-needs">';
    for (let t = 1; t <= 5; t++) {
      const parts = S.needs.filter((n) => n.tier === t).map((n) =>
        `<span class="${cell.needs && cell.needs[n.key] ? 'ok' : 'no'}">${cell.needs && cell.needs[n.key] ? '✓' : '✗'} ${n.label}</span>`).join(' ');
      html += `<div class="tip-tier"><span class="tip-t">${t}</span>${parts}</div>`;
    }
    html += '</div>';
  } else if (def.range || def.kind === 'industry') {
    if (def.range) html += `<div class="tip-lvl">зона: ${SHAPE_NAME[def.range.shape]} r${def.range.r} (+1 у дороги) · обслуживает домов: ${cell.served || 0}</div>`;
    if (def.output) html += `<div class="tip-lvl">коммерческий оборот +${def.output}</div>`;
    const jb = S.jobs[cell.type] || 0;
    html += `<div class="tip-lvl">${jb ? 'рабочих мест: ' + jb + ' · ' : ''}содержание ${def.upkeep || 0}/тик</div>`;
    if (def.emits) for (const e of def.emits) html += `<div class="tip-lvl tip-bad">⚠ ${e.label}: ${e.negates ? '−' + needLabel(e.negates) + ', ' : ''}счастье ${e.happy} (${SHAPE_NAME[e.shape]} r${e.r})</div>`;
  } else {
    html += `<div class="tip-lvl">содержание ${def.upkeep || 0}/тик</div>`;
  }
  tip.innerHTML = html;
  placeTooltip(tip);
}
function placeTooltip(tip) {
  tip.hidden = false;
  const pad = 14; let x = S.mouse.x + pad, y = S.mouse.y + pad;
  const r = tip.getBoundingClientRect();
  if (x + r.width > window.innerWidth) x = S.mouse.x - r.width - pad;
  if (y + r.height > window.innerHeight) y = S.mouse.y - r.height - pad;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
function hideTooltip() { $('tooltip').hidden = true; }
function needLabel(key) { const n = S.needs.find((x) => x.key === key); return n ? n.label : key; }
function nuisancesAt(x, y) {
  const out = [];
  for (const k in S.state.grid) {
    const b = S.state.grid[k], bd = S.catalog[b.type];
    if (!bd || !bd.emits) continue;
    const [bx, by] = k.split(',').map(Number);
    for (const e of bd.emits) if (covers(e.shape, x - bx, y - by, e.r) && !out.includes(e.label)) out.push(e.label);
  }
  return out;
}

// ---------- Справка ----------
function buildHelp() {
  let html = '<p>Дом заселяют жители (до вместимости). Счастье зависит от уровня Маслоу, тесноты, налогов и событий района. Счастливые с местом приезжают, несчастные с деньгами переезжают в район получше, несчастные без денег покидают город.</p>';
  html += '<p>Казна <b>общая</b>. Доход — налоги (жилой бьёт по счастью сильнее всего, коммерческий мягче, имущественный — почти нет). Расход — содержание зданий за тик. Уйдёшь в минус — сервисы под угрозой, жители недовольны.</p>';
  html += '<p>Город начинается единым посёлком; по мере роста населения появляются <b>районы</b> (🏙), их границы двигаются вслед за застройкой. Раз в день выходит газета с событиями районов.</p>';
  html += '<table class="help-table"><thead><tr><th>Уровень</th><th>Потребность</th><th>Чем закрыть</th></tr></thead><tbody>';
  for (let t = 1; t <= 5; t++) {
    const tn = S.needs.filter((n) => n.tier === t);
    tn.forEach((n, i) => {
      const provs = n.providers.map((p) => `${S.catalog[p].glyph} ${S.catalog[p].label}`).join(' / ');
      html += `<tr>${i === 0 ? `<td rowspan="${tn.length}"><b>${t}</b> ${S.tierLabels[t]}</td>` : ''}<td>${n.label}</td><td>${provs}</td></tr>`;
    });
  }
  html += '</tbody></table>';
  $('helpBody').innerHTML = html;
}

// ---------- Прочее ----------
let toastTimer;
function showToast(t) { const el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2800); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

initLobby(); initCanvas(); connect();
