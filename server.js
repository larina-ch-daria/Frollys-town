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
// Уровни зданий 1–3: множители статов и шаги улучшения
const MAX_BUILD_TIER = 3;
const TIER_MULT = [1, 1.6, 2.2];        // множитель добычи/оборота/рабочих мест по уровню
const HOUSE_CAP_STEP = 3;               // +вместимости дома за уровень (5 → 8 → 11)
const UP_COST_MULT = 0.8;               // деньги на улучшение = cost × это × текущий_уровень
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
  road:    { cost: 5,   kind: 'road',     glyph: '🛣', label: 'Дорога',   upkeep: 0, layer: true, allow: ['g', 'f'] },
  house:   { cost: 50,  kind: 'house',    glyph: '🏠', label: 'Дом',      upkeep: 0, wood: 5 },
  well:    { cost: 60,  kind: 'provider', glyph: '💧', label: 'Колодец',  upkeep: 2, wood: 2, stone: 3, range: { shape: 'square', r: 2 }, produces: { res: 'water', model: 'well', from: 'w' } },
  farm:    { cost: 60,  kind: 'provider', glyph: '🌾', label: 'Ферма',    upkeep: 2, wood: 3, allow: ['g'], range: { shape: 'square', r: 2 }, produces: { res: 'food', model: 'farm' } },
  sawmill: { cost: 40,  kind: 'provider', glyph: '🪚', label: 'Лесопилка', upkeep: 2, range: { shape: 'square', r: 3 }, produces: { res: 'wood', model: 'perTile', from: 'f' } },
  quarry:  { cost: 40,  kind: 'provider', glyph: '⛏', label: 'Каменоломня', upkeep: 2, wood: 4, range: { shape: 'square', r: 3 }, produces: { res: 'stone', model: 'perTile', from: 's' } },
  clinic:  { cost: 120, kind: 'provider', glyph: '🏥', label: 'Клиника',  upkeep: 5, wood: 4, stone: 6, range: { shape: 'circle',  r: 4 } },
  police:  { cost: 120, kind: 'provider', glyph: '🚓', label: 'Полиция',  upkeep: 5, wood: 4, stone: 6, range: { shape: 'circle',  r: 4 } },
  park:    { cost: 40,  kind: 'provider', glyph: '🌳', label: 'Парк',     upkeep: 1, wood: 2, range: { shape: 'circle',  r: 3 } },
  cafe:    { cost: 80,  kind: 'provider', glyph: '☕', label: 'Кафе',     upkeep: 3, wood: 4, stone: 2, range: { shape: 'diamond', r: 2 }, commercial: true, emits: [{ label: 'шум', shape: 'diamond', r: 2, happy: -6 }] },
  shop:    { cost: 100, kind: 'provider', glyph: '🏪', label: 'Магазин',  upkeep: 3, wood: 4, stone: 4, range: { shape: 'square',  r: 3 }, commercial: true },
  gym:     { cost: 100, kind: 'provider', glyph: '🏋', label: 'Спортзал', upkeep: 3, wood: 4, stone: 4, range: { shape: 'diamond', r: 3 }, commercial: true, emits: [{ label: 'шум', shape: 'square', r: 1, happy: -5 }] },
  school:  { cost: 150, kind: 'provider', glyph: '🏫', label: 'Школа',    upkeep: 4, wood: 6, stone: 6, range: { shape: 'square',  r: 3 } },
  theater: { cost: 150, kind: 'provider', glyph: '🎭', label: 'Театр',    upkeep: 5, wood: 6, stone: 8, range: { shape: 'circle',  r: 4 }, commercial: true, emits: [{ label: 'шум', shape: 'circle', r: 2, happy: -10 }] },
  factory: { cost: 140, kind: 'industry', glyph: '🏭', label: 'Завод',    upkeep: 4, wood: 4, stone: 10, output: 12, emits: [{ label: 'шум', shape: 'circle', r: 3, happy: -8 }] },
  church:  { cost: 130, kind: 'faith',    glyph: '⛪', label: 'Церковь',  upkeep: 4, wood: 4, stone: 8, range: { shape: 'circle', r: 3 } },
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
// Добыча — целые числа, по спецификации плейтеста
const FARM_BASE = 5, FARM_PER_GRASS = 1, FARM_R = 2;   // ферма: +5 база, +1 за пустой тайл травы, квадрат r2 (+1/уровень)
const WELL_BASE = [5, 10, 15], WELL_PER = [1, 2, 3], WELL_R = [2, 3, 4]; // колодец по уровню: база / за тайл воды / радиус
const WOOD_PER_FOREST = 1;       // дерево лесопилки = × тайлов леса в радиусе (истощаемо)
const STONE_PER_ROCK = 1;        // камень каменоломни = × тайлов камня в радиусе (истощаемо)
const CONSUME_WATER = 1;         // потребление воды на жителя за тик
const CONSUME_FOOD = 1;          // потребление еды на жителя за тик
const STOCK_CAP = 999;           // потолок склада
const TILE_RESERVE = {                              // запас ресурса на тайле по типу ландшафта
  f: parseInt(process.env.TILE_RESERVE_FOREST || '100', 10),
  s: parseInt(process.env.TILE_RESERVE_STONE || '100', 10),
  w: parseInt(process.env.TILE_RESERVE_WATER || '1500', 10),
};
const RES_RATE = { wood: WOOD_PER_FOREST, stone: STONE_PER_ROCK };
const START_WOOD = parseInt(process.env.START_WOOD || '30', 10);   // стартовый запас дерева
const START_STONE = parseInt(process.env.START_STONE || '20', 10); // стартовый запас камня
const FAITH_PER_POP = 2;         // вера = население × коэффициент
const NO_ROAD_PENALTY = 25;      // штраф к счастью дома без дороги рядом
const FAITH_BASE_RADIUS = parseInt(process.env.FAITH_BASE_RADIUS || '3', 10);   // радиус застройки от центра на старте
const FAITH_RADIUS_COEF = parseFloat(process.env.FAITH_RADIUS_COEF || '0.15');  // прибавка радиуса за единицу веры
// Образование, знания и вера
const EDU_DAYS = 3;                 // дней в зоне школы до полной образованности дома
const EDU_DECAY = 0.34;             // спад образованности за день без школы
const EDU_THRESHOLD = 0.6;          // с какой доли дом считается образованным (право на апгрейд)
const SCHOOL_CAP = 20;              // сколько жителей учит школа на 1 уровне
const SCHOOL_CAP_STEP = 10;         // +вместимости школы за уровень (20 → 30 → 40)
const BASIC_COMFORT = 12;           // бонус к счастью, когда закрыты вода+еда (чтобы дом заселялся без клиники/полиции)
const KNOWLEDGE_FAITH_COST = 1.5;   // сколько веры съедает один образованный житель
const CHURCH_CAP = 15;              // сколько жителей окормляет церковь (× уровень)
const CHURCH_FAITH_PER = 1;         // вера за окормлённого церковью жителя (снижено после плейтеста)
const PROD_EDU_SHARE = 0.4;         // доля образованных в районе для апгрейда производств

// Рабочие места по типам зданий (жители едут только на свободные)
const JOBS = { factory: 8, shop: 3, cafe: 3, gym: 3, theater: 3, clinic: 4, police: 4, school: 4, church: 3, well: 1, farm: 1, sawmill: 2, quarry: 2, park: 0, road: 0, house: 0 };
function jobsOf(type) { return JOBS[type] || 0; }
function tierOf(cell) { return Math.max(1, Math.min(MAX_BUILD_TIER, (cell && cell.tier) || 1)); }
function tierMult(cell) { return TIER_MULT[tierOf(cell) - 1]; }
function houseCapForTier(tier) { return HOUSE_CAP + (Math.max(1, tier) - 1) * HOUSE_CAP_STEP; }
function isUpgradable(type) { const d = BUILDINGS[type]; return !!(d && type !== 'center' && !d.layer); }
function upgradeCost(def, tier) { return { money: Math.round(def.cost * UP_COST_MULT * tier), wood: def.wood || 0, stone: def.stone || 0 }; }
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
// Районные шкалы (непрерывные метры 0–100)
const ECO_BASE = 50, ECO_PARK = 6, ECO_FOREST = 1, ECO_FACTORY = -20, ECO_HAPPY = 8; // экология: парки/лес +, заводы −; ±ECO_HAPPY к счастью
const CRIME_HAPPY = 12;                        // максимальный штраф к счастью от преступности района
const EPIDEMIC_CLINIC_BONUS = 6;               // на сколько клиника поднимает порог населения для эпидемии
// (шум — радиусная механика: зоны emits у кафе/спортзала/театра/завода, не районный метр)
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
function cityPop(room) { let p = 0; for (const c of room.grid.values()) if (c.type === 'house') p += c.pop || 0; return p; }
function cityKnowledge(room) { let k = 0; for (const c of room.grid.values()) if (c.type === 'house') k += Math.round((c.edu || 0) * (c.pop || 0)); return k; }
function churchFaith(room) { // церкви окормляют жителей в зоне (до вместимости × уровень) → вера
  let f = 0;
  for (const [k, c] of room.grid) {
    if (c.type !== 'church') continue;
    const [cx, cy] = k.split(',').map(Number);
    if (!roadNeighbor(room, cx, cy)) continue; // без дороги не работает
    const def = BUILDINGS.church, r = def.range.r + (tierOf(c) - 1);
    let served = 0; const capLeft = CHURCH_CAP * tierOf(c);
    for (const [hk, hc] of room.grid) {
      if (hc.type !== 'house' || !hc.pop) continue;
      const [hx, hy] = hk.split(',').map(Number);
      if (!covers(def.range.shape, hx - cx, hy - cy, r)) continue;
      served += hc.pop;
    }
    f += Math.min(served, capLeft) * CHURCH_FAITH_PER;
  }
  return f;
}
function districtEduShare(room, x, y) {   // доля образованных жителей в районе (или во всём городе, если районов нет)
  const did = districtOf(room, x, y);
  let pop = 0, epop = 0;
  for (const [hk, hc] of room.grid) {
    if (hc.type !== 'house' || !hc.pop) continue;
    const [hx, hy] = hk.split(',').map(Number);
    if (room.districts.length && districtOf(room, hx, hy) !== did) continue;
    pop += hc.pop; epop += Math.round((hc.edu || 0) * hc.pop);
  }
  return pop > 0 ? epop / pop : 0;
}
function cityFaith(room) {
  const base = cityPop(room) * FAITH_PER_POP + churchFaith(room) - cityKnowledge(room) * KNOWLEDGE_FAITH_COST;
  return Math.max(0, base); // пол веры: базовый радиус неприкосновенен
}
const FAITH_SOFT_RADIUS = 5;        // сверх этого радиуса каждая клетка стоит втрое больше веры
function cityRadius(room) {
  const bonus = cityFaith(room) * FAITH_RADIUS_COEF;
  const cheap = Math.max(0, FAITH_SOFT_RADIUS - FAITH_BASE_RADIUS);
  const extra = bonus <= cheap ? bonus : cheap + (bonus - cheap) / 3; // за мягким пределом — втрое дороже
  return FAITH_BASE_RADIUS + Math.floor(extra);
}
function inCity(room, x, y) { if (!room.center) return false; const dx = x - room.center.x, dy = y - room.center.y, R = cityRadius(room); return dx * dx + dy * dy <= R * R + R; }
// Дороги — слой поверх тайлов (room.roads: 0/1). Здание работает, только если рядом (по стороне) есть дорога.
function roadAt(room, x, y) { return !!(room.roads && x >= 0 && y >= 0 && x < GRID_SIZE && y < GRID_SIZE && room.roads[y * GRID_SIZE + x]); }
function roadNeighbor(room, x, y) { return neighbors(x, y).some(([nx, ny]) => roadAt(room, nx, ny)); }
function isActive(room, x, y, type) { return type === 'center' || roadNeighbor(room, x, y); }
// Запас ресурса на тайле (лес/камень/вода истощаются; трава/земля — нет)
const DEPLETABLE = new Set(['f', 's', 'w']);
function initReserve(terrain) {
  const rv = new Array(terrain.length).fill(0);
  for (let i = 0; i < terrain.length; i++) if (DEPLETABLE.has(terrain[i])) rv[i] = TILE_RESERVE[terrain[i]] || 100;
  return rv;
}
// Добыча с истощением (вызывается в тик-цикле, мутирует room.terrain/room.reserve)
function extractResources(room) {
  const n = GRID_SIZE, out = { water: 0, food: 0, wood: 0, stone: 0 };
  const depleted = [];
  for (const [k, cell] of room.grid) {
    const def = BUILDINGS[cell.type]; if (!def || !def.produces) continue;
    const pr = def.produces, [px, py] = k.split(',').map(Number);
    if (!roadNeighbor(room, px, py)) continue; // нет дороги — не работает
    const tier = tierOf(cell);

    if (pr.model === 'farm') { // +5 база и +1 за каждый ПУСТОЙ тайл травы (внутри радиуса города); квадрат r2 (+1/уровень)
      const r = FARM_R + (tier - 1);
      let empty = 0;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const gx = px + dx, gy = py + dy; if (gx < 0 || gy < 0 || gx >= n || gy >= n) continue;
        if (!inCity(room, gx, gy)) continue;                                  // только внутри радиуса города
        if (room.terrain[gy * n + gx] !== 'g') continue;
        if (room.grid.has(`${gx},${gy}`) || roadAt(room, gx, gy)) continue;   // здание/дорога — занятой тайл, не трава
        empty += 1;
      }
      out.food += FARM_BASE + empty * FARM_PER_GRASS;
      continue;
    }

    if (pr.model === 'well') { // база по уровню + N за каждый тайл воды в радиусе (внутри города, истощаемо)
      const r = WELL_R[tier - 1], per = WELL_PER[tier - 1];
      let got = WELL_BASE[tier - 1];
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const gx = px + dx, gy = py + dy; if (gx < 0 || gy < 0 || gx >= n || gy >= n) continue;
        if (!inCity(room, gx, gy)) continue;
        const idx = gy * n + gx;
        if (room.terrain[idx] !== 'w' || room.reserve[idx] <= 0) continue;
        const take = Math.min(room.reserve[idx], per);
        room.reserve[idx] -= take; got += take;
        if (room.reserve[idx] <= 0) depleted.push(idx);
      }
      out.water += got;
      continue;
    }

    // perTile: лес/камень — по 1×уровень за тайл (внутри города, истощаемо); квадрат r (+1/уровень)
    const r = def.range.r + (tier - 1), per = (RES_RATE[pr.res] || 1) * tier;
    let got = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const gx = px + dx, gy = py + dy; if (gx < 0 || gy < 0 || gx >= n || gy >= n) continue;
      if (!inCity(room, gx, gy)) continue;
      const idx = gy * n + gx;
      if (room.terrain[idx] !== pr.from || room.reserve[idx] <= 0) continue;
      const take = Math.min(room.reserve[idx], per);
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

  const modOf = new Map();
  for (const d of room.districts) modOf.set(d.id, d.mods);
  const mHas = (did, id) => { const m = modOf.get(did); return !!(m && m[id]); };

  const roadSet = new Set();
  if (room.roads) for (let i = 0; i < room.roads.length; i++) if (room.roads[i]) roadSet.add(`${i % GRID_SIZE},${Math.floor(i / GRID_SIZE)}`);
  const providers = cells
    .filter((c) => BUILDINGS[c.type] && BUILDINGS[c.type].kind === 'provider' && roadNeighbor(room, c.x, c.y))
    .map((c) => {
      const rng = BUILDINGS[c.type].range;
      const nearRoad = neighbors(c.x, c.y).some(([nx, ny]) => roadSet.has(`${nx},${ny}`));
      let r = rng.r + (nearRoad ? 1 : 0) + (tierOf(c) - 1);
      for (const ev of EVENTS) if (ev.radiusDelta && mHas(dOf.get(c.k), ev.id)) r = Math.max(1, r + ev.radiusDelta);
      return { ...c, shape: rng.shape, r };
    });
  const houses = cells.filter((c) => c.type === 'house');
  // Рынок труда: рабочие места дают только здания, подключённые к дороге
  let totalPop = 0, totalJobs = 0;
  for (const c of cells) { if (c.type === 'house') totalPop += c.pop || 0; if (isActive(room, c.x, c.y, c.type)) totalJobs += Math.round(jobsOf(c.type) * tierMult(c)); }
  const empFraction = totalPop > 0 ? Math.min(1, totalJobs / totalPop) : 1;
  const unempPenalty = Math.round((1 - empFraction) * UNEMP_PENALTY_MAX);

  // Дефицит воды/еды берём из состояния (склад считается в тик-цикле)
  const waterShort = !!(room.short && room.short.water), foodShort = !!(room.short && room.short.food);

  // Вредные зоны (шум, загрязнение)
  const nuisances = [];
  for (const c of cells) {
    if (!isActive(room, c.x, c.y, c.type)) continue; // отключённое здание не работает и не вредит
    const em = BUILDINGS[c.type] && BUILDINGS[c.type].emits;
    if (em) for (const e of em) nuisances.push({ x: c.x, y: c.y, ...e });
  }

  const houseInfo = new Map();
  const served = new Map();
  const taxes = room.taxes;

  // Районные шкалы: экология, шум, преступность (здоровье — после подсчёта населения)
  const dstats = {};
  for (const d of room.districts) dstats[d.id] = { eco: ECO_BASE, clinics: 0, pop: 0, crime: 0, health: 0 };
  for (const c of cells) {
    const did = dOf.get(c.k); if (did < 0 || !dstats[did] || !isActive(room, c.x, c.y, c.type)) continue;
    if (c.type === 'park') dstats[did].eco += ECO_PARK;
    if (c.type === 'factory') dstats[did].eco += ECO_FACTORY;
    if (c.type === 'clinic') dstats[did].clinics += 1;
  }
  if (room.districts.length) for (let y = 0; y < GRID_SIZE; y++) for (let x = 0; x < GRID_SIZE; x++) {
    if (terrainAt(room, x, y) !== 'f') continue;
    const did = districtOf(room, x, y); if (dstats[did]) dstats[did].eco += ECO_FOREST;
  }
  const ambient = {};
  for (const d of room.districts) {
    const s = dstats[d.id];
    s.eco = clamp(s.eco, 0, 100);
    s.crime = clamp(Math.round((d.crime / CRIME_THRESHOLD) * 100), 0, 100);
    ambient[d.id] = (s.eco - ECO_BASE) / 50 * ECO_HAPPY - (s.crime / 100) * CRIME_HAPPY;
  }

  const eduServed = schoolCoverage(room); // дома под вместимостью школ (для «Развития» и образования)
  for (const h of houses) {
    const hDist = dOf.get(h.k);
    const inRangeTypes = new Set();
    for (const p of providers) {
      if (!covers(p.shape, h.x - p.x, h.y - p.y, p.r)) continue;
      const pDist = dOf.get(p.k);
      let blocked = false;
      for (const ev of EVENTS) if (ev.blockSocialCross && SOCIAL_PROVIDERS.has(p.type) && mHas(pDist, ev.id) && pDist !== hDist) { blocked = true; break; }
      if (blocked) continue;
      inRangeTypes.add(p.type);
      served.set(p.k, (served.get(p.k) || 0) + 1);
    }
    const needs = {};
    for (const need of NEEDS) needs[need.key] = need.providers.some((t) => inRangeTypes.has(t));
    needs.water = !waterShort;   // покрытие воды/еды — от общего склада, не от радиуса
    needs.food = !foodShort;
    // #15: школа закрывает «Развитие» только в пределах своей вместимости (театр — без лимита)
    if (needs.growth && !inRangeTypes.has('theater') && inRangeTypes.has('school') && !eduServed.has(h.k)) needs.growth = false;
    for (const ev of EVENTS) if (ev.houseNeed && mHas(hDist, ev.id)) ev.houseNeed(needs);

    // Вредные воздействия: гасят показатель и/или счастье
    let extra = -unempPenalty;
    if (needs.water && needs.food) extra += BASIC_COMFORT; // #4: базовый комфорт → дом заселяется без клиники/полиции
    extra += ambient[hDist] || 0; // фон района: экология/шум/преступность
    const hActive = roadNeighbor(room, h.x, h.y);
    if (!hActive) extra -= NO_ROAD_PENALTY; // нет дороги рядом — дом отрезан
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
    for (const ev of EVENTS) if (ev.zeroLevel && mHas(hDist, ev.id)) level = 0;

    const pop = h.pop || 0;
    const cap = h.cap || HOUSE_CAP;
    const happy = happiness(level, pop, cap, taxes, mHas(hDist, 'crime'), mHas(hDist, 'epidemic'), room.deficit, extra);
    const gross = pop * (1 + level) * 2; // налогооблагаемая ценность домохозяйства
    houseInfo.set(h.k, { level, needs, pop, cap, district: hDist, happy, gross, active: hActive });
  }

  // Здоровье района: нагрузка населения против порога (клиника поднимает порог)
  for (const [, info] of houseInfo) if (dstats[info.district]) dstats[info.district].pop += info.pop;
  for (const d of room.districts) {
    const s = dstats[d.id];
    const threshold = EPIDEMIC_POP + s.clinics * EPIDEMIC_CLINIC_BONUS;
    s.health = clamp(Math.round((s.pop / threshold) * 100), 0, 100);
  }

  // Налоги и содержание
  let residential = 0, commercial = 0, property = 0, upkeep = 0;
  for (const info of houseInfo.values()) residential += info.gross * empFraction * (taxes.residential / 100);
  let commBase = 0;
  for (const p of providers) if (BUILDINGS[p.type].commercial) commBase += (served.get(p.k) || 0) * SERVICE_FEE * tierMult(p);
  for (const c of cells) if (BUILDINGS[c.type] && BUILDINGS[c.type].output && isActive(room, c.x, c.y, c.type)) commBase += BUILDINGS[c.type].output * tierMult(c);
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
  return { houseInfo, served, dOf, flows, districtStats: dstats };
}

// ================== СОБЫТИЯ ==================
// Каждое событие описано ОДНИМ объектом:
//   id     — имя модификатора (ставится как d.mods[id] = MOD_DAYS)
//   icon   — значок в газете и на подписи района
//   run    — когда срабатывает: читает ctx/район, ставит статус, пишет в news
//   эффект — декларативные хуки, которые сам применяет computeSim:
//     houseNeed(needs)     — меняет потребности дома в поражённом районе
//     zeroLevel: true      — обнуляет уровень дома
//     radiusDelta: n       — сдвигает радиус провайдеров района
//     blockSocialCross:true — соцздания не обслуживают чужие районы (зазнайство)
// Чтобы добавить событие — допиши сюда объект. Новые АГРЕГАТЫ (ctx.*) считаются в runDay.
const EVENTS = [
  {
    id: 'snob', icon: '💅', blockSocialCross: true,
    run(room, ctx, news) {
      if (room.districts.length < 2) return;
      const sorted = [...room.districts].sort((a, b) => ctx.prosperity[b.id] - ctx.prosperity[a.id]);
      const rich = sorted[0];
      const second = ctx.prosperity[sorted[1] ? sorted[1].id : rich.id] || 1;
      if (ctx.prosperity[rich.id] >= SNOB_MIN && ctx.prosperity[rich.id] >= SNOB_RATIO * second) {
        if (!rich.mods.snob) news.push({ kind: 'snob', text: `«${rich.name}» зазнался: богатейший район больше не пускает чужаков в свои магазины, кафе и парки.` });
        rich.mods.snob = MOD_DAYS;
      }
    },
  },
  {
    id: 'crime', icon: '🚨', houseNeed(needs) { needs.security = false; },
    run(room, ctx, news) {
      for (const d of room.districts) {
        d.crime = Math.max(0, d.crime + ctx.tension[d.id] - (ctx.hasPolice[d.id] ? 3 : 0) - 1);
        if (d.crime >= CRIME_THRESHOLD && !d.mods.crime) {
          d.mods.crime = MOD_DAYS; d.crime = Math.max(0, d.crime - 4);
          d.seed.x = clamp(d.seed.x + crypto.randomInt(-2, 3), 0, GRID_SIZE - 1);
          d.seed.y = clamp(d.seed.y + crypto.randomInt(-2, 3), 0, GRID_SIZE - 1);
          news.push({ kind: 'crime', text: `Криминальная волна в «${d.name}»: банды хозяйничают на улицах${!ctx.hasClinic[d.id] ? ', а больницы поблизости нет — раненых некому лечить' : ''}. Безопасность падает.` });
        }
      }
    },
  },
  {
    id: 'boom', // без модификатора: только новость о приросте/оттоке
    run(room, ctx, news) {
      for (const d of room.districts) {
        const delta = ctx.pop[d.id] - d.prevPop;
        if (delta >= 3) news.push({ kind: 'boom', text: `Бум в «${d.name}»: за день прибавилось ${delta} жителей, район на подъёме.` });
        else if (delta <= -3) news.push({ kind: 'exodus', text: `Люди бегут из «${d.name}»: район опустел на ${-delta} жителей.` });
      }
    },
  },
  {
    id: 'epidemic', icon: '🦠', zeroLevel: true,
    run(room, ctx, news) {
      for (const d of room.districts) {
        const s = ctx.stats[d.id];
        const threshold = EPIDEMIC_POP + (s ? s.clinics : 0) * EPIDEMIC_CLINIC_BONUS;
        if ((ctx.pop[d.id] || 0) < threshold || d.mods.epidemic) continue;
        let chance = (s && s.clinics) ? EPIDEMIC_CHANCE_CLINIC : EPIDEMIC_CHANCE;
        if (s) chance = Math.round(chance * (1 + (ECO_BASE - s.eco) / 100)); // грязный район болеет чаще, зелёный — реже
        if (crypto.randomInt(0, 100) < chance) {
          d.mods.epidemic = MOD_DAYS;
          news.push({ kind: 'epidemic', text: `Эпидемия в «${d.name}»: ${!(s && s.clinics) ? 'переполненный район без единой больницы слёг' : 'больницы не справляются с наплывом больных'}, жизнь замерла.` });
        }
      }
    },
  },
  {
    id: 'festival', icon: '🎉', houseNeed(needs) { needs.community = true; },
    run(room, ctx, news) {
      for (const d of room.districts) {
        const t = ctx.types[d.id];
        const cultural = t.has('theater') && (t.has('park') || t.has('cafe'));
        if (cultural && ctx.pop[d.id] >= 3 && !d.mods.festival && crypto.randomInt(0, 100) < FESTIVAL_CHANCE) {
          d.mods.festival = MOD_DAYS;
          news.push({ kind: 'festival', text: `Фестиваль в «${d.name}»: район гуляет, соседи тянутся на праздник — жителям хорошо и без лишних кафе.` });
        }
      }
    },
  },
  {
    id: 'gridlock', icon: '🚧', radiusDelta: -1,
    run(room, ctx, news) {
      for (const d of room.districts) {
        if (ctx.provCount[d.id] >= GRIDLOCK_PROVIDERS && ctx.roadCount[d.id] === 0 && !d.mods.gridlock) {
          d.mods.gridlock = MOD_DAYS;
          news.push({ kind: 'gridlock', text: `Пробки в «${d.name}»: застроились, а дорог не проложили — сервисы не дотягиваются до окраин.` });
        }
      }
    },
  },
];
const MOD_ICONS = Object.fromEntries(EVENTS.filter((e) => e.icon).map((e) => [e.id, e.icon]));
function hasMod(room, did, id) { const d = room.districts.find((x) => x.id === did); return !!(d && d.mods[id]); }
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
  const ctx = { prosperity, pop, tension, hasClinic, hasPolice, provCount, roadCount, types, stats: sim.districtStats || {} };

  for (const d of room.districts) for (const m of Object.keys(d.mods)) { d.mods[m] -= 1; if (d.mods[m] <= 0) delete d.mods[m]; }

  for (const ev of EVENTS) ev.run(room, ctx, news);

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
    .filter((h) => h.cell.pop < (h.cell.cap || HOUSE_CAP) && h.info.happy >= GROW_H && h.info.active)
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
  updateEducation(room);
  for (const [k, c] of room.grid) { // #5: дом вне радиуса влияния >2 дней — жители уезжают
    if (c.type !== 'house') continue;
    const [x, y] = k.split(',').map(Number);
    if (!inCity(room, x, y)) { c.outDays = (c.outDays || 0) + 1; if (c.outDays > 2 && (c.pop || 0) > 0) { c.pop = 0; c.edu = 0; } }
    else c.outDays = 0;
  }
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

function schoolCapacity(cell) { return SCHOOL_CAP + (tierOf(cell) - 1) * SCHOOL_CAP_STEP; }
function schoolCoverage(room) { // дома, реально попадающие под вместимость школ (крупные первыми)
  const def = BUILDINGS.school, served = new Set();
  for (const [k, c] of room.grid) {
    if (c.type !== 'school') continue;
    const [sx, sy] = k.split(',').map(Number);
    if (!roadNeighbor(room, sx, sy)) continue;
    const r = def.range.r + (tierOf(c) - 1);
    let cap = schoolCapacity(c);
    const inZone = [];
    for (const [hk, hc] of room.grid) {
      if (hc.type !== 'house' || !hc.pop) continue;
      const [hx, hy] = hk.split(',').map(Number);
      if (covers(def.range.shape, hx - sx, hy - sy, r)) inZone.push({ hk, pop: hc.pop });
    }
    inZone.sort((a, b) => b.pop - a.pop);
    for (const h of inZone) { if (cap <= 0) break; served.add(h.hk); cap -= h.pop; }
  }
  return served;
}
function updateEducation(room) {
  const served = schoolCoverage(room);
  for (const [hk, hc] of room.grid) {
    if (hc.type !== 'house') continue;
    if (served.has(hk)) hc.edu = Math.min(1, (hc.edu || 0) + 1 / EDU_DAYS);
    else hc.edu = Math.max(0, (hc.edu || 0) - EDU_DECAY);
  }
}

function serializeState(room) {
  const sim = computeSim(room);
  const grid = {};
  for (const [key, cell] of room.grid) {
    const owner = room.players.get(cell.owner);
    const [cx, cy] = key.split(',').map(Number);
    const base = { type: cell.type, owner: cell.owner, ownerColor: owner ? owner.color : '#999999', tier: tierOf(cell) };
    base.active = isActive(room, cx, cy, cell.type);
    if (cell.type === 'house') {
      const info = sim.houseInfo.get(key);
      if (info) { base.pop = info.pop; base.cap = info.cap; base.level = info.level; base.needs = info.needs; base.happy = info.happy; base.savings = Math.round(cell.savings || 0); base.edu = Math.round((cell.edu || 0) * 100); }
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
    faith: cityFaith(room), knowledge: cityKnowledge(room), center: room.center || null, cityRadius: cityRadius(room),
    flows: { ...sim.flows, ...(room.prodRates || {}) }, population,
    terrain: room.terrain.join(''), reserve: room.reserve || [], tileMax: TILE_RESERVE, roads: room.roads || [],
    catalog: BUILDINGS, needs: NEEDS, tierLabels: TIER_LABEL, sprites: spriteMap, houseCap: HOUSE_CAP,
    jobs: JOBS, terrainMeta: TERRAIN, terrainSprites,
    buildMeta: { maxTier: MAX_BUILD_TIER, upCostMult: UP_COST_MULT, schoolCap: SCHOOL_CAP, schoolCapStep: SCHOOL_CAP_STEP, schoolBaseR: BUILDINGS.school.range.r, eduThreshold: Math.round(EDU_THRESHOLD * 100) },
    districts: room.districts.map((d) => ({
      id: d.id, name: d.name, color: d.color, seed: d.seed,
      mods: Object.keys(d.mods), // активные модификаторы (иконки берутся из modIcons)
      stats: (sim.districtStats && sim.districtStats[d.id]) ? {
        eco: sim.districtStats[d.id].eco,
        crime: sim.districtStats[d.id].crime, health: sim.districtStats[d.id].health,
      } : null,
    })),
    modIcons: MOD_ICONS,
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
    case 'upgrade': return onUpgrade(ws, msg);
    case 'settax': return onSetTax(ws, msg);
    case 'cursor': return onCursor(ws, msg);
    case 'rename': return onRename(ws, msg);
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
    room = { code, grid: new Map(), players: new Map(), hostPid: null, lastActive: Date.now(), tick: 0, day: 0, treasury: START_TREASURY, taxes: { ...DEFAULT_TAXES }, deficit: false, districts: [], nextDistrictId: 0, terrain: terr, reserve: initReserve(terr), roads: new Array(GRID_SIZE * GRID_SIZE).fill(0), stock: { water: 0, food: 0, wood: START_WOOD, stone: START_STONE }, short: { water: false, food: false }, prodRates: {} };
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
  const idx = y * GRID_SIZE + x;
  // Дорога — это слой, а не здание в сетке
  if (def.layer) {
    if (!room.center) return send(ws, { type: 'error', message: 'Сначала поставьте центр города' });
    if (!inCity(room, x, y)) return send(ws, { type: 'error', message: 'За пределами города — не хватает веры' });
    if (!canPlace(room, x, y, building)) return send(ws, { type: 'error', message: 'Здесь нельзя проложить дорогу' });
    if (!room.roads) room.roads = new Array(GRID_SIZE * GRID_SIZE).fill(0);
    if (room.roads[idx]) return send(ws, { type: 'error', message: 'Тут уже дорога' });
    if (room.treasury < def.cost) return send(ws, { type: 'error', message: 'В казне не хватает денег' });
    room.treasury -= def.cost;
    if (room.terrain[idx] === 'f') { room.terrain[idx] = 'g'; if (room.reserve) room.reserve[idx] = 0; }
    room.roads[idx] = 1;
    room.lastActive = Date.now();
    return broadcast(room);
  }
  // Центр города ставится первым и единожды; всё остальное — внутри радиуса веры
  if (building === 'center') {
    if (room.center) return send(ws, { type: 'error', message: 'Центр города уже поставлен' });
  } else {
    if (!room.center) return send(ws, { type: 'error', message: 'Сначала поставьте центр города' });
    if (!inCity(room, x, y)) return send(ws, { type: 'error', message: 'За пределами города — не хватает веры' });
  }
  if (room.roads && room.roads[idx]) return send(ws, { type: 'error', message: 'Здесь дорога — сначала снесите её' });
  if (!canPlace(room, x, y, building)) return send(ws, { type: 'error', message: 'Здесь нельзя построить это здание' });
  if (!room.stock) room.stock = { water: 0, food: 0, wood: 0, stone: 0 };
  const needWood = def.wood || 0, needStone = def.stone || 0;
  if (room.treasury < def.cost) return send(ws, { type: 'error', message: 'В казне не хватает денег' });
  if ((room.stock.wood || 0) < needWood) return send(ws, { type: 'error', message: 'Не хватает дерева' });
  if ((room.stock.stone || 0) < needStone) return send(ws, { type: 'error', message: 'Не хватает камня' });
  room.treasury -= def.cost;
  room.stock.wood -= needWood; room.stock.stone -= needStone;
  // застройка на лесу вырубает его
  if (room.terrain[idx] === 'f') { room.terrain[idx] = 'g'; if (room.reserve) room.reserve[idx] = 0; room.terrainDirty = true; }
  const cell = { type: building, owner: ws.pid, tier: 1 };
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
  if (!cell) {
    // здания нет — может, тут дорога
    const idx = y * GRID_SIZE + x;
    if (room.roads && room.roads[idx]) { room.roads[idx] = 0; room.treasury += 2; room.lastActive = Date.now(); return broadcast(room); }
    return;
  }
  if (cell.type === 'center') return send(ws, { type: 'error', message: 'Центр города нельзя снести' });
  if (cell.type === 'house' && !inCity(room, x, y)) return send(ws, { type: 'error', message: 'Дом вне радиуса влияния — сначала верните веру' });
  const def = BUILDINGS[cell.type];
  if (!room.stock) room.stock = { water: 0, food: 0, wood: 0, stone: 0 };
  room.treasury += Math.floor((def ? def.cost : 0) / 2);        // возврат 50% денег и ресурсов
  room.stock.wood = clamp(room.stock.wood + Math.floor((def && def.wood || 0) / 2), 0, STOCK_CAP);
  room.stock.stone = clamp(room.stock.stone + Math.floor((def && def.stone || 0) / 2), 0, STOCK_CAP);
  room.grid.delete(key);
  room.lastActive = Date.now();
  broadcast(room);
}

function onUpgrade(ws, msg) {  // кооп: улучшить может любой
  const room = getRoom(ws); if (!room) return;
  const { x, y } = msg;
  if (!inBounds(x, y)) return;
  const cell = room.grid.get(`${x},${y}`);
  if (!cell) return;
  if (!isUpgradable(cell.type)) return send(ws, { type: 'error', message: 'Это здание не улучшается' });
  const tier = tierOf(cell);
  if (tier >= MAX_BUILD_TIER) return send(ws, { type: 'error', message: 'Уже максимальный уровень' });
  if (!inCity(room, x, y)) return send(ws, { type: 'error', message: 'Здание вне радиуса влияния — сначала верните веру' });
  const def = BUILDINGS[cell.type];
  // Образование как условие апгрейда: дома — свои жители, производства — район
  if (def.kind === 'house' && (cell.edu || 0) < EDU_THRESHOLD)
    return send(ws, { type: 'error', message: 'Дом не улучшить: жители недостаточно образованы (нужна школа рядом)' });
  if (def.produces && districtEduShare(room, x, y) < PROD_EDU_SHARE)
    return send(ws, { type: 'error', message: 'Производство не улучшить: в районе мало образованных работников' });
  const c = upgradeCost(def, tier);
  if (room.treasury < c.money) return send(ws, { type: 'error', message: 'В казне не хватает денег' });
  if ((room.stock.wood || 0) < c.wood) return send(ws, { type: 'error', message: 'Не хватает дерева' });
  if ((room.stock.stone || 0) < c.stone) return send(ws, { type: 'error', message: 'Не хватает камня' });
  room.treasury -= c.money; room.stock.wood -= c.wood; room.stock.stone -= c.stone;
  cell.tier = tier + 1;
  if (def.kind === 'house') cell.cap = houseCapForTier(cell.tier); // больше жильцов
  room.lastActive = Date.now();
  broadcast(room);
}

function onCursor(ws, msg) {   // релей курсора другим игрокам (без полного стейта)
  const room = getRoom(ws); if (!room) return;
  const p = room.players.get(ws.pid); if (!p) return;
  const payload = JSON.stringify({ type: 'cursor', pid: ws.pid, x: msg.x, y: msg.y, color: p.color });
  for (const other of room.players.values()) if (other.ws && other.ws !== ws && other.ws.readyState === WebSocket.OPEN) other.ws.send(payload);
}
function onRename(ws, msg) {   // переименование района
  const room = getRoom(ws); if (!room) return;
  const d = room.districts.find((x) => x.id === msg.id); if (!d) return;
  const name = String(msg.name || '').trim().slice(0, 24);
  if (name) { d.name = name; room.lastActive = Date.now(); broadcast(room); }
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
    room.treasury = Math.floor(room.treasury + sim.flows.net);
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
