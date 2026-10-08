'use strict';

/**
 * Calculadora e Simulador de Breeder para Poke Idle World
 * Baseado nas regras e fórmulas oficiais comprovadas da comunidade (PIWTools / PIWDex):
 * 1. Pais DEVEM ser da mesma espécie (pokeA.speciesId === pokeB.speciesId).
 * 2. Diferença máxima de Quality de 0.150 (|Q1 - Q2| <= 0.150).
 * 3. A distribuição INTEIRA de IVs é herdada do pai de MAIOR Quality (em empate, herda do Slot 1).
 *    IVs nunca são misturados ou calculados por média.
 * 4. Free Breeding: R$ 2.000.000 + 20 Stones (0 Pheromones).
 *    Ganhos: +0.005 (50%), +0.010 (35%), +0.020 (12%), +0.040 (3%). Ganho médio: +0.0096 Q.
 * 5. Strange Pheromone: R$ 2.000.000 + 20 Stones + 9 Pheromones.
 *    Ganhos: +0.150 (50%), +0.200 (30%), +0.250 (15%), +0.300 (5%). Ganho médio: +0.1875 Q.
 * 6. Teto de Quality de Pokémon Normal: 2.600.
 * 7. Double Stones: 40 Stones; 5% de chance de +1 IV aleatório em stat < 32.
 * 8. Shiny: herança de 100% se um dos pais for Shiny; 5% espontâneo se ambos normais.
 */

const IV_KEYS = ['hp', 'attack', 'defense', 'specialAttack', 'specialDefense', 'speed'];

const FREE_BONUSES = [
  { bonus: 0.005, probability: 0.50, label: '+0.005' },
  { bonus: 0.010, probability: 0.35, label: '+0.010' },
  { bonus: 0.020, probability: 0.12, label: '+0.020' },
  { bonus: 0.040, probability: 0.03, label: '+0.040' }
];

const PHEROMONE_BONUSES = [
  { bonus: 0.150, probability: 0.50, label: '+0.150' },
  { bonus: 0.200, probability: 0.30, label: '+0.200' },
  { bonus: 0.250, probability: 0.15, label: '+0.250' },
  { bonus: 0.300, probability: 0.05, label: '+0.300' }
];

const QUALITY_CAP_NORMAL = 2.600;

function round3(n) {
  return Math.round(Number(n || 0) * 1000) / 1000;
}

function getPokeTypes(poke, speciesCatalog) {
  if (Array.isArray(poke?.types) && poke.types.length) return poke.types;
  if (poke?.type1 || poke?.type2) return [poke.type1, poke.type2].filter(Boolean);
  if (speciesCatalog?.get && poke?.speciesId) {
    const sp = speciesCatalog.get(poke.speciesId);
    if (sp) return [sp.type1, sp.type2].filter(Boolean);
  }
  return [];
}

/**
 * Simula a cruza exata entre dois Pokémon no Poke Idle World
 */
function simulatePair(p1, p2, { mode = 'free', doubleStones = false, speciesCatalog = null } = {}) {
  if (!p1 || !p2) {
    return {
      valid: false,
      error: 'Selecione ambos os pais para simular.',
      warnings: []
    };
  }

  const s1 = Number(p1.speciesId || 0);
  const s2 = Number(p2.speciesId || 0);
  const name1 = String(p1.name || '').toLowerCase();
  const name2 = String(p2.name || '').toLowerCase();

  const sameSpecies = (s1 && s2 && s1 === s2) || (name1 && name2 && name1 === name2);
  if (!sameSpecies) {
    return {
      valid: false,
      error: 'Os pais precisam ser da mesma espécie no Poke Idle World.',
      warnings: []
    };
  }

  const q1 = round3(p1.quality != null ? p1.quality : 1.0);
  const q2 = round3(p2.quality != null ? p2.quality : 1.0);
  const diffQ = round3(Math.abs(q1 - q2));

  if (diffQ > 0.150001) {
    return {
      valid: false,
      error: `Diferença de Quality (${diffQ.toFixed(3)}) ultrapassa o limite de 0.150 permitido pelo jogo.`,
      qualityDifference: diffQ,
      warnings: []
    };
  }

  // Define quem doa os IVs (maior Quality vence; em empate herda do Slot 1)
  const inheritsFromSlot = q2 > q1 ? 2 : 1;
  const donor = inheritsFromSlot === 2 ? p2 : p1;
  const nonDonor = inheritsFromSlot === 2 ? p1 : p2;

  const warnings = [];
  if (q1 === q2) {
    warnings.push('Os pais têm exatamente a mesma Quality. O filhote herda a distribuição de IVs do Slot 1.');
  } else if (inheritsFromSlot === 2 && (p1.ivTotal || 0) > (p2.ivTotal || 0)) {
    warnings.push(`O Slot 2 possui maior Quality (Q ${q2.toFixed(3)} vs Q ${q1.toFixed(3)}) e substituirá a distribuição de IVs do Slot 1! O filhote herdará IV ${p2.ivTotal || 0} em vez de IV ${p1.ivTotal || 0}.`);
  }

  const baseQuality = round3(Math.max(q1, q2));
  const bonuses = mode === 'pheromone' ? PHEROMONE_BONUSES : FREE_BONUSES;
  const isShinyParent = Boolean(p1.shiny || p2.shiny);

  // Calcula cenários
  const scenarios = bonuses.map(b => {
    const rawQ = round3(baseQuality + b.bonus);
    const finalQ = round3(Math.min(rawQ, QUALITY_CAP_NORMAL));
    const capHit = rawQ > QUALITY_CAP_NORMAL;
    const wasted = round3(Math.max(0, rawQ - finalQ));
    return {
      bonus: b.bonus,
      label: b.label,
      probability: b.probability,
      percentage: Math.round(b.probability * 100),
      rawQuality: rawQ,
      finalQuality: finalQ,
      capHit,
      wasted
    };
  });

  const expectedBonus = mode === 'pheromone' ? 0.1875 : 0.0096;
  const expectedQuality = round3(scenarios.reduce((acc, s) => acc + (s.finalQuality * s.probability), 0));
  const minQuality = scenarios[0].finalQuality;
  const maxQuality = scenarios[scenarios.length - 1].finalQuality;

  // Custos em Stones e Pheromones
  const types = getPokeTypes(donor, speciesCatalog);
  const stoneTotal = doubleStones ? 40 : 20;
  const stones = [];
  if (types.length === 1) {
    stones.push({ type: types[0], quantity: stoneTotal });
  } else if (types.length >= 2) {
    stones.push({ type: types[0], quantity: stoneTotal / 2 });
    stones.push({ type: types[1], quantity: stoneTotal / 2 });
  } else {
    stones.push({ type: 'Stone da Espécie', quantity: stoneTotal });
  }

  const pheromoneCost = mode === 'pheromone' ? 9 : 0;

  // IVs herdados e chance de bônus por Double Stones
  const inheritedIvs = {
    hp: donor.ivHp ?? donor.ivs?.hp ?? 0,
    attack: donor.ivAttack ?? donor.ivs?.attack ?? 0,
    defense: donor.ivDefense ?? donor.ivs?.defense ?? 0,
    specialAttack: donor.ivSpecialAttack ?? donor.ivs?.specialAttack ?? 0,
    specialDefense: donor.ivSpecialDefense ?? donor.ivs?.specialDefense ?? 0,
    speed: donor.ivSpeed ?? donor.ivs?.speed ?? 0
  };

  const eligibleForIvBonus = doubleStones && Object.values(inheritedIvs).some(v => v < 32);

  return {
    valid: true,
    qualityDifference: diffQ,
    inheritsFromSlot,
    donorRole: inheritsFromSlot === 1 ? 'Slot 1' : 'Slot 2',
    donorName: donor.name,
    donorQuality: inheritsFromSlot === 1 ? q1 : q2,
    donorIvTotal: donor.ivTotal || 0,
    inheritedIvs,
    baseQuality,
    mode,
    doubleStones,
    scenarios,
    minQuality,
    expectedQuality,
    maxQuality,
    expectedGain: round3(expectedQuality - baseQuality),
    costs: {
      gold: 2000000,
      stones,
      pheromones: pheromoneCost
    },
    doubleStonesIvChance: eligibleForIvBonus ? 0.05 : 0,
    childIsShiny: isShinyParent,
    shinyChance: isShinyParent ? 1.0 : 0.05,
    warnings
  };
}

/**
 * Analisa toda a coleção da conta e gera os melhores pares compatíveis,
 * pares quase compatíveis e matrizes solitárias.
 */
function calculateBreederMatchups({ collection = [], species = null, minMatrizIv = 150, minGoodQuality = 1.60 } = {}) {
  const pokes = (collection || []).filter(p => p && (p.speciesId || p.name));
  const bySpecies = new Map();

  for (const p of pokes) {
    const spKey = p.speciesId ? String(p.speciesId) : String(p.name || '').toLowerCase();
    if (!bySpecies.has(spKey)) {
      bySpecies.set(spKey, []);
    }
    bySpecies.get(spKey).push(p);
  }

  const readyPairs = [];
  const nearPairs = [];
  const soloMatrizes = [];

  let totalMatrizes = 0;
  let totalHighQ = 0;

  for (const [spKey, members] of bySpecies.entries()) {
    const baseSpecies = species?.get ? species.get(members[0]?.speciesId) : null;
    const speciesName = baseSpecies?.name || members[0]?.name || `Espécie #${spKey}`;
    const speciesId = members[0]?.speciesId || spKey;

    // Estatísticas da espécie
    for (const m of members) {
      if ((m.ivTotal || 0) >= minMatrizIv) totalMatrizes++;
      if ((m.quality || 0) >= minGoodQuality) totalHighQ++;
    }

    if (members.length >= 2) {
      // Ordena por Quality decrescente
      const sorted = [...members].sort((a, b) => (b.quality || 0) - (a.quality || 0));

      // Testa pares entre os membros da mesma espécie
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const pA = sorted[i];
          const pB = sorted[j];
          const qA = round3(pA.quality || 1.0);
          const qB = round3(pB.quality || 1.0);
          const diff = round3(Math.abs(qA - qB));

          if (diff <= 0.150001) {
            // Par 100% Compatível!
            const simFree = simulatePair(pA, pB, { mode: 'free', speciesCatalog: species });
            const simPhero = simulatePair(pA, pB, { mode: 'pheromone', speciesCatalog: species });

            // Define estrelas/classificação
            const maxIv = Math.max(pA.ivTotal || 0, pB.ivTotal || 0);
            const donorIv = simFree.donorIvTotal;
            const donorQ = simFree.donorQuality;

            let tier = 'COMPATÍVEL';
            let stars = 1;

            if (donorIv >= 160 && donorQ >= 1.65) {
              tier = 'PERFEITO';
              stars = 3;
            } else if (donorIv >= 150 || donorQ >= 1.55) {
              tier = 'EXCELENTE';
              stars = 2;
            }

            readyPairs.push({
              speciesId,
              speciesName,
              diffQuality: diff,
              stars,
              tier,
              parentA: {
                id: pA.id,
                speciesId: pA.speciesId,
                name: pA.name,
                level: pA.level,
                ivTotal: pA.ivTotal || 0,
                quality: qA,
                shiny: Boolean(pA.shiny)
              },
              parentB: {
                id: pB.id,
                speciesId: pB.speciesId,
                name: pB.name,
                level: pB.level,
                ivTotal: pB.ivTotal || 0,
                quality: qB,
                shiny: Boolean(pB.shiny)
              },
              simFree,
              simPhero,
              score: (donorIv * 2) + (donorQ * 100) - (diff * 50)
            });
          } else if (diff <= 0.350) {
            // Quase compatível (precisa de ponte)
            nearPairs.push({
              speciesId,
              speciesName,
              diffQuality: diff,
              parentA: {
                id: pA.id,
                speciesId: pA.speciesId,
                name: pA.name,
                level: pA.level,
                ivTotal: pA.ivTotal || 0,
                quality: qA,
                shiny: Boolean(pA.shiny)
              },
              parentB: {
                id: pB.id,
                speciesId: pB.speciesId,
                name: pB.name,
                level: pB.level,
                ivTotal: pB.ivTotal || 0,
                quality: qB,
                shiny: Boolean(pB.shiny)
              },
              bridgeNeeded: round3((qA + qB) / 2),
              reason: `Diferença de ${diff.toFixed(3)} Q ultrapassa 0.150. Um parceiro intermediário de Q ~${round3((qA + qB) / 2).toFixed(3)} viabilizaria a progressão.`
            });
          }
        }
      }
    } else if (members.length === 1) {
      const solo = members[0];
      if ((solo.ivTotal || 0) >= minMatrizIv || (solo.quality || 0) >= minGoodQuality) {
        soloMatrizes.push({
          speciesId,
          speciesName,
          pokemon: {
            id: solo.id,
            speciesId: solo.speciesId,
            name: solo.name,
            level: solo.level,
            ivTotal: solo.ivTotal || 0,
            quality: round3(solo.quality || 1.0),
            shiny: Boolean(solo.shiny)
          },
          targetQualityMin: round3(Math.max(1.0, (solo.quality || 1.0) - 0.150)),
          targetQualityMax: round3((solo.quality || 1.0) + 0.150),
          reason: `Exemplar forte (IV ${solo.ivTotal || 0} · Q ${(solo.quality || 1.0).toFixed(3)}). Falta segundo exemplar da mesma espécie com Q entre ${round3(Math.max(1.0, (solo.quality || 1.0) - 0.150)).toFixed(3)} e ${round3((solo.quality || 1.0) + 0.150).toFixed(3)}.`
        });
      }
    }
  }

  // Ordena os pares por score decrescente
  readyPairs.sort((a, b) => b.score - a.score);
  nearPairs.sort((a, b) => a.diffQuality - b.diffQuality);
  soloMatrizes.sort((a, b) => ((b.pokemon.ivTotal || 0) + (b.pokemon.quality || 0) * 100) - ((a.pokemon.ivTotal || 0) + (a.pokemon.quality || 0) * 100));

  return {
    summary: {
      totalPokes: pokes.length,
      totalSpecies: bySpecies.size,
      totalMatrizes,
      totalHighQ,
      readyPairsCount: readyPairs.length,
      nearPairsCount: nearPairs.length,
      soloMatrizesCount: soloMatrizes.length,
      perfectPairsCount: readyPairs.filter(p => p.stars === 3).length
    },
    readyPairs,
    nearPairs,
    soloMatrizes
  };
}

module.exports = {
  simulatePair,
  calculateBreederMatchups,
  FREE_BONUSES,
  PHEROMONE_BONUSES,
  QUALITY_CAP_NORMAL
};
