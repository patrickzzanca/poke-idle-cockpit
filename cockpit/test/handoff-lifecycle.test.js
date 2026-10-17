'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server.js');
const { buildSpeciesIndex } = require('../../shared/species.js');

function createMockDeps() {
  const records = new Map([
    ['acc1', {
      id: 'acc1',
      name: 'TrainerRed',
      tokens: { accessToken: 'tok_red', refreshToken: 'ref_red' },
      lastHunt: 'pidgey'
    }]
  ]);

  const store = {
    config: { tags: {}, alerts: {}, highlight: {} },
    warnings: [],
    list: () => [...records.values()],
    get: id => records.get(id) ?? null,
    upsert: rec => {
      const prev = records.get(rec.id) || {};
      records.set(rec.id, { ...prev, ...rec });
    },
    remove: id => records.delete(id),
    getCmid: () => 'mock-cmid',
    setCmid: () => false,
    getWishlist: () => [],
    getCustomPresets: () => [],
    getTickerHistory: () => ({ diamonds: [], pheromones: [] })
  };

  const api = {
    me: async () => ({
      character: { id: 'acc1', name: 'TrainerRed', gold: 5000, diamonds: 25, level: 80 }
    }),
    refresh: async () => ({ accessToken: 'tok_red_2', refreshToken: 'ref_red_2' })
  };

  const species = buildSpeciesIndex([
    { pokeId: 16, name: 'Pidgey', huntLevel: 1 },
    { pokeId: 43, name: 'Oddish', huntLevel: 1 }
  ]);
  const itemsCatalog = { list: [], byId: new Map(), get: () => null };

  return { store, api, species, itemsCatalog };
}

test('Handoff Lifecycle & RouteRunner Coordination (Headless 24/7 <-> Visual Desktop)', async (t) => {
  const deps = createMockDeps();
  const app = createApp(deps);
  const acc = app.addAccount(deps.store.get('acc1'));

  const sentMessages = [];
  let socketClosedCount = 0;

  acc.openSocket = () => {
    acc.socket = {
      readyState: 1, // WebSocket.OPEN
      send: raw => sentMessages.push(JSON.parse(raw)),
      close: () => { socketClosedCount++; }
    };
    acc.setState({ status: 'online', error: null });
  };
  acc.send = msg => {
    if (acc.state.status === 'online') {
      sentMessages.push(msg);
    }
  };

  await acc.start();
  assert.equal(acc.state.status, 'online');

  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const runner = app.getRouteRunner(acc);
  t.after(() => {
    runner.stop(false);
    app.server.close();
  });

  await t.test('suspende RouteRunner ao receber heartbeat do Piwdex Hub e retoma caça ao receber release', async () => {
    sentMessages.length = 0;

    runner.start({
      queue: [
        { speciesId: 16, name: 'Pidgey', slug: 'pidgey', target: 2 },
        { speciesId: 43, name: 'Oddish', slug: 'oddish', target: 2 }
      ],
      maxTimeWithoutKillSec: 1
    });

    assert.equal(runner.getStatus().running, true);
    assert.equal(runner.getStatus().suspendedByHandoff, false);
    assert.ok(sentMessages.some(m => m.type === 'enter-hunt' && m.slug === 'pidgey'), 'deve enviar enter-hunt inicial');

    sentMessages.length = 0;

    // 1. Piwdex Hub envia heartbeat assumindo a sessao visual
    const hbRes = await fetch(`${baseUrl}/api/bridge/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-PIW-Bridge': '1'
      },
      body: JSON.stringify({
        accountId: 'acc1',
        tokens: { accessToken: 'tok_red', refreshToken: 'ref_red' }
      })
    });
    assert.equal(hbRes.status, 200);
    assert.equal(acc.state.status, 'handedOff');
    assert.equal(runner.getStatus().suspendedByHandoff, true);
    assert.ok(socketClosedCount >= 1, 'deve fechar socket headless ao entrar em handedOff');

    // Simula passagem de tempo maior que maxTimeWithoutKillSec enquanto está handedOff:
    // o watchdog NÃO pode pular o alvo nem enviar enter-hunt concorrente!
    runner.state.lastKillInHuntAt = Date.now() - 10_000;
    runner.checkWatchdog?.();
    assert.equal(runner.getCurrentTarget().slug, 'pidgey', 'nao deve pular alvo durante handoff');
    assert.equal(sentMessages.length, 0, 'nao deve enviar enter-hunt enquanto handedOff');

    // 2. Piwdex Hub fecha e envia release
    const relRes = await fetch(`${baseUrl}/api/bridge/release`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-PIW-Bridge': '1'
      },
      body: JSON.stringify({ accountId: 'acc1' })
    });
    assert.equal(relRes.status, 200);

    // Aguarda reconexao assincrona da conta
    await new Promise(r => setTimeout(r, 30));

    assert.equal(acc.state.status, 'online');
    assert.equal(runner.getStatus().suspendedByHandoff, false);
    assert.ok(
      sentMessages.some(m => m.type === 'enter-hunt' && m.slug === 'pidgey'),
      'deve reenviar enter-hunt automaticamente ao retomar do handoff'
    );
  });
});
