// Índice das espécies a partir do /game/creatures.json do jogo.
// UMD: funciona no Node (require) e no navegador (window.PIWSpecies).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PIWSpecies = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STATS = [
    ['baseHp', 'HP'], ['baseAtk', 'Ataque'], ['baseDef', 'Defesa'],
    ['baseSpAtk', 'Atq. Esp.'], ['baseSpDef', 'Def. Esp.'], ['baseSpeed', 'Velocidade']
  ];

  function nameKey(name) {
    return String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/^✨\s*/, '').replace(/^shiny\s+/, '')
      .replaceAll('♀', 'f').replaceAll('♂', 'm').replace(/[^a-z0-9]/g, '');
  }

  function buildSpeciesIndex(creatures) {
    const byId = new Map();
    const byName = new Map();
    const parent = new Map();
    for (const c of creatures ?? []) {
      byId.set(Number(c.pokeId), c);
      byName.set(nameKey(c.name), c);
    }
    for (const c of creatures ?? []) {
      const next = Number(c.evolvesToId);
      if (next > 0 && byId.has(next) && !parent.has(next)) parent.set(next, Number(c.pokeId));
    }

    function get(id) { return byId.get(Number(id)) ?? null; }

    function familyOf(id) {
      let current = Number(id);
      const seen = new Set();
      while (parent.has(current) && !seen.has(current)) {
        seen.add(current);
        current = parent.get(current);
      }
      return current;
    }

    function profile(id) {
      const c = get(id);
      if (!c) return null;
      const damaging = (c.attacks ?? []).filter(a => a.power > 0);
      const physical = damaging.filter(a => a.category === 'PHYSICAL').length;
      const special = damaging.filter(a => a.category === 'SPECIAL').length;
      const category = physical > special * 1.5 ? 'physical' : special > physical * 1.5 ? 'special' : 'mixed';
      const stats = STATS.map(([key, label]) => ({ key, label, value: c[key] ?? 0 }));
      const sorted = [...stats].sort((a, b) => b.value - a.value);
      return {
        name: c.name,
        types: [c.type1, c.type2].filter(Boolean).map(t => String(t).toLowerCase()),
        category,
        best: sorted[0].label,
        worst: sorted[sorted.length - 1].label,
        baseTotal: stats.reduce((sum, s) => sum + s.value, 0),
        family: get(familyOf(id))?.name ?? c.name
      };
    }

    return { get, byName: name => byName.get(nameKey(name)) ?? null, familyOf, profile, size: byId.size };
  }

  return { buildSpeciesIndex, nameKey };
});
