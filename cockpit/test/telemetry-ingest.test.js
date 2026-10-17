'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server.js');
const { buildSpeciesIndex } = require('../../shared/species.js');

function createMockDeps() {
  const records = new Map();
  const store = {
    config: {
      tags: {},
      alerts: {},
      highlight: { minQuality: 1.7, minIv: 130 }
    },
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
    me: async (token) => ({
      character: { id: 'player1', name: 'Red', gold: 5000, diamonds: 100, level: 50 }
    }),
    refresh: async () => ({ accessToken: 'tok_acc_2', refreshToken: 'tok_ref_2' })
  };

  const species = buildSpeciesIndex([
    { pokeId: 25, name: 'Pikachu', type1: 'Electric', baseHp: 35, baseAttack: 55, baseDefense: 40, baseSpAttack: 50, baseSpDefense: 50, baseSpeed: 90 }
  ]);
  const itemsCatalog = { list: [], byId: new Map(), get: () => null };

  return { store, api, species, itemsCatalog };
}

test('Telemetry Ingestion from Piwdex Hub (/api/bridge/telemetry)', async (t) => {
  const deps = createMockDeps();
  const app = createApp(deps);

  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(() => {
    app.server.close();
  });

  await t.test('auto-registra conta via tokens se ainda nao existir e ingere telemetria de shiny, kill, faint e captura', async () => {
    const res = await fetch(`${baseUrl}/api/bridge/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PIW-Bridge': '1' },
      body: JSON.stringify({
        tokens: { accessToken: 'tok_red', refreshToken: 'ref_red' },
        telemetry: {
          lastHunt: 'pikachu',
          huntName: 'Pikachu Forest',
          leaderFainted: true,
          pokes: [
            { id: 'p1', speciesId: 25, name: 'Pikachu Inicial', level: 10, ivTotal: 100, quality: 1.2, team: true, leader: true }
          ],
          shinies: [
            { speciesId: 25, name: 'Pikachu', type: 'spawn', at: Date.now() }
          ],
          kills: [
            { speciesId: 25, speciesName: 'Pikachu', xp: 120, loot: [{ itemId: 1, qty: 2 }] }
          ],
          captures: [
            { id: 'p2', speciesId: 25, name: 'Pikachu Top', level: 15, ivTotal: 175, quality: 1.80, shiny: true }
          ]
        }
      })
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.accountId, 'player1');
    assert.equal(body.status, 'handedOff');

    // Verifica estado no /api/state
    const stateRes = await fetch(`${baseUrl}/api/state`, {
      headers: { 'X-PIW-Bridge': '1' }
    });
    assert.equal(stateRes.status, 200);
    const state = await stateRes.json();

    assert.equal(state.accounts.length, 1);
    const acc = state.accounts[0];
    assert.equal(acc.id, 'player1');
    assert.equal(acc.hunt, 'Pikachu Forest');
    assert.equal(acc.leaderFainted, true);
    assert.equal(acc.pokeCount, 2);

    // Verifica se o shiny spawn e o shiny capture entraram na lista de shinies da sessao
    assert.ok(state.shinies.length >= 1);
    assert.equal(state.shinies[0].speciesId, 25);

    // Verifica se a captura de alto valor entrou em highlights
    assert.equal(state.highlights.length, 1);
    assert.equal(state.highlights[0].poke.id, 'p2');
  });

  await t.test('resolve conta existente pelo accountName ou token sem precisar de accountId explicito', async () => {
    const res = await fetch(`${baseUrl}/api/bridge/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PIW-Bridge': '1' },
      body: JSON.stringify({
        accountName: 'Red',
        telemetry: {
          leaderFainted: false
        }
      })
    });
    assert.equal(res.status, 200);

    const stateRes = await fetch(`${baseUrl}/api/state`, {
      headers: { 'X-PIW-Bridge': '1' }
    });
    const state = await stateRes.json();
    assert.equal(state.accounts[0].leaderFainted, false);
  });
});
