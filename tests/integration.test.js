'use strict';
/*
 * ИНТЕГРАЦИОННЫЕ ТЕСТЫ WS-ПРОТОКОЛА  (node --test)
 * ─────────────────────────────────────────────────────────────────────────
 * Что покрываем: связку «клиент → WebSocket → обработчик → broadcast». Здесь
 * важно не столько число, сколько что команды доходят, валидируются и меняют
 * состояние, которое рассылается обратно.
 *
 * Как поднимаем сервер: server.js экспортирует start(port). Стартуем на порту 0
 * (ОС выдаёт свободный) — так тесты не конфликтуют с реальным сервером и друг с
 * другом. Автоматический тик при require НЕ запускается (спрятан за
 * require.main===module), поэтому 'state' приходит только в ответ на действия —
 * значит проверки детерминированы, фон ничего не двигает.
 *
 * Клиент — тонкая обёртка над ws: копит входящие сообщения и умеет ждать
 * сообщение нужного типа (next) и слать команды (send).
 *
 * Запуск:  npm test   (или:  node --test)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const S = require('../server.js');

let PORT;
// Поднимаем сервер один раз на весь файл.
test.before(async () => {
  await new Promise((res) => { const srv = S.start(0); srv.on('listening', () => { PORT = srv.address().port; res(); }); });
});
test.after(() => { try { S.server.close(); } catch (_) {} });

// ── Тонкий WS-клиент для тестов ─────────────────────────────────────────────
function client() {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const buf = [];                 // накопленные сообщения
  const waiters = [];             // ожидающие next()
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    const i = waiters.findIndex((w) => !w.type || w.type === msg.type);
    if (i >= 0) { const w = waiters.splice(i, 1)[0]; w.resolve(msg); } else buf.push(msg);
  });
  const api = {
    open: () => new Promise((r) => ws.on('open', r)),
    send: (o) => ws.send(JSON.stringify(o)),
    // ждём следующее сообщение (опц. заданного типа); сначала смотрим в буфер
    next: (type) => new Promise((resolve, reject) => {
      const i = buf.findIndex((m) => !type || m.type === type);
      if (i >= 0) return resolve(buf.splice(i, 1)[0]);
      const t = setTimeout(() => reject(new Error('таймаут ожидания ' + (type || 'сообщения'))), 2000);
      waiters.push({ type, resolve: (m) => { clearTimeout(t); resolve(m); } });
    }),
    close: () => ws.close(),
  };
  return api;
}
// Джойнимся и возвращаем {joined, state, c}. code — чтобы второй игрок вошёл в ту же комнату.
async function join(name, code) {
  const c = client(); await c.open();
  c.send({ type: 'join', name, code });
  const joined = await c.next('joined');
  const state = await c.next('state');
  return { c, joined, state };
}
// Ищем в поле (строка террейна) верхний-левый угол свободной 3×3 области травы.
function findGrass(terrain, n) {
  const g = (x, y) => terrain[y * n + x] === 'g';
  for (let y = 3; y < n - 3; y++)
    for (let x = 3; x < n - 3; x++) {
      let ok = true;
      for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) if (!g(x + dx, y + dy)) ok = false;
      if (ok) return { x, y };
    }
  return null;
}

// ════════════════════════════════════════════════════════════════════════
test('join: игрок получает joined и стартовое состояние', async () => {
  const { c, joined, state } = await join('Аня');
  assert.ok(joined.pid, 'выдан pid');
  assert.ok(joined.code && joined.code.length === 6, 'выдан 6-значный код комнаты');
  assert.equal(typeof state.treasury, 'number', 'в состоянии есть казна');
  c.close();
});

test('place: центр и дом появляются в состоянии', async () => {
  const { c, joined } = await join('Боб');
  const n = joined.gridSize, spot = findGrass(joined.terrain, n);
  assert.ok(spot, 'на поле нашлась площадка травы');

  c.send({ type: 'place', x: spot.x, y: spot.y, building: 'center' });
  await c.next('state');
  c.send({ type: 'place', x: spot.x + 1, y: spot.y, building: 'road' });
  await c.next('state');
  c.send({ type: 'place', x: spot.x + 1, y: spot.y + 1, building: 'house' });
  const st = await c.next('state');

  assert.equal(st.grid[`${spot.x},${spot.y}`].type, 'center', 'центр построен');
  assert.equal(st.grid[`${spot.x + 1},${spot.y + 1}`].type, 'house', 'дом построен');
  c.close();
});

test('upgrade: 1→2 проходит за ресурсы, 2→3 блокируется без образования', async () => {
  const { c, joined } = await join('Вера');
  const n = joined.gridSize, spot = findGrass(joined.terrain, n);
  c.send({ type: 'place', x: spot.x, y: spot.y, building: 'center' }); await c.next('state');
  c.send({ type: 'place', x: spot.x + 1, y: spot.y, building: 'road' }); await c.next('state');
  // лесопилка на траве, сосед — дорога (spot.x+1, spot.y)
  c.send({ type: 'place', x: spot.x + 2, y: spot.y, building: 'sawmill' }); await c.next('state');

  c.send({ type: 'upgrade', x: spot.x + 2, y: spot.y });
  const up1 = await c.next();                 // ожидаем state (успех), не error
  assert.equal(up1.type, 'state', '1→2 проходит за ресурсы');
  assert.equal(up1.grid[`${spot.x + 2},${spot.y}`].tier, 2, 'уровень стал 2');

  c.send({ type: 'upgrade', x: spot.x + 2, y: spot.y });
  const up2 = await c.next();                 // ожидаем error (нет образованных в районе)
  assert.equal(up2.type, 'error', '2→3 без образования блокируется');
  assert.match(up2.message, /образован/i, 'сообщение про образование');
  c.close();
});

test('bulldoze: снос возвращает часть денег и убирает здание', async () => {
  const { c, joined } = await join('Гена');
  const n = joined.gridSize, spot = findGrass(joined.terrain, n);
  c.send({ type: 'place', x: spot.x, y: spot.y, building: 'center' }); await c.next('state');
  c.send({ type: 'place', x: spot.x + 1, y: spot.y, building: 'road' }); await c.next('state');
  c.send({ type: 'place', x: spot.x + 1, y: spot.y + 1, building: 'house' });
  const afterBuild = await c.next('state');
  const t1 = afterBuild.treasury;

  c.send({ type: 'bulldoze', x: spot.x + 1, y: spot.y + 1 });
  const afterRaze = await c.next('state');
  assert.equal(afterRaze.grid[`${spot.x + 1},${spot.y + 1}`], undefined, 'дом снесён');
  assert.ok(afterRaze.treasury > t1, 'часть стоимости вернулась в казну');
  c.close();
});

test('settax: изменение налога отражается в состоянии', async () => {
  const { c } = await join('Дина');
  c.send({ type: 'settax', kind: 'residential', value: 25 });
  const st = await c.next('state');
  assert.equal(st.taxes.residential, 25, 'жилой налог стал 25%');
  c.close();
});

test('cursor: курсор одного игрока долетает до другого', async () => {
  const a = await join('Ева');
  const b = await join('Жора', a.joined.code);      // тот же код → одна комната
  a.c.send({ type: 'cursor', x: 7, y: 9 });
  const cur = await b.c.next('cursor');
  assert.equal(cur.pid, a.joined.pid, 'курсор помечен pid отправителя');
  assert.equal(cur.x, 7); assert.equal(cur.y, 9);
  assert.ok(cur.color, 'у курсора есть цвет игрока');
  a.c.close(); b.c.close();
});

test('rename: переименование несуществующего района не роняет сервер', async () => {
  const { c } = await join('Зоя');
  c.send({ type: 'rename', id: 999, name: 'Пустота' });  // такого района нет
  // сервер должен остаться живым: следующая валидная команда всё ещё отвечает
  c.send({ type: 'settax', kind: 'commercial', value: 15 });
  const st = await c.next('state');
  assert.equal(st.taxes.commercial, 15, 'сервер жив и отвечает после невалидного rename');
  c.close();
});
