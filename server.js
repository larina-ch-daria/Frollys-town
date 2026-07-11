'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

// --- Операционный конфиг (env) ---
const PORT = parseInt(process.env.PORT || '3000', 10);
const GRID_SIZE = parseInt(process.env.GRID_SIZE || '18', 10);
const START_TREASURY = parseInt(process.env.START_TREASURY || '1000', 10);
const HOUSE_CAP = parseInt(process.env.HOUSE_CAP || '5', 10);
const TICK_MS = parseInt(process.env.TICK_MS || '3000', 10);
const DAY_TICKS = parseInt(process.env.DAY_TICKS || '8', 10);
const ROOM_TTL_MS = parseInt(process.env.ROOM_TTL_MS || String(15 * 60 * 1000), 10);
const DISTRICT_COUNT = parseInt(
  process.env.DISTRICT_COUNT || String(Math.max(3, Math.min(6, Math.round(GRID_SIZE / 4.5)))), 10);

// ================== ТАБЛИЦЫ ==================
// range: {shape, r} — форма и размер зоны обслуживания (square|diamond|circle|cross).
// emits: [{label, shape, r, happy, negates}] — вредное воздействие в зоне.
// output — плоский коммерческий оборот (для завода). upkeep — содержание за тик.
const BUILDINGS = {
  center:  { cost: 0,   kind: 'center',   glyph: '🚩', label: 'Центр города', upkeep: 0, allow: ['g', 'f'] },
  road:    { cost: 10,  kind: 'road',     glyph: '🛣', label: 'Дорога',   upkeep: 0 },
  house:   { cost: 50,  kind: 'house',    glyph: '🏠', label: 'Дом',      upkeep: 0, wood: 5 },
  well:    { cost: 60,  kind: 'provider', glyph: '💧', label: 'Колодец',  upkeep: 2, wood: 2, stone: 3, range: { shape: 'diamond', r: 3 }, produces: { res: 'water', from: 'w', mode: 'flat' } },
  farm:    { cost: 60,  kind: 'provider', glyph: '🌾', label: 'Ферма',    upkeep: 2, wood: 3, allow: ['g'], range: { shape: 'square',  r: 3 }, produces: { res: 'food', from: 'g', mode: 'perTile' } },
  sawmill: { cost: 40,  kind: 'provider', glyph: '🪚', label: 'Лесопилка', upkeep: 2, range: { shape: 'square', r: 3 }, produces: { res: 'wood', from: 'f', mode: 'perTile' } },
  quarry:  { cost: 40,  kind: 'provider', glyph: '⛏', label: 'Каменоломня', upkeep: 2, wood: 4, range: { shape: 'square', r: 3 }, produces: { res: 'stone', from: 's', mode: 'perTile' } },
  clinic:  { cost: 120, kind: 'provider', glyph: '🏥', label: 'Клиника',  upkeep: 5, wood: 4, stone: 6, range: { shape: 'circle',  r: 4 } },
  police:  { cost: 120, kind: 'provider', glyph: '🚓', label: 'Полиция',  upkeep: 5, wood: 4, stone: 6, range: { shape: 'circle',  r: 4 } },
  park:    { cost: 40,  kind: 'provider', glyph: '🌳', label: 'Парк',     upkeep: 1, wood: 2, range: { shape: 'circle',  r: 3 } },
  cafe:    { cost: 80,  kind: 'provider', glyph: '☕', label: 'Кафе',     upkeep: 3, wood: 4, stone: 2, range: { shape: 'diamond', r: 2 }, commercial: true, emits: [{ label: 'шум', shape: 'diamond', r: 2, happy: -6 }] },
  shop:    { cost: 100, kind: 'provider', glyph: '🏪', label: 'Магазин',  upkeep: 3, wood: 4, stone: 4, range: { shape: 'square',  r: 3 }, commercial: true },
  gym:     { cost: 100, kind: 'provider', glyph: '🏋', label: 'Спортзал', upkeep: 3, wood: 4, stone: 4, range: { shape: 'diamond', r: 3 }, commercial: true, emits: [{ label: 'шум', shape: 'square', r: 1, happy: -5 }] },
  school:  { cost: 150, kind: 'provider', glyph: '🏫', label: 'Школа',    upkeep: 4, wood: 6, stone: 6, range: { shape: 'cross',   r: 5 } },
  theater: { cost: 150, kind: 'provider', glyph: '🎭', label: 'Театр',    upkeep: 5, wood: 6, stone: 8, range: { shape: 'circle',  r: 4 }, commercial: true, emits: [{ label: 'шум', shape: 'circle', r: 2, happy: -10 }] },
  factory: { cost: 140, kind: 'industry', glyph: '🏭', label: 'Завод',    upkeep: 4, wood: 4, stone: 10, output: 12, emits: [{ label: 'загрязнение', shape: 'circle', r: 3, happy: -20, negates: 'health' }] },
};

const NEEDS = [
  { tier: 1, key: 'water',     label: 'Вода',       providers: ['well'] },
  { tier: 1, key: 'food',      label: 'Еда',        providers: ['farm'] },
  { tier: 2, key: 'health',    label: 'Здоровье',   providers: ['clinic'] },
  { tier: 2, key: 'security',  label: 'Порядок',    providers: ['police'] },
  { tier: 3, key: 'community', label: 'Сообщество', providers: ['park', 'cafe'] },
  { tier: 4, key: 'esteem',    label: 'Признание',  providers: ['shop', 'gym'] },
  { tier: 5, key: 'growth',    label: 'Развитие',   providers: ['school', 'theater'] },
];
const TIER_LABEL = { 1: 'Физиология', 2: 'Безопасность', 3: 'Принадлежность', 4: 'Уважение', 5: 'Самореализация' };
const MAX_TIER = 5;
const SOCIAL_PROVIDERS = new Set(NEEDS.filter((n) => n.tier === 3 || n.tier === 4).flatMap((n) => n.providers));
const SERVICE_FEE = 1;           // «оборот» коммерческого провайдера за обслуженный дом

// Ресурсы-склад (еда/вода): производители льют в общий пул, жители потребляют.
const WATER_PER_WELL = 6;        // производство воды колодцем за тик
const FOOD_PER_GRASS = 0.5;      // еда фермы = FOOD_PER_GRASS × тайлов травы в её радиусе
const WOOD_PER_FOREST = 0.5;     // дерево лесопилки = × тайлов леса в радиусе
const STONE_PER_ROCK = 0.5;      // камень каменоломни = × тайлов камня в радиусе
const CONSUME_WATER = 1;         // потребление воды на жителя за тик
const CONSUME_FOOD = 1;          // потребление еды на жителя за тик
const STOCK_CAP = 999;           // потолок склада
const TILE_RESERVE = parseInt(process.env.TILE_RESERVE || '100', 10); // запас ресурса на тайле леса/камня/воды
const RES_RATE = { water: WATER_PER_WELL, food: FOOD_PER_GRASS, wood: WOOD_PER_FOREST, stone: STONE_PER_ROCK };
const START_WOOD = parseInt(process.env.START_WOOD || '30', 10);   // стартовый запас дерева
const START_STONE = parseInt(process.env.START_STONE || '20', 10); // стартовый запас камня
const FAITH_PER_POP = 2;         // вера = население × коэффициент (пока фикс)
const FAITH_BASE_RADIUS = parseInt(process.env.FAITH_BASE_RADIUS || '3', 10);   // радиус застройки от центра на старте
const FAITH_RADIUS_COEF = parseFloat(process.env.FAITH_RADIUS_COEF || '0.15');  // прибавка радиуса за единицу веры

// Рабочие места по типам зданий (жители едут только на свободные)
const JOBS = { factory: 8, shop: 3, cafe: 3, gym: 3, theater: 3, clinic: 4, police: 4, school: 4, well: 1, farm: 1, sawmill: 2, quarry: 2, park: 0, road: 0, house: 0 };
function jobsOf(type) { return JOBS[type] || 0; }
const UNEMP_PENALTY_MAX = 30;    // штраф к счастью при 100% безработице

// Ландшафт. build:false — непроходимо; nature — бонус к счастью соседним домам.
const TERRAIN = {
  g: { label: 'Трава',  build: true,  color: '#cfe0c3' },
  f: { label: 'Лес',    build: true,  color: '#8fae7f', nature: true },
  w: { label: 'Вода',   build: false, color: '#8fbcd9', nature: true },
  s: { label: 'Скалы',  build: false, color: '#b3aea6' },
};
const NATURE_BONUS = 3;          // +счастье за каждого природного соседа
const NATURE_CAP = 9;

// --- Налоги (ставки в %), настраиваются игроками, общие на комнату ---
const DEFAULT_TAXES = { residential: 10, commercial: 10, property: 5 };
const TAX_MAX = 40;
const PROPERTY_UNIT = 10;        // база имущественного налога на здание

// --- Счастье и миграция ---
const GROW_H = 40;               // счастье, при котором дом начинает заселяться
const LEAVE_H = 30;              // счастье, при котором уезжают
const MOVE_COST = 40;            // накопления домохозяйства для переезда внутри города

// --- События ---
const MOD_DAYS = 3, DRIFT = 0.34, CRIME_THRESHOLD = 6, SNOB_MIN = 30, SNOB_RATIO = 1.6;
const EPIDEMIC_POP = 8, EPIDEMIC_CHANCE = 30, EPIDEMIC_CHANCE_CLINIC = 8;
const FESTIVAL_CHANCE = 25, GRIDLOCK_PROVIDERS = 4;
const FIRST_DISTRICT_POP = parseInt(process.env.FIRST_DISTRICT_POP || '10', 10); // население для первого деления
const DISTRICT_STEP = parseInt(process.env.DISTRICT_STEP || '12', 10);           // +население на каждый следующий район
const DISTRICT_NAMES = ['Староречье', 'Заводская', 'Приморье', 'Верхний', 'Слобода', 'Гавань'];
const DISTRICT_COLORS = ['#e0a458', '#5aa0a0', '#a07bd0', '#7f9c5a', '#c07a9c', '#6f93c0'];
// =============================================

const OWNER_COLORS = ['#ff6b6b', '#14b8a6', '#f59e0b', '#8b5cf6', '#ec4899', '#84cc16', '#0ea5e9', '#f97316'];

// --- Спрайты ---
const SPRITE_DIR = path.join(__dirname, 'public', 'sprites');
let spriteMap = {};
function scanSprites() {
  const map = {};
  try {
    for (const f of fs.readdirSync(SPRITE_DIR)) {
      const m = f.match(/^([a-z]+)\.(png|webp|jpe?g|gif|svg)$/i);
      if (m && BUILDINGS[m[1].toLowerCase()]) map[m[1].toLowerCase()] = 'sprites/' + f;
    }
  } catch { /* нет папки */ }
  return map;
}
spriteMap = scanSprites();

// Спрайты ландшафта: public/sprites/terrain/<name>.<ext>
const TERRAIN_DIR = path.join(SPRITE_DIR, 'terrain');
const TERRAIN_FILE = { grass: 'g', forest: 'f', water: 'w', stone: 's' };
let terrainSprites = {};
function scanTerrainSprites() {
  const map = {};
  try {
    for (const f of fs.readdirSync(TERRAIN_DIR)) {
      const m = f.match(/^(grass|forest|water|stone)\.(png|webp|jpe?g|gif|svg)$/i);
      if (m) map[TERRAIN_FILE[m[1].toLowerCase()]] = 'sprites/terrain/' + f;
    }
  } catch { /* нет папки */ }
  return map;
}
terrainSprites = scanTerrainSprites();

const rooms = new Map();

function genCode() {
  let code; do { code = crypto.randomInt(0, 1e6).toString().padStart(6, '0'); } while (rooms.has(code));
  return code;
}
function genPid() { return crypto.randomBytes(8).toString('hex'); }
function pickColor(room) {
  const used = new Set([...room.players.values()].map((p) => p.color));
  return OWNER_COLORS.find((c) => !used.has(c)) || OWNER_COLORS[room.players.size % OWNER_COLORS.length];
}
function neighbors(x, y) { return [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]; }function cheb(a, b) { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Форма зоны покрытия/воздействия (одинаково на сервере и клиенте)
function covers(shape, dx, dy, r) {
  switch (shape) {
    case 'diamond': return Math.abs(dx) + Math.abs(dy) <= r;
    case 'circle': return dx * dx + dy * dy <= r * r + r;
    case 'cross': return (dx === 0 && Math.abs(dy) <= r) || (dy === 0 && Math.abs(dx) <= r);
    default: return Math.max(Math.abs(dx), Math.abs(dy)) <= r; // square
  }
}

// --- Ландшафт (генерится один раз при создании города) ---
function genTerrain() {
  const n = GRID_SIZE, t = new Array(n * n).fill('g');
  const idx = (x, y) => y * n + x;
  const paint = (ch, tiles) => {
    let x = crypto.randomInt(0, n), y = crypto.randomInt(0, n);
    for (let i = 0; i < tiles; i++) {
      if (x >= 0 && y >= 0 && x < n && y < n) t[idx(x, y)] = ch;
      x = clamp(x + crypto.randomInt(-1, 2), 0, n - 1);
      y = clamp(y + crypto.randomInt(-1, 2), 0, n - 1);
    }
  };
  const area = n * n;
  const waterBlobs = 2 + Math.floor(n / 12), stoneBlobs = 1 + Math.floor(n / 14), forestBlobs = 2 + Math.floor(n / 10);
  for (let i = 0; i < waterBlobs; i++) paint('w', Math.round(area * 0.05));
  for (let i = 0; i < stoneBlobs; i++) paint('s', Math.round(area * 0.04));
  for (let i = 0; i < forestBlobs; i++) paint('f', Math.round(area * 0.05));
  return t;
}
function terrainAt(room, x, y) { return room.terrain ? room.terrain[y * GRID_SIZE + x] : 'g'; }
function buildable(room, x, y) { const t = TERRAIN[terrainAt(room, x, y)]; return !t || t.build !== false; }
// Пообъектное размещение: где здание можно ставить (по умолчанию трава/лес)
function allowOf(type) { return (BUILDINGS[type] && BUILDINGS[type].allow) || ['g', 'f']; }
function canPlace(room, x, y, type) { return allowOf(type).includes(terrainAt(room, x, y)); }
function cityFaith(room) { let p = 0; for (const c of room.grid.values()) if (c.type === 'house') p += c.pop || 0; return p * FAITH_PER_POP; }
function cityRadius(room) { return FAITH_BASE_RADIUS + Math.floor(cityFaith(room) * FAITH_RADIUS_COEF); }
function inCity(room, x, y) { if (!room.center) return false; const dx = x - room.center.x, dy = y - room.center.y, R = cityRadius(room); return dx * dx + dy * dy <= R * R + R; }
// Запас ресурса на тайле (лес/камень/вода истощаются; трава/земля — нет)
const DEPLETABLE = new Set(['f', 's', 'w']);
function initReserve(terrain) {
  const rv = new Array(terrain.length).fill(0);
  for (let i = 0; i < terrain.length; i++) if (DEPLETABLE.has(terrain[i])) rv[i] = TILE_RESERVE;
  return rv;
}
// Добыча с истощением (вызывается в тик-цикле, мутирует room.terrain/room.reserve)
function extractResources(room) {
  const n = GRID_SIZE, out = { water: 0, food: 0, wood: 0, stone: 0 };
  const roadSet = new Set();
  for (const [k, c] of room.grid) if (c.type === 'road') roadSet.add(k);
  const depleted = [];
  for (const [k, cell] of room.grid) {
    const def = BUILDINGS[cell.type]; if (!def || !def.produces) continue;
    const pr = def.produces, [px, py] = k.split(',').map(Number);
    const nearRoad = neighbors(px, py).some(([nx, ny]) => roadSet.has(`${nx},${ny}`));
    const r = def.range.r + (nearRoad ? 1 : 0), rate = RES_RATE[pr.res];
    // еда: трава не истощается
    if (pr.from === 'g') {
      let count = 0;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (!covers(def.range.shape, dx, dy, r)) continue;
        const gx = px + dx, gy = py + dy;
        if (gx < 0 || gy < 0 || gx >= n || gy >= n) continue;
        if (room.terrain[gy * n + gx] === 'g') count += 1;
      }
      out.food += count * rate; continue;
    }
    // истощаемые: вода/дерево/камень — тянем из запаса тайлов
    let got = 0; const flat = pr.mode === 'flat';
    for (let dy = -r; dy <= r && (!flat || got < rate); dy++)
      for (let dx = -r; dx <= r && (!flat || got < rate); dx++) {
        if (!covers(def.range.shape, dx, dy, r)) continue;
        const gx = px + dx, gy = py + dy; if (gx < 0 || gy < 0 || gx >= n || gy >= n) continue;
        const idx = gy * n + gx;
        if (room.terrain[idx] !== pr.from || room.reserve[idx] <= 0) continue;
        const take = flat ? Math.min(room.reserve[idx], rate - got) : Math.min(room.reserve[idx], rate);
        room.reserve[idx] -= take; got += take;
        if (room.reserve[idx] <= 0) depleted.push(idx);
      }
    out[pr.res] += got;
  }
  // опустевшие тайлы становятся травой
  for (const idx of depleted) { room.terrain[idx] = 'g'; room.reserve[idx] = 0; }
  room.terrainDirty = room.terrainDirty || depleted.length > 0;
  return out;
}

// --- Районы появляются постепенно, по мере роста населения ---
function districtTarget(totalPop) {
  if (totalPop < FIRST_DISTRICT_POP) return 0;
  return Math.min(DISTRICT_COUNT, 2 + Math.floor((totalPop - FIRST_DISTRICT_POP) / DISTRICT_STEP));
}
function createDistrict(room, seed, news) {
  const idx = room.districts.length;
  const d = {
    id: room.nextDistrictId++, name: DISTRICT_NAMES[idx % DISTRICT_NAMES.length],
    color: DISTRICT_COLORS[idx % DISTRICT_COLORS.length], seed: { x: seed.x, y: seed.y },
    mods: {}, crime: 0, prevPop: 0,
  };
  room.districts.push(d);
  if (room.districts.length >= 2) news.push({ kind: 'district', text: `Город разросся — образовался район «${d.name}».` });
}
function spawnDistrict(room, news) {
  const cells = [...room.grid.keys()].map((k) => k.split(',').map(Number));
  let seed;
  if (room.districts.length === 0) {
    if (cells.length) seed = { x: Math.round(cells.reduce((a, c) => a + c[0], 0) / cells.length), y: Math.round(cells.reduce((a, c) => a + c[1], 0) / cells.length) };
    else seed = { x: Math.floor(GRID_SIZE / 2), y: Math.floor(GRID_SIZE / 2) };
  } else {
    // район с наибольшим населением делим: новое семя в его самой дальней застройке
    const popById = {}, cellsBy = {};
    for (const d of room.districts) { popById[d.id] = 0; cellsBy[d.id] = []; }
    for (const [k, cell] of room.grid) {
      const [x, y] = k.split(',').map(Number);
      const did = districtOf(room, x, y);
      if (did < 0) continue;
      if (cell.type === 'house') popById[did] += cell.pop || 0;
      cellsBy[did].push([x, y]);
    }
    let big = room.districts[0];
    for (const d of room.districts) if ((popById[d.id] || 0) > (popById[big.id] || 0)) big = d;
    let far = null, fd = -1;
    for (const [x, y] of (cellsBy[big.id] || [])) { const dd = (x - big.seed.x) ** 2 + (y - big.seed.y) ** 2; if (dd > fd) { fd = dd; far = [x, y]; } }
    seed = far ? { x: far[0], y: far[1] } : { x: crypto.randomInt(0, GRID_SIZE), y: crypto.randomInt(0, GRID_SIZE) };
  }
  createDistrict(room, seed, news);
}
function maybeGrowDistricts(room, totalPop, news) {
  const target = districtTarget(totalPop);
  while (room.districts.length < target) spawnDistrict(room, news);
}
function districtOf(room, x, y) {
  let bestId = -1, bd = Infinity;
  for (const d of room.districts) {
    const dx = x - d.seed.x, dy = y - d.seed.y, dist = dx * dx + dy * dy;
    if (dist < bd) { bd = dist; bestId = d.id; } else if (dist === bd && d.id < bestId) { bestId = d.id; }
  }
  return bestId;
}

// --- Счастье домохозяйства (0..100) ---
function happiness(level, pop, cap, taxes, crime, epidemic, deficit, extra) {
  let h = 20 + (level / MAX_TIER) * 70;
  const soft = cap * 0.8;
  if (pop > soft) h -= (pop - soft) * 12;   // теснота
  h -= taxes.residential * 0.6;             // жилой налог бьёт сильнее
  h -= taxes.commercial * 0.2;              // коммерческий мягче
  if (crime) h -= 15;
  if (epidemic) h -= 30;
  if (deficit) h -= 15;                     // город в долгах — сервисы под угрозой
  h += extra || 0;                          // шум/загрязнение от соседних зданий
  return clamp(Math.round(h), 0, 100);
}

// --- Ядро симуляции (чистая функция) ---
function computeSim(room) {
  const cells = [];
  for (const [k, c] of room.grid) { const [x, y] = k.split(',').map(Number); cells.push({ k, x, y, ...c }); }
  const dOf = new Map();
  for (const c of cells) dOf.set(c.k, districtOf(room, c.x, c.y));

  const snobSet = new Set(room.districts.filter((d) => d.mods.snob).map((d) => d.id));
  const crimeSet = new Set(room.districts.filter((d) => d.mods.crime).map((d) => d.id));
  const epidemicSet = new Set(room.districts.filter((d) => d.mods.epidemic).map((d) => d.id));
  const festivalSet = new Set(room.districts.filter((d) => d.mods.festival).map((d) => d.id));
  const gridlockSet = new Set(room.districts.filter((d) => d.mods.gridlock).map((d) => d.id));

  const roadSet = new Set(cells.filter((c) => c.type === 'road').map((c) => c.k));
  const providers = cells
    .filter((c) => BUILDINGS[c.type] && BUILDINGS[c.type].kind === 'provider')
    .map((c) => {
      const rng = BUILDINGS[c.type].range;
      const nearRoad = neighbors(c.x, c.y).some(([nx, ny]) => roadSet.has(`${nx},${ny}`));
      let r = rng.r + (nearRoad ? 1 : 0);
      if (gridlockSet.has(dOf.get(c.k))) r = Math.max(1, r - 1);
      return { ...c, shape: rng.shape, r };
    });
  const houses = cells.filter((c) => c.type === 'house');
  // Рынок труда (общегородской): жители едут на свободные места, платят только занятые
  let totalPop = 0, totalJobs = 0;
  for (const c of cells) { if (c.type === 'house') totalPop += c.pop || 0; totalJobs += jobsOf(c.type); }
  const empFraction = totalPop > 0 ? Math.min(1, totalJobs / totalPop) : 1;
  const unempPenalty = Math.round((1 - empFraction) * UNEMP_PENALTY_MAX);

  // Дефицит воды/еды берём из состояния (склад считается в тик-цикле)
  const waterShort = !!(room.short && room.short.water), foodShort = !!(room.short && room.short.food);

  // Вредные зоны (шум, загрязнение)
  const nuisances = [];
  for (const c of cells) {
    const em = BUILDINGS[c.type] && BUILDINGS[c.type].emits;
    if (em) for (const e of em) nuisances.push({ x: c.x, y: c.y, ...e });
  }

  const houseInfo = new Map();
  const served = new Map();
  const taxes = room.taxes;

  for (const h of houses) {
    const hDist = dOf.get(h.k);
    const inRangeTypes = new Set();
    for (const p of providers) {
      if (!covers(p.shape, h.x - p.x, h.y - p.y, p.r)) continue;
      const pDist = dOf.get(p.k);
      if (SOCIAL_PROVIDERS.has(p.type) && snobSet.has(pDist) && pDist !== hDist) continue;
      inRangeTypes.add(p.type);
      served.set(p.k, (served.get(p.k) || 0) + 1);
    }
    const needs = {};
    for (const need of NEEDS) needs[need.key] = need.providers.some((t) => inRangeTypes.has(t));
    needs.water = !waterShort;   // покрытие воды/еды — от общего склада, не от радиуса
    needs.food = !foodShort;
    if (crimeSet.has(hDist)) needs.security = false;
    if (festivalSet.has(hDist)) needs.community = true;

    // Вредные воздействия: гасят показатель и/или счастье
    let extra = -unempPenalty;
    for (const nz of nuisances) {
      if (!covers(nz.shape, h.x - nz.x, h.y - nz.y, nz.r)) continue;
      extra += nz.happy || 0;
      if (nz.negates) needs[nz.negates] = false;
    }
    // Природа рядом (лес/вода) поднимает счастье
    let nature = 0;
    for (const [nx, ny] of neighbors(h.x, h.y)) {
      if (nx < 0 || ny < 0 || nx >= GRID_SIZE || ny >= GRID_SIZE) continue;
      const tt = TERRAIN[terrainAt(room, nx, ny)];
      if (tt && tt.nature) nature += NATURE_BONUS;
    }
    extra += Math.min(NATURE_CAP, nature);

    let level = 0;
    for (let t = 1; t <= MAX_TIER; t++) {
      const tn = NEEDS.filter((n) => n.tier === t);
      if (tn.every((n) => needs[n.key])) level = t; else break;
    }
    if (epidemicSet.has(hDist)) level = 0;

    const pop = h.pop || 0;
    const cap = h.cap || HOUSE_CAP;
    const happy = happiness(level, pop, cap, taxes, crimeSet.has(hDist), epidemicSet.has(hDist), room.deficit, extra);
    const gross = pop * (1 + level) * 2; // налогооблагаемая ценность домохозяйства
    houseInfo.set(h.k, { level, needs, pop, cap, district: hDist, happy, gross });
  }

  // Налоги и содержание
  let residential = 0, commercial = 0, property = 0, upkeep = 0;
  for (const info of houseInfo.values()) residential += info.gross * empFraction * (taxes.residential / 100);
  let commBase = 0;
  for (const p of providers) if (BUILDINGS[p.type].commercial) commBase += (served.get(p.k) || 0) * SERVICE_FEE;
  for (const c of cells) if (BUILDINGS[c.type] && BUILDINGS[c.type].output) commBase += BUILDINGS[c.type].output;
  commercial = commBase * (taxes.commercial / 100);
  for (const c of cells) {
    property += PROPERTY_UNIT * (taxes.property / 100);
    upkeep += (BUILDINGS[c.type] ? BUILDINGS[c.type].upkeep : 0) || 0;
  }
  const revenue = residential + commercial + property;
  const flows = {
    residential: Math.round(residential), commercial: Math.round(commercial),
    property: Math.round(property), revenue: Math.round(revenue),
    upkeep: Math.round(upkeep), net: Math.round(revenue - upkeep),
    jobs: totalJobs, employed: Math.min(totalPop, totalJobs), population: totalPop,
  };
  return { houseInfo, served, dOf, flows };
}

// ================== СОБЫТИЯ ==================
function evSnob(room, ctx, news) {
  if (room.districts.length < 2) return; // зазнаваться не перед кем
  const sorted = [...room.districts].sort((a, b) => ctx.prosperity[b.id] - ctx.prosperity[a.id]);
  const rich = sorted[0];
  const second = ctx.prosperity[sorted[1] ? sorted[1].id : rich.id] || 1;
  if (ctx.prosperity[rich.id] >= SNOB_MIN && ctx.prosperity[rich.id] >= SNOB_RATIO * second) {
    if (!rich.mods.snob) news.push({ kind: 'snob', text: `«${rich.name}» зазнался: богатейший район больше не пускает чужаков в свои магазины, кафе и парки.` });
    rich.mods.snob = MOD_DAYS;
  }
}
function evCrime(room, ctx, news) {
  for (const d of room.districts) {
    d.crime = Math.max(0, d.crime + ctx.tension[d.id] - (ctx.hasPolice[d.id] ? 3 : 0) - 1);
    if (d.crime >= CRIME_THRESHOLD && !d.mods.crime) {
      d.mods.crime = MOD_DAYS; d.crime = Math.max(0, d.crime - 4);
      d.seed.x = clamp(d.seed.x + crypto.randomInt(-2, 3), 0, GRID_SIZE - 1);
      d.seed.y = clamp(d.seed.y + crypto.randomInt(-2, 3), 0, GRID_SIZE - 1);
      news.push({ kind: 'crime', text: `Криминальная волна в «${d.name}»: банды хозяйничают на улицах${!ctx.hasClinic[d.id] ? ', а больницы поблизости нет — раненых некому лечить' : ''}. Безопасность падает.` });
    }
  }
}
function evBoomExodus(room, ctx, news) {
  for (const d of room.districts) {
    const delta = ctx.pop[d.id] - d.prevPop;
    if (delta >= 3) news.push({ kind: 'boom', text: `Бум в «${d.name}»: за день прибавилось ${delta} жителей, район на подъёме.` });
    else if (delta <= -3) news.push({ kind: 'exodus', text: `Люди бегут из «${d.name}»: район опустел на ${-delta} жителей.` });
  }
}
function evEpidemic(room, ctx, news) {
  for (const d of room.districts) {
    if (ctx.pop[d.id] < EPIDEMIC_POP || d.mods.epidemic) continue;
    const chance = ctx.hasClinic[d.id] ? EPIDEMIC_CHANCE_CLINIC : EPIDEMIC_CHANCE;
    if (crypto.randomInt(0, 100) < chance) {
      d.mods.epidemic = MOD_DAYS;
      news.push({ kind: 'epidemic', text: `Эпидемия в «${d.name}»: ${!ctx.hasClinic[d.id] ? 'переполненный район без единой больницы слёг' : 'больницы не справляются с наплывом больных'}, жизнь замерла.` });
    }
  }
}
function evFestival(room, ctx, news) {
  for (const d of room.districts) {
    const t = ctx.types[d.id];
    const cultural = t.has('theater') && (t.has('park') || t.has('cafe'));
    if (cultural && ctx.pop[d.id] >= 3 && !d.mods.festival && crypto.randomInt(0, 100) < FESTIVAL_CHANCE) {
      d.mods.festival = MOD_DAYS;
      news.push({ kind: 'festival', text: `Фестиваль в «${d.name}»: район гуляет, соседи тянутся на праздник — жителям хорошо и без лишних кафе.` });
    }
  }
}
function evGridlock(room, ctx, news) {
  for (const d of room.districts) {
    if (ctx.provCount[d.id] >= GRIDLOCK_PROVIDERS && ctx.roadCount[d.id] === 0 && !d.mods.gridlock) {
      d.mods.gridlock = MOD_DAYS;
      news.push({ kind: 'gridlock', text: `Пробки в «${d.name}»: застроились, а дорог не проложили — сервисы не дотягиваются до окраин.` });
    }
  }
}
const DAY_EVENTS = [evSnob, evCrime, evBoomExodus, evEpidemic, evFestival, evGridlock];
// =============================================

function runDay(room) {
  let totalPop = 0;
  for (const cell of room.grid.values()) if (cell.type === 'house') totalPop += cell.pop || 0;
  const news = [];
  maybeGrowDistricts(room, totalPop, news);

  const sim = computeSim(room);

  // Агрегаты по районам
  const prosperity = {}, pop = {}, tension = {}, hasClinic = {}, hasPolice = {};
  const provCount = {}, roadCount = {}, types = {}, cx = {}, cy = {}, weight = {};
  for (const d of room.districts) {
    prosperity[d.id] = 0; pop[d.id] = 0; tension[d.id] = 0; hasClinic[d.id] = false; hasPolice[d.id] = false;
    provCount[d.id] = 0; roadCount[d.id] = 0; types[d.id] = new Set(); cx[d.id] = 0; cy[d.id] = 0; weight[d.id] = 0;
  }
  for (const [k, info] of sim.houseInfo) {
    const did = info.district;
    if (did < 0) continue;
    pop[did] += info.pop; prosperity[did] += info.gross;
    if (!info.needs.security) tension[did] += 1;
    const [x, y] = k.split(',').map(Number);
    cx[did] += x * Math.max(1, info.pop); cy[did] += y * Math.max(1, info.pop); weight[did] += Math.max(1, info.pop);
  }
  for (const [k, cnt] of sim.served) { const did = sim.dOf.get(k); if (did >= 0) prosperity[did] += cnt * SERVICE_FEE; }
  for (const [k, cell] of room.grid) {
    const did = sim.dOf.get(k);
    if (did < 0) continue;
    const kind = BUILDINGS[cell.type] && BUILDINGS[cell.type].kind;
    types[did].add(cell.type);
    if (cell.type === 'clinic') hasClinic[did] = true;
    if (cell.type === 'police') hasPolice[did] = true;
    if (cell.type === 'road') roadCount[did] += 1;
    if (kind === 'provider' || kind === 'industry') provCount[did] += 1;
    if (cell.type !== 'house') { const [x, y] = k.split(',').map(Number); cx[did] += x; cy[did] += y; weight[did] += 1; }
  }
  const ctx = { prosperity, pop, tension, hasClinic, hasPolice, provCount, roadCount, types };

  for (const d of room.districts) for (const m of Object.keys(d.mods)) { d.mods[m] -= 1; if (d.mods[m] <= 0) delete d.mods[m]; }

  for (const ev of DAY_EVENTS) ev(room, ctx, news);

  // --- Население и миграция (домохозяйства) ---
  const list = [];
  for (const [k, info] of sim.houseInfo) {
    const cell = room.grid.get(k);
    const afterTax = info.gross * (1 - room.taxes.residential / 100);
    cell.savings = (cell.savings || 0) + Math.max(0, Math.round(afterTax));
    list.push({ cell, info });
  }
  let movers = 0;
  for (const h of list) {                       // отъезды
    if (h.info.happy <= LEAVE_H && h.cell.pop > 0) {
      h.cell.pop -= 1;
      if ((h.cell.savings || 0) >= MOVE_COST) { h.cell.savings -= MOVE_COST; movers += 1; } // переезд внутри города
    }
  }
  // свободные рабочие места после отъездов ограничивают приезд новых
  let curPop = 0, totalJobs = 0;
  for (const cell of room.grid.values()) { if (cell.type === 'house') curPop += cell.pop || 0; totalJobs += jobsOf(cell.type); }
  let immBudget = Math.max(0, totalJobs - curPop);
  // приезжают в самые счастливые дома со свободным местом — пустые в хорошем месте заселяются первыми
  const arrivals = list
    .filter((h) => h.cell.pop < (h.cell.cap || HOUSE_CAP) && h.info.happy >= GROW_H)
    .sort((a, b) => b.info.happy - a.info.happy);
  for (const h of arrivals) {
    if (immBudget <= 0) break;
    const room4 = (h.cell.cap || HOUSE_CAP) - h.cell.pop;
    const speed = h.info.happy >= 60 ? 2 : 1;            // счастливые заселяются быстрее
    const gain = Math.min(immBudget, room4, speed);
    h.cell.pop += gain; immBudget -= gain;
  }
  const sinks = list.filter((h) => h.cell.pop < (h.cell.cap || HOUSE_CAP))
    .sort((a, b) => b.info.happy - a.info.happy);
  for (const s of sinks) {                      // расселяем переехавших в лучшие дома
    while (movers > 0 && s.cell.pop < (s.cell.cap || HOUSE_CAP)) { s.cell.pop += 1; movers -= 1; }
    if (movers <= 0) break;
  }

  // Дрейф границ
  let moved = 0;
  for (const d of room.districts) {
    if (weight[d.id] > 0) {
      const tx = cx[d.id] / weight[d.id], ty = cy[d.id] / weight[d.id];
      const nx = clamp(Math.round(d.seed.x + (tx - d.seed.x) * DRIFT), 0, GRID_SIZE - 1);
      const ny = clamp(Math.round(d.seed.y + (ty - d.seed.y) * DRIFT), 0, GRID_SIZE - 1);
      moved += Math.abs(nx - d.seed.x) + Math.abs(ny - d.seed.y);
      d.seed.x = nx; d.seed.y = ny;
    }
    d.prevPop = pop[d.id];
  }
  if (moved >= 3) news.push({ kind: 'reform', text: 'Передел районов: городские границы поехали вслед за новостройками.' });

  const rank = [...room.districts].sort((a, b) => prosperity[b.id] - prosperity[a.id]);
  const worst = [...room.districts].sort((a, b) => b.crime - a.crime)[0];
  room.day = (room.day || 0) + 1;
  room.paper = {
    day: room.day,
    items: news.length ? news : [{ kind: 'quiet', text: 'Тихий день: горожане пьют кофе и ждут новостей.' }],
    standings: {
      richest: rank[0] ? { name: rank[0].name, value: Math.round(prosperity[rank[0].id]) } : null,
      crime: worst ? { name: worst.name, value: Math.round(worst.crime) } : null,
    },
  };
}

function serializeState(room) {
  const sim = computeSim(room);
  const grid = {};
  for (const [key, cell] of room.grid) {
    const owner = room.players.get(cell.owner);
    const base = { type: cell.type, owner: cell.owner, ownerColor: owner ? owner.color : '#999999' };
    if (cell.type === 'house') {
      const info = sim.houseInfo.get(key);
      if (info) { base.pop = info.pop; base.cap = info.cap; base.level = info.level; base.needs = info.needs; base.happy = info.happy; base.savings = Math.round(cell.savings || 0); }
    } else if (BUILDINGS[cell.type] && BUILDINGS[cell.type].kind === 'provider') {
      base.served = sim.served.get(key) || 0;
    }
    grid[key] = base;
  }
  let population = 0;
  for (const info of sim.houseInfo.values()) population += info.pop;

  return {
    type: 'state', code: room.code, gridSize: GRID_SIZE, hostPid: room.hostPid,
    grid,
    players: [...room.players.values()].map((p) => ({
      pid: p.pid, name: p.name, color: p.color,
      online: !!(p.ws && p.ws.readyState === WebSocket.OPEN),
    })),
    treasury: Math.floor(room.treasury), taxes: room.taxes, deficit: !!room.deficit,
    stock: room.stock || { water: 0, food: 0, wood: 0, stone: 0 }, short: room.short || { water: false, food: false },
    faith: cityFaith(room), center: room.center || null, cityRadius: cityRadius(room),
    flows: { ...sim.flows, ...(room.prodRates || {}) }, population,
    terrain: room.terrain.join(''), reserve: room.reserve || [], tileMax: TILE_RESERVE,
    catalog: BUILDINGS, needs: NEEDS, tierLabels: TIER_LABEL, sprites: spriteMap, houseCap: HOUSE_CAP,
    jobs: JOBS, terrainMeta: TERRAIN, terrainSprites,
    districts: room.districts.map((d) => ({
      id: d.id, name: d.name, color: d.color, seed: d.seed,
      snob: !!d.mods.snob, crime: !!d.mods.crime, epidemic: !!d.mods.epidemic, festival: !!d.mods.festival, gridlock: !!d.mods.gridlock,
    })),
    paper: room.paper || null,
    day: room.day || 0, dayTicks: DAY_TICKS, tickInDay: (room.tick || 0) % DAY_TICKS,
  };
}

function broadcast(room) {
  const payload = JSON.stringify(serializeState(room));
  for (const p of room.players.values()) if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(payload);
}
function send(ws, obj) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.roomCode = null; ws.pid = null;
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { type: 'error', message: 'Кривой запрос' }); }
    handleMessage(ws, msg);
  });
  ws.on('close', () => {
    const room = ws.roomCode && rooms.get(ws.roomCode);
    if (room) { const p = room.players.get(ws.pid); if (p && p.ws === ws) p.ws = null; room.lastActive = Date.now(); broadcast(room); }
  });
});

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'join': return onJoin(ws, msg);
    case 'place': return onPlace(ws, msg);
    case 'bulldoze': return onBulldoze(ws, msg);
    case 'settax': return onSetTax(ws, msg);
    default: return send(ws, { type: 'error', message: 'Неизвестная команда' });
  }
}

function onJoin(ws, msg) {
  spriteMap = scanSprites();
  terrainSprites = scanTerrainSprites();
  const name = (msg.name || '').toString().trim().slice(0, 20) || 'Аноним';
  let code = (msg.code || '').toString().trim();
  let room, isNew = false;
  if (!code) {
    code = genCode();
    const terr = genTerrain();
    room = { code, grid: new Map(), players: new Map(), hostPid: null, lastActive: Date.now(), tick: 0, day: 0, treasury: START_TREASURY, taxes: { ...DEFAULT_TAXES }, deficit: false, districts: [], nextDistrictId: 0, terrain: terr, reserve: initReserve(terr), stock: { water: 0, food: 0, wood: START_WOOD, stone: START_STONE }, short: { water: false, food: false }, prodRates: {} };
    rooms.set(code, room);
    isNew = true;
  } else {
    room = rooms.get(code);
    if (!room) return send(ws, { type: 'error', message: 'Город с таким кодом не найден' });
  }
  let player = msg.pid && room.players.get(msg.pid);
  if (player) { player.ws = ws; if (name) player.name = name; }
  else {
    const pid = genPid();
    player = { pid, name, color: pickColor(room), ws };
    room.players.set(pid, player);
    if (isNew || !room.hostPid) room.hostPid = pid;
  }
  ws.roomCode = code; ws.pid = player.pid; room.lastActive = Date.now();
  send(ws, { type: 'joined', pid: player.pid, code, color: player.color, isHost: room.hostPid === player.pid, gridSize: GRID_SIZE, terrain: room.terrain.join('') });
  broadcast(room);
}

function getRoom(ws) { const room = ws.roomCode && rooms.get(ws.roomCode); return room && room.players.has(ws.pid) ? room : null; }
function inBounds(x, y) { return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < GRID_SIZE && y < GRID_SIZE; }

function onPlace(ws, msg) {
  const room = getRoom(ws); if (!room) return;
  const { x, y, building } = msg;
  const def = BUILDINGS[building];
  if (!def) return send(ws, { type: 'error', message: 'Нет такого здания' });
  if (!inBounds(x, y)) return;
  const key = `${x},${y}`;
  if (room.grid.has(key)) return send(ws, { type: 'error', message: 'Клетка занята' });
  // Центр города ставится первым и единожды; всё остальное — внутри радиуса веры
  if (building === 'center') {
    if (room.center) return send(ws, { type: 'error', message: 'Центр города уже поставлен' });
  } else {
    if (!room.center) return send(ws, { type: 'error', message: 'Сначала поставьте центр города' });
    if (!inCity(room, x, y)) return send(ws, { type: 'error', message: 'За пределами города — не хватает веры' });
  }
  if (!canPlace(room, x, y, building)) return send(ws, { type: 'error', message: 'Здесь нельзя построить это здание' });
  if (!room.stock) room.stock = { water: 0, food: 0, wood: 0, stone: 0 };
  const needWood = def.wood || 0, needStone = def.stone || 0;
  if (room.treasury < def.cost) return send(ws, { type: 'error', message: 'В казне не хватает денег' });
  if ((room.stock.wood || 0) < needWood) return send(ws, { type: 'error', message: 'Не хватает дерева' });
  if ((room.stock.stone || 0) < needStone) return send(ws, { type: 'error', message: 'Не хватает камня' });
  room.treasury -= def.cost;
  room.stock.wood -= needWood; room.stock.stone -= needStone;
  // застройка на лесу вырубает его
  const idx = y * GRID_SIZE + x;
  if (room.terrain[idx] === 'f') { room.terrain[idx] = 'g'; if (room.reserve) room.reserve[idx] = 0; room.terrainDirty = true; }
  const cell = { type: building, owner: ws.pid };
  if (def.kind === 'house') { cell.pop = 0; cell.cap = HOUSE_CAP; cell.savings = 0; }
  if (building === 'center') room.center = { x, y };
  room.grid.set(key, cell);
  room.lastActive = Date.now();
  broadcast(room);
}

function onBulldoze(ws, msg) {  // кооп: снести может любой
  const room = getRoom(ws); if (!room) return;
  const { x, y } = msg;
  if (!inBounds(x, y)) return;
  const key = `${x},${y}`;
  const cell = room.grid.get(key);
  if (!cell) return;
  if (cell.type === 'center') return send(ws, { type: 'error', message: 'Центр города нельзя снести' });
  const def = BUILDINGS[cell.type];
  if (!room.stock) room.stock = { water: 0, food: 0, wood: 0, stone: 0 };
  room.treasury += Math.floor((def ? def.cost : 0) / 2);        // возврат 50% денег и ресурсов
  room.stock.wood = clamp(room.stock.wood + Math.floor((def && def.wood || 0) / 2), 0, STOCK_CAP);
  room.stock.stone = clamp(room.stock.stone + Math.floor((def && def.stone || 0) / 2), 0, STOCK_CAP);
  room.grid.delete(key);
  room.lastActive = Date.now();
  broadcast(room);
}

function onSetTax(ws, msg) {
  const room = getRoom(ws); if (!room) return;
  const kind = msg.kind;
  if (!['residential', 'commercial', 'property'].includes(kind)) return;
  const v = clamp(Math.round(Number(msg.value) || 0), 0, TAX_MAX);
  room.taxes[kind] = v;
  room.lastActive = Date.now();
  broadcast(room);
}

// --- Игровой цикл ---
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const sim = computeSim(room);
    room.treasury += sim.flows.net;
    if (room.treasury < 0) { room.treasury = 0; room.deficit = true; } else room.deficit = false;

    // Склад ресурсов: добыча с истощением тайлов − потребление жителями
    if (!room.stock) room.stock = { water: 0, food: 0, wood: 0, stone: 0 };
    if (!room.short) room.short = { water: false, food: false };
    const prod = extractResources(room);          // мутирует запас тайлов, опустевшие → трава
    const pop = sim.flows.population;
    const waterCons = pop * CONSUME_WATER, foodCons = pop * CONSUME_FOOD;
    const nw = room.stock.water + prod.water - waterCons;
    const nf = room.stock.food + prod.food - foodCons;
    room.short.water = nw < 0; room.short.food = nf < 0;
    room.stock.water = clamp(nw, 0, STOCK_CAP);
    room.stock.food = clamp(nf, 0, STOCK_CAP);
    room.stock.wood = clamp((room.stock.wood || 0) + prod.wood, 0, STOCK_CAP);
    room.stock.stone = clamp((room.stock.stone || 0) + prod.stone, 0, STOCK_CAP);
    room.prodRates = {
      waterProd: Math.round(prod.water), waterCons, foodProd: Math.round(prod.food), foodCons,
      woodProd: Math.round(prod.wood), stoneProd: Math.round(prod.stone),
    };

    room.tick = (room.tick || 0) + 1;
    if (room.tick % DAY_TICKS === 0) runDay(room);

    const anyOnline = [...room.players.values()].some((p) => p.ws && p.ws.readyState === WebSocket.OPEN);
    if (anyOnline) { room.lastActive = now; broadcast(room); }
    else if (now - room.lastActive > ROOM_TTL_MS) rooms.delete(code);
  }
}, TICK_MS);

server.listen(PORT, () => {
  console.log(`Город поднят на http://localhost:${PORT}`);
  console.log(`Поле ${GRID_SIZE}x${GRID_SIZE}, тик ${TICK_MS} мс, день ${DAY_TICKS} тиков, казна ${START_TREASURY}$`);
  const n = Object.keys(spriteMap).length;
  console.log(n ? `Спрайты: ${Object.keys(spriteMap).join(', ')}` : 'Спрайтов нет — эмодзи');
});
