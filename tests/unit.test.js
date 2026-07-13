'use strict';
/*
 * ЮНИТ-ТЕСТЫ ЯДРА СИМУЛЯЦИИ  (node --test)
 * ─────────────────────────────────────────────────────────────────────────
 * Что покрываем: чистую, детерминированную логику сервера — ту, что не зависит
 * от сети, канваса и таймеров. Это ~80% правил игры.
 *
 * Почему это вообще тестируемо: server.js устроен так, что computeSim,
 * extractResources и события — чистые функции от объекта `room`. Мы строим
 * искусственную комнату руками, вызываем функцию и проверяем результат.
 * require('../server.js') НЕ поднимает сервер и не запускает тик (автозапуск
 * спрятан за `if (require.main === module)`), поэтому импорт безопасен.
 *
 * Недетерминизм событий (шанс срабатывания) укрощаем через setRng: подменяем
 * генератор так, чтобы «бросок кубика» был предсказуемым — 0 (всегда меньше
 * любого порога → событие срабатывает) или 99 (никогда).
 *
 * Запуск:  npm test     (или:  node --test)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../server.js');
const N = S.GRID_SIZE;

// ── Фабрика искусственной комнаты ──────────────────────────────────────────
// Повторяет форму настоящей комнаты (см. onJoin в server.js), но пустую и
// полностью под нашим контролем. overrides позволяет точечно задать поле.
function makeRoom(overrides = {}) {
  const room = {
    code: 'test', grid: new Map(), players: new Map(), hostPid: null, lastActive: Date.now(),
    tick: 0, day: 0, treasury: 1000, taxes: { residential: 10, commercial: 10, property: 5 },
    deficit: false, districts: [], nextDistrictId: 0,
    terrain: new Array(N * N).fill('g'),           // по умолчанию всё трава
    reserve: new Array(N * N).fill(0),
    roads: new Array(N * N).fill(0),
    stock: { water: 0, food: 0, wood: 30, stone: 20 },
    short: { water: false, food: false }, prodRates: {}, center: null,
  };
  return Object.assign(room, overrides);
}
const idx = (x, y) => y * N + x;                    // (x,y) → индекс в плоских массивах
const setRoad = (room, x, y) => { room.roads[idx(x, y)] = 1; };
const setTerrain = (room, x, y, t) => { room.terrain[idx(x, y)] = t; };

// ════════════════════════════════════════════════════════════════════════
// РАЗБИВКА СЧАСТЬЯ
// Ключевая проверка прозрачности: сумма всех вкладов (parts) после отсечения
// в [0..100] обязана равняться итоговому happy. Иначе разбивка врёт игроку.
// ════════════════════════════════════════════════════════════════════════
test('счастье: сумма вкладов = итоговому happy (с отсечением 0..100)', () => {
  const room = makeRoom({ center: { x: 5, y: 5 }, taxes: { residential: 30, commercial: 10, property: 5 } });
  setRoad(room, 5, 5);                              // дорога-сосед для дома (5,6)
  room.grid.set('5,6', { type: 'house', owner: 'p', pop: 5, cap: 5, tier: 1, edu: 0 });
  room.grid.set('6,6', { type: 'factory', owner: 'p', tier: 1 }); // рядом → шум в разбивке
  room.stock.water = 99; room.stock.food = 99;      // вода/еда есть → базовый комфорт

  const sim = S.computeSim(room);
  const info = sim.houseInfo.get('5,6');
  assert.ok(info, 'дом должен попасть в houseInfo');

  const sum = info.parts.reduce((a, p) => a + p.val, 0);
  const clamped = Math.max(0, Math.min(100, Math.round(sum)));
  assert.equal(info.happy, clamped, 'happy должен совпадать с отсечённой суммой вкладов');

  // Конкретные слагаемые, которые обязаны присутствовать в этом сценарии:
  const labels = info.parts.map((p) => p.label);
  assert.ok(labels.some((l) => l.startsWith('Базовый уровень')), 'есть базовый уровень');
  assert.ok(labels.some((l) => l.includes('Жилой налог')), 'высокий жилой налог отражён минусом');
  assert.ok(info.parts.find((p) => p.label.includes('Жилой налог')).val < 0, 'налог — это минус');
});

test('счастье: закрытые вода+еда дают базовый комфорт (дом заселяется без клиники/полиции)', () => {
  const room = makeRoom({ center: { x: 5, y: 5 } });
  setRoad(room, 5, 5);
  room.grid.set('5,6', { type: 'house', owner: 'p', pop: 3, cap: 5, tier: 1, edu: 0 });
  room.stock.water = 50; room.stock.food = 50;

  const info = S.computeSim(room).houseInfo.get('5,6');
  const comfort = info.parts.find((p) => p.label.includes('Базовый комфорт'));
  assert.ok(comfort && comfort.val === S.CONST.BASIC_COMFORT, 'есть бонус базового комфорта');
});

// ════════════════════════════════════════════════════════════════════════
// ДОБЫЧА: ФЕРМА
// Спека: +FARM_BASE за само здание и +FARM_PER_GRASS за каждый ПУСТОЙ тайл
// травы ВНУТРИ радиуса города. Дорога/здание на клетке = занятая, не трава.
// ════════════════════════════════════════════════════════════════════════
test('ферма: только база, если нет центра города (дикие клетки не считаются)', () => {
  const room = makeRoom({ center: null });          // без центра inCity=false везде
  setRoad(room, 8, 6);                              // дорога-сосед фермы (8,5)
  room.grid.set('8,5', { type: 'farm', owner: 'p', tier: 1 });
  assert.equal(S.extractResources(room).food, S.CONST.FARM_BASE, 'без города — только база');
});

test('ферма: база + пустая трава в радиусе; дорога/здание не считаются травой', () => {
  // Ферма в (9,10), сосед-дорога (10,10). Центр (9,9), радиус базовый.
  const build = () => {
    const room = makeRoom({ center: { x: 9, y: 9 } });
    setRoad(room, 10, 10);
    room.grid.set('9,10', { type: 'farm', owner: 'p', tier: 1 });
    return room;
  };
  const withAll = S.extractResources(build()).food;
  assert.ok(withAll > S.CONST.FARM_BASE, 'внутри города считается пустая трава сверх базы');

  // Кладём дорогу на пустой тайл травы (9,8) — он внутри r2 фермы и внутри города.
  const room2 = build();
  setRoad(room2, 9, 8);
  const withRoadTile = S.extractResources(room2).food;
  assert.equal(withRoadTile, withAll - 1, 'дорога на траве убирает ровно 1 еду (дорога ≠ трава)');
});

// ════════════════════════════════════════════════════════════════════════
// ДОБЫЧА: КОЛОДЕЦ (по уровням)
// Спека: база WELL_BASE[ур] + WELL_PER[ур] за каждый тайл воды в радиусе.
// ════════════════════════════════════════════════════════════════════════
test('колодец: база по уровню + вода за тайлы воды', () => {
  function wellWater(tier, waterTiles) {
    const room = makeRoom({ center: { x: 6, y: 5 } });
    room.reserve.fill(1500);
    setRoad(room, 7, 5);                            // дорога-сосед колодца (6,5)
    // Раскидываем waterTiles тайлов воды вокруг (6,5), не на дороге:
    let placed = 0;
    for (let dy = -1; dy <= 1 && placed < waterTiles; dy++)
      for (let dx = -1; dx <= 1 && placed < waterTiles; dx++) {
        const gx = 6 + dx, gy = 5 + dy;
        if ((gx === 7 && gy === 5) || (dx === 0 && dy === 0)) continue;
        setTerrain(room, gx, gy, 'w'); placed++;
      }
    room.grid.set('6,5', { type: 'well', owner: 'p', tier });
    return S.extractResources(room).water;
  }
  const B = S.CONST.WELL_BASE, P = S.CONST.WELL_PER;
  assert.equal(wellWater(1, 0), B[0], 'ур.1 без воды = база');
  assert.equal(wellWater(1, 3), B[0] + 3 * P[0], 'ур.1 + 3 тайла');
  assert.equal(wellWater(2, 3), B[1] + 3 * P[1], 'ур.2 + 3 тайла');
  assert.equal(wellWater(3, 3), B[2] + 3 * P[2], 'ур.3 + 3 тайла');
});

// ════════════════════════════════════════════════════════════════════════
// ВЕРА / ЗНАНИЯ / РАДИУС
// Вера = население×FAITH_PER_POP + церкви − знания×KNOWLEDGE_FAITH_COST, но
// не ниже 0 (базовый радиус неприкосновенен). Радиус за FAITH_SOFT_RADIUS
// растёт втрое медленнее.
// ════════════════════════════════════════════════════════════════════════
test('вера: знания понижают, церковь возвращает, базовый радиус защищён', () => {
  const base = () => {
    const room = makeRoom({ center: { x: 6, y: 6 } });
    setRoad(room, 5, 5); setRoad(room, 6, 5);
    room.grid.set('5,5', { type: 'house', owner: 'p', pop: 5, cap: 5, tier: 1, edu: 0 });
    room.grid.set('6,5', { type: 'house', owner: 'p', pop: 5, cap: 5, tier: 1, edu: 0 });
    return room;
  };
  const r1 = base();
  const faith0 = S.cityFaith(r1);
  assert.equal(faith0, 10 * S.CONST.FAITH_PER_POP, 'вера = население × коэффициент');

  const r2 = base();                                // те же дома, но образованные
  r2.grid.get('5,5').edu = 1; r2.grid.get('6,5').edu = 1;
  assert.ok(S.cityFaith(r2) < faith0, 'знания снижают веру');
  assert.ok(S.cityRadius(r2) >= S.CONST.FAITH_BASE_RADIUS, 'радиус не падает ниже базового (пол)');

  const r3 = base();                                // добавим церковь рядом с домами
  r3.grid.get('5,5').edu = 1; r3.grid.get('6,5').edu = 1;
  r3.grid.set('7,5', { type: 'church', owner: 'p', tier: 1 });
  assert.ok(S.cityFaith(r3) > S.cityFaith(r2), 'церковь возвращает веру');
});

// ════════════════════════════════════════════════════════════════════════
// ОБРАЗОВАНИЕ
// Школа образует жителей в зоне по таймеру (1/EDU_DAYS в день) и только в
// пределах вместимости (schoolCoverage). Дом без школы теряет образованность.
// ════════════════════════════════════════════════════════════════════════
test('образование: школа поднимает edu дома в зоне', () => {
  const room = makeRoom({ center: { x: 6, y: 6 } });
  setRoad(room, 7, 6);                              // дорога-сосед школы (7,5) — школа без дороги не работает
  room.grid.set('5,5', { type: 'house', owner: 'p', pop: 5, cap: 5, tier: 1, edu: 0 });
  room.grid.set('7,5', { type: 'school', owner: 'p', tier: 1 });
  S.updateEducation(room);
  assert.ok(room.grid.get('5,5').edu > 0, 'после дня у школы образованность выросла');
});

test('образование: школа покрывает только в пределах вместимости', () => {
  // Вместимость школы ур.1 = SCHOOL_CAP жителей. Набьём домов больше вместимости —
  // дальние по населению останутся без покрытия (не попадут в schoolCoverage).
  const room = makeRoom({ center: { x: 9, y: 9 } });
  setRoad(room, 9, 8);
  room.grid.set('9,9', { type: 'school', owner: 'p', tier: 1 });
  let houses = 0;
  const cap = S.CONST.SCHOOL_CAP;                   // напр. 20 жителей
  // Дома по 5 жителей: чтобы точно превысить вместимость, ставим (cap/5 + 2) домов.
  for (let dy = -1; dy <= 1 && houses < cap / 5 + 2; dy++)
    for (let dx = -1; dx <= 1 && houses < cap / 5 + 2; dx++) {
      if (dx === 0 && dy === 0) continue;
      const gx = 9 + dx, gy = 9 + dy;
      room.grid.set(`${gx},${gy}`, { type: 'house', owner: 'p', pop: 5, cap: 5, tier: 1, edu: 0 });
      houses++;
    }
  const served = S.schoolCoverage(room);
  const servedPop = [...served].reduce((a, k) => a + (room.grid.get(k).pop || 0), 0);
  assert.ok(servedPop <= cap, 'суммарно обучаемых жителей не больше вместимости');
  assert.ok(served.size < houses, 'часть домов осталась без места');
});

// ════════════════════════════════════════════════════════════════════════
// ВЫСЕЛЕНИЕ ВНЕ РАДИУСА
// Дом вне радиуса города дольше 2 дней теряет всех жителей.
// ════════════════════════════════════════════════════════════════════════
test('выселение: дом вне радиуса >2 дней теряет жителей', () => {
  const room = makeRoom({ center: { x: 2, y: 2 } });   // маленький радиус у угла
  setRoad(room, 15, 15);
  // Дом далеко от центра — заведомо вне радиуса влияния.
  room.grid.set('15,16', { type: 'house', owner: 'p', pop: 5, cap: 5, tier: 1, edu: 0, savings: 0 });
  for (let d = 0; d < 3; d++) S.runDay(room);           // 3 дня вне радиуса
  assert.equal(room.grid.get('15,16').pop, 0, 'жители уехали после >2 дней вне радиуса');
});

// ════════════════════════════════════════════════════════════════════════
// СТОИМОСТЬ УЛУЧШЕНИЯ
// Деньги = cost × UP_COST_MULT × текущий_уровень; дерево/камень как у здания.
// ════════════════════════════════════════════════════════════════════════
test('upgradeCost: деньги растут с уровнем', () => {
  const def = S.BUILDINGS.clinic;
  const c1 = S.upgradeCost(def, 1), c2 = S.upgradeCost(def, 2);
  assert.equal(c1.money, Math.round(def.cost * S.CONST.UP_COST_MULT * 1));
  assert.equal(c2.money, Math.round(def.cost * S.CONST.UP_COST_MULT * 2));
  assert.ok(c2.money > c1.money, 'ур.2→3 дороже, чем ур.1→2');
});

// ════════════════════════════════════════════════════════════════════════
// СОБЫТИЯ (детерминированно через setRng)
// Вызываем event.run(room, ctx, news) напрямую с искусственным ctx.
// setRng(() => 0) — кубик всегда 0, порог всегда пройден → событие срабатывает.
// ════════════════════════════════════════════════════════════════════════
const ev = (id) => S.EVENTS.find((e) => e.id === id);
const district = (name = 'Тест') => ({ id: 0, name, mods: {} });
function runEvent(id, room, ctx) { const news = []; ev(id).run(room, ctx, news); return news; }

test('событие пробок: срабатывает, когда дорог меньше, чем зданий', () => {
  S.setRng(() => 0);                                // кубик не важен для gridlock (у него нет шанса)
  const d = district('Центр');
  const news = runEvent('gridlock', { districts: [d] }, { provCount: { 0: 5 }, roadCount: { 0: 2 } });
  assert.equal(news.length, 1, 'пробки при 5 зданиях на 2 дороги');
  assert.ok(d.mods.gridlock, 'модификатор навешен');

  const d2 = district('Центр');
  const quiet = runEvent('gridlock', { districts: [d2] }, { provCount: { 0: 5 }, roadCount: { 0: 9 } });
  assert.equal(quiet.length, 0, 'когда дорог достаточно — молчит');
});

test('событие забастовки: только при высоком жилом налоге', () => {
  S.setRng(() => 0);                                // кубик = 0 → шанс всегда проходит
  const hi = runEvent('strike', { districts: [district()], taxes: { residential: 30 } }, { pop: { 0: 6 } });
  assert.equal(hi.length, 1, 'налог 30% → забастовка');

  const lo = runEvent('strike', { districts: [district()], taxes: { residential: 10 } }, { pop: { 0: 6 } });
  assert.equal(lo.length, 0, 'налог 10% → тихо');

  S.setRng(() => 99);                               // кубик = 99 → шанс никогда не проходит
  const unlucky = runEvent('strike', { districts: [district()], taxes: { residential: 30 } }, { pop: { 0: 6 } });
  assert.equal(unlucky.length, 0, 'при неудачном броске событие не срабатывает');
});

test('событие смога: грязная экология + завод', () => {
  S.setRng(() => 0);
  const yes = runEvent('smog', { districts: [district()] }, { stats: { 0: { eco: 20 } }, types: { 0: new Set(['factory']) } });
  assert.equal(yes.length, 1, 'eco 20 + завод → смог');
  const clean = runEvent('smog', { districts: [district()] }, { stats: { 0: { eco: 80 } }, types: { 0: new Set(['factory']) } });
  assert.equal(clean.length, 0, 'чистая экология → нет смога');
});

test('событие инвестиций: полная казна + богатый район', () => {
  S.setRng(() => 0);
  const rich = runEvent('invest', { treasury: 3000, districts: [district()] }, { prosperity: { 0: 50 } });
  assert.equal(rich.length, 1, 'казна 3000 + процветание 50 → инвестиции');
  const poor = runEvent('invest', { treasury: 500, districts: [district()] }, { prosperity: { 0: 50 } });
  assert.equal(poor.length, 0, 'пустая казна → нет инвестиций');
});

// Возвращаем настоящий рандом после тестов событий.
test.after(() => S.setRng(() => require('crypto').randomInt(0, 100)));
