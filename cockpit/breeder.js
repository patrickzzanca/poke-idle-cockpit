'use strict';

/**
 * Calculadora e Simulador de Breeder para Poke Idle World (v1.9+)
 * Baseado nas regras e fórmulas oficiais do Breeding Center do jogo:
 * 1. Pais DEVEM ser da mesma espécie (pokeA.speciesId === pokeB.speciesId).
 * 2. Pokémon Iniciais (Starter) e Ditto (#132) NÃO podem cruzar.
 * 3. Dois pais normais: diferença máxima de Quality de 0.150 (|Q1 - Q2| <= 0.150).
 *    Herança de IVs e Quality Base vem do pai de MAIOR Quality (em empate, herda do Slot 1).
 * 4. Com Shiny no par:
 *    - Feromônios são obrigatórios (Free Breeding bloqueado).
 *    - Filhote é 100% Shiny garantido.
 *    - O pai Shiny SEMPRE transfere seus IVs e sua Quality base (se o parceiro não-Shiny tiver
 *      Quality maior que o Shiny, o excedente é ignorado — partnerExcess).
 *    - Se apenas 1 pai for Shiny, o parceiro precisa ter Quality mínima (Q >= 1.60).
 * 5. Dois pais normais NUNCA geram filhote Shiny espontaneamente (0% chance).
 * 6. Free Breeding: R$ 2.000.000 + 20 Stones (0 Pheromones).
 *    Ganhos: +0.005 (50%), +0.010 (35%), +0.020 (12%), +0.040 (3%). Ganho médio: +0.0096 Q.
 * 7. Strange Pheromone: R$ 2.000.000 + 20 Stones + 9 Pheromones.
 *    Ganhos: +0.150 (50%), +0.200 (30%), +0.250 (15%), +0.300 (5%). Ganho médio: +0.1875 Q.
 * 8. Teto de Quality de Pokémon Normal: 2.600.
 * 9. Double Stones: 40 Stones; 5% de chance de +1 IV se ivTotal < 192.
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
const SHINY_PARTNER_MIN_QUALITY = 1.600;

function round3(n) {
  return Math.round(Number(n || 0) * 1000) / 1000;
}

function isBreedablePoke(poke) {
  if (!poke) return false;
  if (poke.starter) return false;
  if (poke.isDitto || Number(poke.speciesId) === 132 || String(poke.name || '').toLowerCase() === 'ditto') return false;
  return Boolean(poke.speciesId || poke.name);
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

  if (p1.starter || p2.starter) {
    return {
      valid: false,
      error: 'Pokémon inicial (Starter) não pode cruzar na Creche.',
      warnings: []
    };
  }

  if (p1.isDitto || p2.isDitto || Number(p1.speciesId) === 132 || Number(p2.speciesId) === 132) {
    return {
      valid: false,
      error: 'Ditto não pode cruzar na Creche.',
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
  const shiny1 = Boolean(p1.shiny);
  const shiny2 = Boolean(p2.shiny);
  const isShinyParent = shiny1 || shiny2;

  if (!isShinyParent) {
    if (diffQ > 0.150001) {
      return {
        valid: false,
        error: `Diferença de Quality (${diffQ.toFixed(3)}) ultrapassa o limite de 0.150 permitido pelo jogo.`,
        qualityDifference: diffQ,
        warnings: []
      };
    }
  } else if (shiny1 !== shiny2) {
    // Apenas um dos pais é Shiny: parceiro normal precisa de Quality mínima (>= 1.600)
    const partnerQ = shiny1 ? q2 : q1;
    if (partnerQ + 0.0001 < SHINY_PARTNER_MIN_QUALITY) {
      return {
        valid: false,
        error: `Para cruzar com um Shiny, o parceiro precisa ter Quality mínima de ×${SHINY_PARTNER_MIN_QUALITY.toFixed(2)} (atual: ×${partnerQ.toFixed(3)}).`,
        qualityDifference: diffQ,
        warnings: []
      };
    }
  } else {
    // Ambos são Shiny: aplica regra de diferença de Quality <= 0.150
    if (diffQ > 0.150001) {
      return {
        valid: false,
        error: `Diferença de Quality entre os dois Shinies (${diffQ.toFixed(3)}) ultrapassa o limite de 0.150.`,
        qualityDifference: diffQ,
        warnings: []
      };
    }
  }

  // Define quem doa os IVs e a Quality base:
  // Se apenas um for Shiny, o Shiny SEMPRE é o doador de IVs e Quality base!
  let inheritsFromSlot;
  let partnerExcess = null;
  if (shiny1 && !shiny2) {
    inheritsFromSlot = 1;
    if (q2 > q1) {
      partnerExcess = { shinyQuality: q1, partnerQuality: q2, excess: round3(q2 - q1) };
    }
  } else if (shiny2 && !shiny1) {
    inheritsFromSlot = 2;
    if (q1 > q2) {
      partnerExcess = { shinyQuality: q2, partnerQuality: q1, excess: round3(q1 - q2) };
    }
  } else {
    inheritsFromSlot = q2 > q1 ? 2 : 1;
  }

  const donor = inheritsFromSlot === 2 ? p2 : p1;
  const donorQuality = inheritsFromSlot === 2 ? q2 : q1;

  // Com Shiny no par, Feromônios são obrigatórios no jogo (Free Breeding bloqueado)
  const effectiveMode = isShinyParent ? 'pheromone' : mode;
  const freeAllowed = !isShinyParent;

  const warnings = [];
  if (isShinyParent && mode === 'free') {
    warnings.push('Cruzas com Shiny exigem Feromônios obrigatoriamente (modo ajustado para Strange Pheromones).');
  }
  if (partnerExcess) {
    warnings.push(`Parceiro acima da Quality do Shiny (×${partnerExcess.partnerQuality.toFixed(3)} > ×${partnerExcess.shinyQuality.toFixed(3)}) — o excedente (+${partnerExcess.excess.toFixed(3)}) é ignorado e o filhote usa a Quality base do Shiny (×${partnerExcess.shinyQuality.toFixed(3)}).`);
  } else if (!isShinyParent && q1 === q2) {
    warnings.push('Os pais têm exatamente a mesma Quality. O filhote herda a distribuição de IVs do Slot 1.');
  } else if (!isShinyParent && inheritsFromSlot === 2 && (p1.ivTotal || 0) > (p2.ivTotal || 0)) {
    warnings.push(`O Slot 2 possui maior Quality (Q ${q2.toFixed(3)} vs Q ${q1.toFixed(3)}) e substituirá a distribuição de IVs do Slot 1! O filhote herdará IV ${p2.ivTotal || 0} em vez de IV ${p1.ivTotal || 0}.`);
  }

  const baseQuality = donorQuality;
  const bonuses = effectiveMode === 'pheromone' ? PHEROMONE_BONUSES : FREE_BONUSES;

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

  const pheromoneCost = effectiveMode === 'pheromone' ? 9 : 0;

  // IVs herdados (individual se disponível ou via ivTotal + stats reais do servidor)
  const hasIndividualIvs = donor.ivHp != null || donor.ivs?.hp != null;
  const inheritedIvs = hasIndividualIvs ? {
    hp: donor.ivHp ?? donor.ivs?.hp ?? 0,
    attack: donor.ivAttack ?? donor.ivs?.attack ?? 0,
    defense: donor.ivDefense ?? donor.ivs?.defense ?? 0,
    specialAttack: donor.ivSpecialAttack ?? donor.ivs?.specialAttack ?? 0,
    specialDefense: donor.ivSpecialDefense ?? donor.ivs?.specialDefense ?? 0,
    speed: donor.ivSpeed ?? donor.ivs?.speed ?? 0
  } : null;

  const donorStats = donor.stats ? {
    hp: donor.stats.hp ?? 0,
    atk: donor.stats.atk ?? donor.stats.attack ?? 0,
    def: donor.stats.def ?? donor.stats.defense ?? 0,
    spAtk: donor.stats.spAtk ?? donor.stats.specialAttack ?? 0,
    spDef: donor.stats.spDef ?? donor.stats.specialDefense ?? 0,
    speed: donor.stats.speed ?? 0
  } : null;

  const donorIvTotal = Number(donor.ivTotal || 0);
  const ivBumpPossible = donorIvTotal < 192;
  const eligibleForIvBonus = doubleStones && ivBumpPossible;

  return {
    valid: true,
    qualityDifference: diffQ,
    inheritsFromSlot,
    donorRole: inheritsFromSlot === 1 ? 'Slot 1' : 'Slot 2',
    donorName: donor.name,
    donorQuality,
    donorIvTotal,
    inheritedIvs,
    donorStats,
    ivBumpPossible,
    partnerExcess,
    freeAllowed,
    baseQuality,
    mode: effectiveMode,
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
    shinyChance: isShinyParent ? 1.0 : 0.0,
    warnings
  };
}

/**
 * Analisa toda a coleção da conta e gera os melhores pares compatíveis,
 * pares quase compatíveis e matrizes solitárias.
 */
function calculateBreederMatchups({ collection = [], species = null, minMatrizIv = 150, minGoodQuality = 1.60 } = {}) {
  const pokes = (collection || []).filter(isBreedablePoke);
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
      // Ordena por Quality decrescente e, em empate, maior IV primeiro
      const sorted = [...members].sort((a, b) => ((b.quality || 0) - (a.quality || 0)) || ((b.ivTotal || 0) - (a.ivTotal || 0)));
      const speciesReady = [];
      const speciesNear = [];

      // Testa pares entre os membros da mesma espécie (limitando aos 30 melhores exemplares da espécie para evitar explosão combinatória)
      const candidates = sorted.slice(0, 30);
      for (let i = 0; i < candidates.length; i++) {
        for (let j = i + 1; j < candidates.length; j++) {
          const pA = candidates[i];
          const pB = candidates[j];
          const qA = round3(pA.quality || 1.0);
          const qB = round3(pB.quality || 1.0);
          const diff = round3(Math.abs(qA - qB));
          const hasShiny = Boolean(pA.shiny || pB.shiny);
          const oneShiny = Boolean(pA.shiny) !== Boolean(pB.shiny);

          const simTest = simulatePair(pA, pB, { mode: hasShiny ? 'pheromone' : 'free', speciesCatalog: species });

          if (simTest.valid) {
            // Par 100% Compatível!
            const simFree = hasShiny ? null : simTest;
            const simPhero = hasShiny ? simTest : simulatePair(pA, pB, { mode: 'pheromone', speciesCatalog: species });
            const mainSim = simFree || simPhero;

            const donorIv = mainSim.donorIvTotal;
            const donorQ = mainSim.donorQuality;

            let tier = 'COMPATÍVEL';
            let stars = 1;

            if ((donorIv >= 160 && donorQ >= 1.65) || hasShiny) {
              tier = hasShiny ? 'SHINY PRONTO' : 'PERFEITO';
              stars = 3;
            } else if (donorIv >= 150 || donorQ >= 1.55) {
              tier = 'EXCELENTE';
              stars = 2;
            }

            speciesReady.push({
              speciesId,
              speciesName,
              diffQuality: diff,
              stars,
              tier,
              hasShiny,
              parentA: {
                id: pA.id,
                speciesId: pA.speciesId,
                name: pA.name,
                level: pA.level,
                ivTotal: pA.ivTotal || 0,
                quality: qA,
                shiny: Boolean(pA.shiny),
                breedingBox: Boolean(pA.breedingBox),
                stats: pA.stats || null
              },
              parentB: {
                id: pB.id,
                speciesId: pB.speciesId,
                name: pB.name,
                level: pB.level,
                ivTotal: pB.ivTotal || 0,
                quality: qB,
                shiny: Boolean(pB.shiny),
                breedingBox: Boolean(pB.breedingBox),
                stats: pB.stats || null
              },
              simFree,
              simPhero,
              score: (hasShiny ? 500 : 0) + (donorIv * 2) + (donorQ * 100) - (diff * 50)
            });
          } else if ((!oneShiny && diff <= 0.350) || (oneShiny && Math.max(qA, qB) >= 1.35)) {
            // Quase compatível (precisa de ponte ou elevar parceiro)
            const reason = oneShiny
              ? simTest.error
              : `Diferença de ${diff.toFixed(3)} Q ultrapassa 0.150. Um parceiro intermediário de Q ~${round3((qA + qB) / 2).toFixed(3)} viabilizaria a progressão.`;
            speciesNear.push({
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
                shiny: Boolean(pA.shiny),
                breedingBox: Boolean(pA.breedingBox)
              },
              parentB: {
                id: pB.id,
                speciesId: pB.speciesId,
                name: pB.name,
                level: pB.level,
                ivTotal: pB.ivTotal || 0,
                quality: qB,
                shiny: Boolean(pB.shiny),
                breedingBox: Boolean(pB.breedingBox)
              },
              bridgeNeeded: round3((qA + qB) / 2),
              reason
            });
          }
        }
      }

      // Seleciona até 5 melhores pares únicos (sem repetir o mesmo Pokémon em dezenas de cards redundantes)
      speciesReady.sort((a, b) => b.score - a.score);
      const usedReadyIds = new Set();
      let addedForSpecies = 0;
      for (const pair of speciesReady) {
        if (addedForSpecies >= 5) break;
        const idA = String(pair.parentA.id);
        const idB = String(pair.parentB.id);
        if (usedReadyIds.has(idA) && usedReadyIds.has(idB)) continue;
        usedReadyIds.add(idA);
        usedReadyIds.add(idB);
        readyPairs.push(pair);
        addedForSpecies++;
      }

      speciesNear.sort((a, b) => a.diffQuality - b.diffQuality);
      nearPairs.push(...speciesNear.slice(0, 3));
    } else if (members.length === 1) {
      const solo = members[0];
      if ((solo.ivTotal || 0) >= minMatrizIv || (solo.quality || 0) >= minGoodQuality || solo.shiny) {
        const isShiny = Boolean(solo.shiny);
        const minQ = isShiny ? SHINY_PARTNER_MIN_QUALITY : round3(Math.max(1.0, (solo.quality || 1.0) - 0.150));
        const maxQ = isShiny ? QUALITY_CAP_NORMAL : round3((solo.quality || 1.0) + 0.150);
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
            shiny: isShiny,
            breedingBox: Boolean(solo.breedingBox)
          },
          targetQualityMin: minQ,
          targetQualityMax: maxQ,
          reason: isShiny
            ? `Shiny solitário (IV ${solo.ivTotal || 0} · Q ${(solo.quality || 1.0).toFixed(3)}). Precisa de parceiro da mesma espécie com Q ≥ ${minQ.toFixed(2)}.`
            : `Exemplar forte (IV ${solo.ivTotal || 0} · Q ${(solo.quality || 1.0).toFixed(3)}). Falta segundo exemplar da mesma espécie com Q entre ${minQ.toFixed(3)} e ${maxQ.toFixed(3)}.`
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
