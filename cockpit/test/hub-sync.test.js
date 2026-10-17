'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server.js');
const { buildSpeciesIndex } = require('../../shared/species.js');
const { createHubSync } = require('../../shared/hub-sync.js');

function createMockDeps() {
  const records = new Map([
    ['acc1', {
      id: 'acc1',
      name: 'ContaUm',
      tokens: { accessToken: 'acc_tok_1', refreshToken: 'ref_tok_1' },
      lastHunt: 'bulbasaur'
    }],
    ['acc2', {
      id: 'acc2',
      name: 'ContaDois',
      tokens: { accessToken: 'acc_tok_2', refreshToken: 'ref_tok_2' },
      lastHunt: 'charmander'
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
    me: async (token) => ({
      character: {
        id: token.includes('1') ? 'acc1' : 'acc2',
        name: token.includes('1') ? 'ContaUm' : 'ContaDois',
        gold: 1000,
        diamonds: 10,
        level: 30
      }
    }),
    refresh: async () => ({ accessToken: 'new_acc', refreshToken: 'new_ref' })
  };

  const species = buildSpeciesIndex([]);
  const itemsCatalog = { list: [], byId: new Map(), get: () => null };

  return { store, api, species, itemsCatalog };
}

test('Piwdex Hub <-> Cockpit Token & Lifecycle Sync', async (t) => {
  const deps = createMockDeps();
  const app = createApp(deps);
  for (const rec of deps.store.list()) {
    const acc = app.addAccount(rec);
    acc.openSocket = () => {
      acc.setState({ status: 'online' });
    };
  }

  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  const cockpitUrl = `http://127.0.0.1:${port}`;

  t.after(() => {
    app.server.close();
  });

  await t.test('carrega tokens das contas do Cockpit para os slots 1..4 do Hub e coloca contas em handedOff', async () => {
    const hubSlots = new Map();
    const hubSync = createHubSync({
      cockpitUrl,
      getToken: slot => hubSlots.get(slot) ?? null,
      setToken: (slot, tok) => hubSlots.set(slot, tok)
    });

    const synced = await hubSync.syncFromCockpit();
    assert.equal(synced.ok, true);
    assert.equal(synced.count, 2);

    assert.deepEqual(JSON.parse(hubSlots.get(1)), { accessToken: 'acc_tok_1', refreshToken: 'ref_tok_1' });
    assert.deepEqual(JSON.parse(hubSlots.get(2)), { accessToken: 'acc_tok_2', refreshToken: 'ref_tok_2' });
    assert.equal(app.accounts.get('acc1').state.status, 'handedOff');
    assert.equal(app.accounts.get('acc2').state.status, 'handedOff');
  });

  await t.test('propaga rotacao de token de um slot do Hub de volta para o Cockpit', async () => {
    const hubSlots = new Map([
      [1, JSON.stringify({ accessToken: 'acc_tok_1', refreshToken: 'ref_tok_1' })]
    ]);
    const hubSync = createHubSync({
      cockpitUrl,
      getToken: slot => hubSlots.get(slot) ?? null,
      setToken: (slot, tok) => hubSlots.set(slot, tok)
    });

    await hubSync.syncFromCockpit();

    const rotated = JSON.stringify({ accessToken: 'acc_tok_1_rotated', refreshToken: 'ref_tok_1_rotated' });
    hubSlots.set(1, rotated);
    const res = await hubSync.onSlotTokenChanged(1, rotated);
    assert.equal(res.ok, true);

    assert.equal(app.accounts.get('acc1').tokens.accessToken, 'acc_tok_1_rotated');
    assert.equal(deps.store.get('acc1').tokens.refreshToken, 'ref_tok_1_rotated');
  });

  await t.test('opera em modo offline fallback sem quebrar quando o Cockpit esta inacessivel', async () => {
    const hubSlots = new Map([
      [1, JSON.stringify({ accessToken: 'local_only', refreshToken: 'local_ref' })]
    ]);
    const hubSync = createHubSync({
      cockpitUrl: 'http://127.0.0.1:1', // porta invalida/offline
      timeoutMs: 200,
      getToken: slot => hubSlots.get(slot) ?? null,
      setToken: (slot, tok) => hubSlots.set(slot, tok)
    });

    const synced = await hubSync.syncFromCockpit();
    assert.equal(synced.ok, false);
    // Token local permanece intacto
    assert.equal(JSON.parse(hubSlots.get(1)).accessToken, 'local_only');
  });

  await t.test('releaseAll libera todas as contas sincronizadas de volta para idle ao fechar o Hub', async () => {
    const hubSlots = new Map();
    const hubSync = createHubSync({
      cockpitUrl,
      getToken: slot => hubSlots.get(slot) ?? null,
      setToken: (slot, tok) => hubSlots.set(slot, tok)
    });

    await hubSync.syncFromCockpit();
    assert.equal(app.accounts.get('acc1').state.status, 'handedOff');
    assert.equal(app.accounts.get('acc2').state.status, 'handedOff');

    const rel = await hubSync.releaseAll();
    assert.equal(rel.ok, true);
    assert.notEqual(app.accounts.get('acc1').state.status, 'handedOff');
    assert.notEqual(app.accounts.get('acc2').state.status, 'handedOff');
  });
});

