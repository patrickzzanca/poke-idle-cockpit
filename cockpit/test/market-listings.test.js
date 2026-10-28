'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server.js');
const { buildSpeciesIndex } = require('../../shared/species.js');

function createMockDeps() {
  const store = {
    config: { tags: {}, alerts: {}, highlight: { minQuality: 1.7, minIv: 150 } },
    warnings: [],
    list: () => [
      { id: 'acc1', name: 'Trainer1', tokens: { accessToken: 'tok1', refreshToken: 'ref1' } },
      { id: 'acc2', name: 'Trainer2', tokens: { accessToken: 'tok2', refreshToken: 'ref2' } }
    ],
    get: id => ({ id, name: id, tokens: { accessToken: 'tok_' + id, refreshToken: 'ref_' + id } }),
    upsert: () => {},
    remove: () => {},
    getCmid: () => null,
    setCmid: () => false,
    getWishlist: () => [],
    getCustomPresets: () => [],
    getTickerHistory: () => ({ diamonds: [], pheromones: [] })
  };

  const marketListings = [
    // Fire Stone (id: 53) - piso atual é 5200 Gold
    { kind: 'item', refId: 53, name: 'Fire Stone', price: 5200, quantity: 10, currency: 'GOLD', sellers: 1 },
    { kind: 'item', refId: 53, name: 'Fire Stone', price: 5300, quantity: 5, currency: 'GOLD', sellers: 1 },
    // Ancient Stone (id: 2) - piso atual é 30 Diamonds
    { kind: 'item', refId: 2, name: 'Ancient Stone', price: 30, quantity: 1, currency: 'DIAMONDS', sellers: 1 }
  ];

  const api = {
    me: async () => ({ character: { id: 'acc1', name: 'Trainer1' } }),
    refresh: async () => ({ accessToken: 'tok_fresh' }),
    marketCategory: async (token) => {
      // Simula anúncios do usuário conforme a conta
      if (token === 'tok1' || token === 'tok_acc1') {
        return {
          listings: marketListings,
          mine: [
            // Anúncio 1: Fire Stone a 5800 Gold (superado pelo piso 5200), publicado há 2 dias
            {
              id: 'listing_old_fire',
              refId: 53,
              kind: 'item',
              name: 'Fire Stone',
              quantity: 2,
              price: 5800,
              currency: 'GOLD',
              at: new Date(Date.now() - 48 * 3600000).toISOString()
            },
            // Anúncio 2: Ancient Stone a 30 Diamonds (menor preço igual ao piso), publicado há 2 horas
            {
              id: 'listing_fresh_stone',
              refId: 2,
              kind: 'item',
              name: 'Ancient Stone',
              quantity: 1,
              price: 30,
              currency: 'DIAMONDS',
              at: new Date(Date.now() - 2 * 3600000).toISOString()
            }
          ]
        };
      }
      return {
        listings: marketListings,
        mine: []
      };
    }
  };

  const species = buildSpeciesIndex([]);
  const itemsCatalog = {
    list: [
      { id: 2, name: 'Ancient Stone', icon: '/assets/stones/ancient_stone.gif', category: 'stone' },
      { id: 53, name: 'Fire Stone', icon: 'fire_stone.gif', category: 'stone' }
    ],
    byId: new Map([
      [2, { id: 2, name: 'Ancient Stone', icon: '/assets/stones/ancient_stone.gif', category: 'stone' }],
      [53, { id: 53, name: 'Fire Stone', icon: 'fire_stone.gif', category: 'stone' }]
    ]),
    get: id => itemsCatalog.byId.get(Number(id)) ?? null
  };

  return { store, api, species, itemsCatalog };
}

test('Market Listings - Stale (>1 day) & Undercut Analysis', async (t) => {
  const deps = createMockDeps();
  const app = createApp(deps);
  app.addAccount(deps.store.get('acc1'));
  app.addAccount(deps.store.get('acc2'));

  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(() => app.server.close());

  // Consulta anúncios de acc1
  const res = await fetch(`${baseUrl}/api/market/items-summary?accountId=acc1`, {
    headers: { 'X-PIW-Bridge': '1' }
  });
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.ok(data.summary['item:53']);
  assert.equal(data.summary['item:53'].minGold, 5200);

  const mine = data.mine;
  assert.equal(mine.length, 2);

  const fire = mine.find(m => m.id === 'listing_old_fire');
  assert.ok(fire, 'anuncio de Fire Stone deve estar presente');
  assert.equal(fire.isStale, true, 'anuncio com 48h deve ser marcado como isStale');
  assert.equal(fire.isUndercut, true, 'anuncio a 5800 com piso 5200 deve ser marcado como isUndercut');
  assert.equal(fire.currentMinPrice, 5200);
  assert.equal(fire.priceDiff, 600);
  assert.equal(fire.icon, '/assets/items/fire_stone.gif');

  const ancient = mine.find(m => m.id === 'listing_fresh_stone');
  assert.ok(ancient, 'anuncio de Ancient Stone deve estar presente');
  assert.equal(ancient.isStale, false, 'anuncio com 2h nao deve ser isStale');
  assert.equal(ancient.isUndercut, false, 'anuncio no menor preco nao deve ser isUndercut');
  assert.equal(ancient.currentMinPrice, 30);
  assert.equal(ancient.icon, '/assets/stones/ancient_stone.gif');

  // Consulta anúncios de acc2 (deve vir vazio, sem vazar os anúncios de acc1 por cache global)
  const res2 = await fetch(`${baseUrl}/api/market/items-summary?accountId=acc2`, {
    headers: { 'X-PIW-Bridge': '1' }
  });
  assert.equal(res2.status, 200);
  const data2 = await res2.json();
  assert.equal(data2.mine.length, 0, 'acc2 nao deve herdar os anuncios de acc1');
});
