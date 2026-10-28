'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { simulatePair, calculateBreederMatchups } = require('../breeder.js');

test('Breeder v1.9: blocks starter and Ditto from breeding and filters them out of matchups', () => {
  const starterA = { id: '1', speciesId: 4, name: 'Charmander', quality: 1.5, ivTotal: 160, starter: true };
  const normalB = { id: '2', speciesId: 4, name: 'Charmander', quality: 1.5, ivTotal: 150, starter: false };
  const dittoA = { id: '3', speciesId: 132, name: 'Ditto', quality: 1.8, ivTotal: 170, isDitto: true };
  const dittoB = { id: '4', speciesId: 132, name: 'Ditto', quality: 1.8, ivTotal: 165, isDitto: true };

  const simStarter = simulatePair(starterA, normalB);
  assert.equal(simStarter.valid, false);
  assert.match(simStarter.error, /Starter/i);

  const simDitto = simulatePair(dittoA, dittoB);
  assert.equal(simDitto.valid, false);
  assert.match(simDitto.error, /Ditto/i);

  const matchups = calculateBreederMatchups({
    collection: [starterA, normalB, dittoA, dittoB]
  });
  assert.equal(matchups.readyPairs.length, 0);
  // Only normalB should be considered in soloMatrizes (since starterA and Dittos are excluded)
  assert.equal(matchups.soloMatrizes.length, 1);
  assert.equal(matchups.soloMatrizes[0].pokemon.id, '2');
});

test('Breeder v1.9: two normal parents never produce spontaneous shiny (0% chance)', () => {
  const p1 = {
    id: '10',
    speciesId: 25,
    name: 'Pikachu',
    quality: 1.70,
    ivTotal: 158,
    shiny: false,
    stats: { hp: 310, atk: 190, def: 140, spAtk: 180, spDef: 160, speed: 250 }
  };
  const p2 = {
    id: '11',
    speciesId: 25,
    name: 'Pikachu',
    quality: 1.60,
    ivTotal: 140,
    shiny: false
  };

  const sim = simulatePair(p1, p2, { mode: 'free', doubleStones: true });
  assert.equal(sim.valid, true);
  assert.equal(sim.childIsShiny, false);
  assert.equal(sim.shinyChance, 0);
  assert.equal(sim.inheritsFromSlot, 1);
  assert.equal(sim.donorIvTotal, 158);
  assert.equal(sim.ivBumpPossible, true);
  assert.equal(sim.doubleStonesIvChance, 0.05);
  assert.deepEqual(sim.donorStats, { hp: 310, atk: 190, def: 140, spAtk: 180, spDef: 160, speed: 250 });
});

test('Breeder v1.9: shiny parent forces pheromone mode, guarantees shiny child, and always donates IVs & base Quality (partnerExcess)', () => {
  const shinyParent = {
    id: '20',
    speciesId: 129,
    name: 'Magikarp',
    quality: 1.40,
    ivTotal: 145,
    shiny: true
  };
  const lowPartner = {
    id: '21',
    speciesId: 129,
    name: 'Magikarp',
    quality: 1.45,
    ivTotal: 170,
    shiny: false
  };
  const highPartner = {
    id: '22',
    speciesId: 129,
    name: 'Magikarp',
    quality: 1.75,
    ivTotal: 180,
    shiny: false
  };

  // Partner below 1.60 is rejected when breeding with a Shiny
  const badSim = simulatePair(shinyParent, lowPartner, { mode: 'free' });
  assert.equal(badSim.valid, false);
  assert.match(badSim.error, /1\.60/);

  // Partner >= 1.60 is accepted even if |Q1 - Q2| > 0.150, and Shiny parent is ALWAYS the donor
  const goodSim = simulatePair(shinyParent, highPartner, { mode: 'free' });
  assert.equal(goodSim.valid, true);
  assert.equal(goodSim.mode, 'pheromone');
  assert.equal(goodSim.freeAllowed, false);
  assert.equal(goodSim.childIsShiny, true);
  assert.equal(goodSim.shinyChance, 1.0);
  assert.equal(goodSim.inheritsFromSlot, 1);
  assert.equal(goodSim.baseQuality, 1.40);
  assert.equal(goodSim.donorIvTotal, 145);
  assert.ok(goodSim.partnerExcess);
  assert.equal(goodSim.partnerExcess.excess, 0.35);
});
