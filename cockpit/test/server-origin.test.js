'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server.js');
const { buildSpeciesIndex } = require('../../shared/species.js');

function createMockDeps() {
  const records = new Map([
    ['acc1', {
      id: 'acc1',
      name: 'AshKetchum',
      tokens: { accessToken: 'tok_acc_1', refreshToken: 'tok_ref_1' },
      lastHunt: 'pikachu'
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
    me: async () => ({ character: { id: 'acc1', name: 'AshKetchum', gold: 1000, diamonds: 50, level: 20 } }),
    refresh: async () => ({ accessToken: 'tok_acc_new', refreshToken: 'tok_ref_new' })
  };

  const species = buildSpeciesIndex([]);
  const itemsCatalog = { list: [], byId: new Map(), get: () => null };

  return { store, api, species, itemsCatalog };
}

test('Cockpit Server Bridge & Electron Origin Security', async (t) => {
  const deps = createMockDeps();
  const app = createApp(deps);
  // Registra a conta na memoria sem iniciar socket real
  for (const rec of deps.store.list()) {
    // Usamos register via store ou inicializamos via bridge
  }

  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(() => {
    app.server.close();
  });

  await t.test('rejeita POST sem Origin e sem X-PIW-Bridge', async () => {
    const res = await fetch(`${baseUrl}/api/radar/clear`, {
      method: 'POST'
    });
    assert.equal(res.status, 403);
  });

  await t.test('rejeita Origin file:// sem X-PIW-Bridge', async () => {
    const res = await fetch(`${baseUrl}/api/state`, {
      headers: { Origin: 'file://' }
    });
    assert.equal(res.status, 403);
  });

  await t.test('aceita Origin file:// e null quando X-PIW-Bridge: 1 esta presente', async () => {
    const resFile = await fetch(`${baseUrl}/api/state`, {
      headers: { Origin: 'file://', 'X-PIW-Bridge': '1' }
    });
    assert.equal(resFile.status, 200);

    const resNull = await fetch(`${baseUrl}/api/state`, {
      headers: { Origin: 'null', 'X-PIW-Bridge': '1' }
    });
    assert.equal(resNull.status, 200);
  });

  await t.test('aceita POST sem Origin quando X-PIW-Bridge: 1 esta presente (Electron Main Process)', async () => {
    const res = await fetch(`${baseUrl}/api/radar/clear`, {
      method: 'POST',
      headers: { 'X-PIW-Bridge': '1' }
    });
    assert.equal(res.status, 200);
  });

  await t.test('GET /api/bridge/accounts retorna contas com tokens para o Piwdex Hub', async () => {
    // Cadastra a conta via bridge register primeiro
    const regRes = await fetch(`${baseUrl}/api/bridge/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PIW-Bridge': '1' },
      body: JSON.stringify({
        tokens: { accessToken: 'tok_acc_1', refreshToken: 'tok_ref_1' }
      })
    });
    assert.equal(regRes.status, 200);

    // Consulta GET /api/bridge/accounts
    const hubRes = await fetch(`${baseUrl}/api/bridge/accounts`, {
      headers: { 'X-PIW-Bridge': '1' }
    });
    assert.equal(hubRes.status, 200);
    const data = await hubRes.json();
    assert.ok(Array.isArray(data.accounts));
    assert.equal(data.accounts.length, 1);
    assert.equal(data.accounts[0].id, 'acc1');
    assert.equal(data.accounts[0].name, 'AshKetchum');
    assert.deepEqual(data.accounts[0].tokens, {
      accessToken: 'tok_acc_1',
      refreshToken: 'tok_ref_1'
    });
  });
});
