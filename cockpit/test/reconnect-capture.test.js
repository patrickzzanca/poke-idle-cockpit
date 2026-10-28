'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Account } = require('../account.js');
const { createApp } = require('../server.js');
const { buildSpeciesIndex } = require('../../shared/species.js');

test('Account Collection Sync vs Capture Events', async (t) => {
  const account = new Account({
    record: { id: 'test_acc', name: 'Tester', tokens: { accessToken: 'a', refreshToken: 'b' } },
    api: {},
    onTokens: () => {}
  });

  const captures = [];
  account.on('capture', ev => captures.push(ev));

  // Simula conexão: primeiro chega a mensagem 'pokes' com os 6 Pokémon do time
  const party = [
    { id: 'poke_1', speciesId: 1, name: 'Bulbasaur', team: true, quality: 1.72, ivTotal: 155 },
    { id: 'poke_2', speciesId: 4, name: 'Charmander', team: true, quality: 1.75, ivTotal: 152 },
    { id: 'poke_3', speciesId: 7, name: 'Squirtle', team: true, quality: 1.80, ivTotal: 160 }
  ];
  account.applyPokes(party);

  assert.equal(captures.length, 0, 'primeiro lote de pokes (time) nao deve emitir captura');

  // Em seguida, o jogo entrega a montagem completa da box via pokes-chunk (ex: centenas de pokes)
  const fullBox = [
    ...party,
    { id: 'poke_4', speciesId: 16, name: 'Pidgey', quality: 1.71, ivTotal: 151 },
    { id: 'poke_5', speciesId: 19, name: 'Rattata', quality: 1.75, ivTotal: 158 },
    { id: 'poke_6', speciesId: 25, name: 'Pikachu', quality: 1.80, ivTotal: 165 }
  ];
  account.applyPokes(fullBox);

  // CRÍTICO: applyPokes NÃO deve emitir captura para Pokémon já existentes na box da conta!
  assert.equal(captures.length, 0, 'applyPokes nao deve emitir captura para pokemons existentes ao montar chunks/box');

  // Agora simula uma captura REAL em tempo de execucao (via poke-delta)
  const realCatch = {
    id: 'poke_new_catch',
    speciesId: 133,
    name: 'Eevee',
    quality: 1.76,
    ivTotal: 154
  };
  account.applyDelta(realCatch);

  assert.equal(captures.length, 1, 'poke-delta de novo pokemon deve emitir captura');
  assert.equal(captures[0].poke.id, 'poke_new_catch');
});

test('Highlight Criteria: Quality >= 1.70 e IV >= 150', async (t) => {
  const store = {
    config: {
      tags: {},
      alerts: {},
      highlight: { minQuality: 1.7, minIv: 150 }
    },
    warnings: [],
    list: () => [{ id: 'acc1', name: 'Tester', tokens: { accessToken: 'a', refreshToken: 'b' } }],
    get: () => ({ id: 'acc1', name: 'Tester', tokens: { accessToken: 'a', refreshToken: 'b' } }),
    upsert: () => {},
    remove: () => {},
    getCmid: () => null,
    setCmid: () => false,
    getWishlist: () => [],
    getCustomPresets: () => [],
    getTickerHistory: () => ({ diamonds: [], pheromones: [] })
  };

  const api = {
    me: async () => ({ character: { id: 'acc1', name: 'Tester' } }),
    refresh: async () => ({ accessToken: 'a2', refreshToken: 'b2' })
  };

  const species = buildSpeciesIndex([
    { pokeId: 10, name: 'Caterpie' },
    { pokeId: 25, name: 'Pikachu' },
    { pokeId: 132, name: 'Ditto' },
    { pokeId: 133, name: 'Eevee' },
    { pokeId: 147, name: 'Dratini' }
  ]);
  const itemsCatalog = { list: [], byId: new Map(), get: () => null };

  const app = createApp({ store, api, species, itemsCatalog });
  const acc = app.addAccount(store.get('acc1'));

  // Inicializa colecao com poke basico
  acc.applyPokes([{ id: 'starter', speciesId: 10, name: 'Caterpie', level: 5, quality: 1.0, ivTotal: 80 }]);

  const capturedPokes = [
    // Caso 1: Q boa (1.75), mas IV baixo (140) -> NAO deve ser highlight
    { id: 'c1', speciesId: 25, name: 'Pikachu', level: 10, quality: 1.75, ivTotal: 140 },
    // Caso 2: IV alto (160), mas Q baixa (1.65) -> NAO deve ser highlight
    { id: 'c2', speciesId: 133, name: 'Eevee', level: 10, quality: 1.65, ivTotal: 160 },
    // Caso 3: Q no limite (1.70) e IV no limite (150) -> DEVE ser highlight
    { id: 'c3', speciesId: 147, name: 'Dratini', level: 10, quality: 1.70, ivTotal: 150 },
    // Caso 4: Q alta (1.82) e IV alto (158) -> DEVE ser highlight
    { id: 'c4', speciesId: 147, name: 'Dratini Top', level: 10, quality: 1.82, ivTotal: 158 }
  ];

  for (const poke of capturedPokes) {
    acc.applyDelta(poke);
  }

  // Acessa os highlights da sessao no app
  const sessionHighlights = app.highlights || [];
  const highlightedIds = sessionHighlights.map(h => h.poke.id);

  assert.ok(!highlightedIds.includes('c1'), 'Q 1.75 e IV 140 nao deve ser highlight (IV < 150)');
  assert.ok(!highlightedIds.includes('c2'), 'Q 1.65 e IV 160 nao deve ser highlight (Q < 1.70)');
  assert.ok(highlightedIds.includes('c3'), 'Q 1.70 e IV 150 deve ser highlight');
  assert.ok(highlightedIds.includes('c4'), 'Q 1.82 e IV 158 deve ser highlight');
});
