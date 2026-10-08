// Tags unificadas (IV primeiro). Usado pelo cockpit, pelo mercado e pelo userscript.
// UMD: funciona no Node (require) e no navegador (window.PIWClassifier).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PIWClassifier = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_CONFIG = Object.freeze({
    raroQuality: 1.7, topIv: 170, matrizIv: 165,
    uparIv: 145, uparQuality: 1.5, lixoIv: 130, lixoQuality: 1.5
  });

  const TAGS = Object.freeze({
    raro: { label: '💎 Raro', short: '💎', color: '#f0b71e' },
    top: { label: '⭐ Top', short: '⭐', color: '#f6d66d' },
    matriz: { label: '🧬 Matriz', short: '🧬', color: '#d8a9ff' },
    upar: { label: '⬆ Upar', short: '⬆', color: '#75dca8' },
    lixo: { label: '🗑 Lixo', short: '🗑', color: '#9aa6b3' }
  });
  const TAG_ORDER = ['raro', 'top', 'matriz', 'upar', 'lixo'];

  function num(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function normalizePoke(raw) {
    if (!raw || typeof raw !== 'object') return null;
    let ivTotal = num(raw.ivTotal ?? raw.totalIv);
    if (ivTotal == null && raw.ivs && typeof raw.ivs === 'object') {
      const values = Object.values(raw.ivs).map(num);
      if (values.length === 6 && values.every(v => v != null)) ivTotal = values.reduce((a, b) => a + b, 0);
    }
    return {
      id: raw.id ?? null,
      speciesId: num(raw.speciesId ?? raw.pokeId ?? raw.dexId),
      name: String(raw.name ?? ''),
      level: num(raw.level),
      quality: num(raw.quality),
      ivTotal,
      power: num(raw.power),
      sellValue: num(raw.sellValue),
      shiny: Boolean(raw.shiny || raw.isShiny || raw.rarity === 'shiny' || (raw.name && /shiny|✨/i.test(raw.name))),
      isDitto: Boolean(raw.isDitto),
      team: Boolean(raw.team),
      starter: Boolean(raw.starter),
      locked: Boolean(raw.locked)
    };
  }

  function isBetter(a, b) {
    if (!b) return true;
    if (a.ivTotal !== b.ivTotal) return a.ivTotal > b.ivTotal;
    return (a.quality ?? 0) > (b.quality ?? 0);
  }

  function bestByFamily(collection, familyOf) {
    const best = new Map();
    for (const p of collection) {
      if (!p || p.ivTotal == null || p.speciesId == null) continue;
      const family = familyOf(p.speciesId);
      if (isBetter(p, best.get(family))) best.set(family, p);
    }
    return best;
  }

  // ctx: { familyOf, best (Map família → melhor), config, market }
  function classify(poke, ctx) {
    const config = { ...DEFAULT_CONFIG, ...(ctx.config || {}) };
    const tags = [];
    const reasons = [];
    const iv = poke.ivTotal;
    const q = poke.quality;

    if (poke.shiny || poke.isDitto || (q != null && q >= config.raroQuality)) {
      tags.push('raro');
      reasons.push(poke.shiny ? 'shiny' : poke.isDitto ? 'Ditto' : `Q ${q.toFixed(2)}`);
    }
    if (iv != null && poke.speciesId != null && ctx.familyOf && ctx.best) {
      const best = ctx.best.get(ctx.familyOf(poke.speciesId));
      const isTop = iv >= config.topIv &&
        (ctx.market ? isBetter(poke, best) : Boolean(best) && best.id === poke.id);
      if (isTop) {
        tags.push('top');
        reasons.push(ctx.market ? `superaria seu melhor da linha (IV ${best ? best.ivTotal : '—'})` : `melhor IV da linha (${iv})`);
      }
    }
    if (iv != null && iv >= config.matrizIv) {
      tags.push('matriz');
      reasons.push(`IV ${iv} para breeding`);
    }
    if (iv != null && q != null && iv >= config.uparIv && q >= config.uparQuality) {
      tags.push('upar');
      reasons.push(`IV ${iv} e Q ${q.toFixed(2)}`);
    }
    const isProtected = poke.team || poke.starter || poke.locked;
    if (!ctx.market && !tags.length && !isProtected && iv != null && q != null &&
        iv < config.lixoIv && q < config.lixoQuality) {
      tags.push('lixo');
      reasons.push(`IV ${iv} e Q ${q.toFixed(2)} baixos`);
    }
    return { tags, reasons };
  }

  function classifyCollection(rawList, { familyOf = id => id, config } = {}) {
    const pokes = (rawList ?? []).map(normalizePoke).filter(Boolean);
    const best = bestByFamily(pokes, familyOf);
    return pokes.map(p => ({ ...p, ...classify(p, { familyOf, best, config }) }));
  }

  function makeMarketClassifier(rawCollection, { familyOf = id => id, config } = {}) {
    const best = bestByFamily((rawCollection ?? []).map(normalizePoke).filter(Boolean), familyOf);
    return poke => classify(poke, { familyOf, best, config, market: true });
  }

  function primaryTag(tags) {
    return TAG_ORDER.find(t => tags.includes(t)) ?? null;
  }

  return { DEFAULT_CONFIG, TAGS, TAG_ORDER, normalizePoke, isBetter, bestByFamily, classify, classifyCollection, makeMarketClassifier, primaryTag };
});
