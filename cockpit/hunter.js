// Smart Hunter — Integração com a inteligência de rotas e cálculos do Piwdex
// Consulta https://piwdex.com.br/api/rota para estimar a hunt mais lucrativa e de maior XP

const PIWDEX_API_URL = 'https://piwdex.com.br/api/rota';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos
const cache = new Map();

function formatIvsParam(ivs) {
  if (!ivs) return '';
  if (Array.isArray(ivs) && ivs.length >= 6) {
    return ivs.slice(0, 6).map(v => Number.isFinite(Number(v)) ? Number(v) : 16).join('.');
  }
  if (typeof ivs === 'object') {
    const list = [
      ivs.hp,
      ivs.atk ?? ivs.attack,
      ivs.def ?? ivs.defense,
      ivs.spa ?? ivs.spAtk ?? ivs.specialAttack,
      ivs.spd ?? ivs.spDef ?? ivs.specialDefense,
      ivs.vel ?? ivs.speed
    ];
    if (list.some(v => v != null)) {
      return list.map(v => (v != null && Number.isFinite(Number(v))) ? Number(v) : 16).join('.');
    }
  }
  return '';
}

function parseTrecho(spot) {
  if (!spot) return null;
  const horas = Math.max(0.001, Number(spot.horas) || 1);
  const abates = Number(spot.abates) || 0;
  const ouro = Number(spot.ouro) || 0;
  const xpt = Number(spot.xpt) || 0;
  const xpHour = Number(spot.xpHora) || 0;

  return {
    slug: String(spot.slug || ''),
    name: String(spot.nome || spot.slug || ''),
    level: Number(spot.nivel) || 0,
    look: spot.look ?? null,
    type: spot.t1 ?? null,
    hours: horas,
    killsPerHour: Math.round(abates / horas),
    goldPerHour: Math.round(ouro / horas),
    xpHour: Math.round(xpHour),
    trainerXpPerHour: Math.round(xpt / horas),
    sellPrice: Number(spot.venda) || 0
  };
}

async function fetchPiwdexRoute(params, signal) {
  const url = new URL(PIWDEX_API_URL);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), {
    signal,
    headers: {
      'x-piwdex': '1',
      'Accept': 'application/json',
      'User-Agent': 'PokeIdleCockpit/1.0'
    }
  });

  if (!res.ok) {
    throw new Error(`Piwdex HTTP ${res.status}`);
  }

  const data = await res.json();
  if (data.erro) {
    throw new Error(`Piwdex erro: ${data.erro}`);
  }
  return data;
}

async function getHuntRecommendation(leader, options = {}) {
  if (!leader || !leader.speciesId || !leader.level) {
    return { gold: null, xp: null, reason: 'Sem líder válido' };
  }

  const speciesId = Number(leader.speciesId);
  const level = Number(leader.level);
  const quality = Number(leader.quality) || 1.2;
  const power = leader.power ? Number(leader.power) : '';
  const ivStr = formatIvsParam(leader.ivs);
  const meta = Math.min(10000, level + 20);

  const cacheKey = `${speciesId}:${level}:${quality.toFixed(3)}:${power}:${ivStr}`;
  const cached = cache.get(cacheKey);
  const now = Date.now();

  if (cached && (now - cached.at < CACHE_TTL_MS)) {
    return cached.data;
  }

  const baseParams = {
    e: speciesId,
    n: level,
    q: quality,
    p: power,
    meta,
    modo: 'st',
    v: ivStr,
    acima: options.acima ? '1' : ''
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const [goldRes, xpRes] = await Promise.all([
      fetchPiwdexRoute({ ...baseParams, ord: 'ouro' }, controller.signal),
      fetchPiwdexRoute({ ...baseParams, ord: '' }, controller.signal)
    ]);

    clearTimeout(timeout);

    const goldSpot = goldRes?.trechos?.[0] ? parseTrecho(goldRes.trechos[0]) : null;
    const xpSpot = xpRes?.trechos?.[0] ? parseTrecho(xpRes.trechos[0]) : null;

    const data = {
      gold: goldSpot,
      xp: xpSpot,
      leader: {
        name: leader.name,
        level,
        quality,
        speciesId
      },
      updatedAt: now
    };

    cache.set(cacheKey, { at: now, data });

    // Limpa entradas muito antigas do cache
    if (cache.size > 50) {
      for (const [k, v] of cache.entries()) {
        if (now - v.at > CACHE_TTL_MS * 2) cache.delete(k);
      }
    }

    return data;
  } catch (err) {
    // Se falhar a requisição mas tínhamos cache expirado, use o que tem
    if (cached) return cached.data;

    return {
      gold: null,
      xp: null,
      error: err.message,
      updatedAt: now
    };
  }
}

function getCachedRecommendation(leader) {
  if (!leader || !leader.speciesId || !leader.level) return null;
  const speciesId = Number(leader.speciesId);
  const level = Number(leader.level);
  const quality = Number(leader.quality) || 1.2;
  const power = leader.power ? Number(leader.power) : '';
  const ivStr = formatIvsParam(leader.ivs);
  const cacheKey = `${speciesId}:${level}:${quality.toFixed(3)}:${power}:${ivStr}`;
  const cached = cache.get(cacheKey);
  return cached ? cached.data : null;
}

module.exports = {
  getHuntRecommendation,
  getCachedRecommendation,
  formatIvsParam
};
