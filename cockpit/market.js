'use strict';

// Varredura do Mercado Global (portada do editado.js), com as tags unificadas.
const { makeMarketClassifier, normalizePoke, bestByFamily } = require('../shared/classifier.js');

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(',', '.').replace(/[×x]/gi, '').trim());
  return Number.isFinite(n) ? n : null;
}

function priceNumber(value) {
  if (typeof value === 'string' && /^\d{1,3}(?:\.\d{3})+(?:,\d{2})?$/.test(value.trim())) return num(value.replaceAll('.', ''));
  return num(value);
}

function listFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['listings', 'items', 'results', 'list']) if (Array.isArray(payload?.[key])) return payload[key];
  if (payload?.data && payload.data !== payload) return listFromPayload(payload.data);
  throw new Error('A resposta do mercado mudou de formato.');
}

function meta(payload) {
  const body = payload?.data && !Array.isArray(payload.data) ? payload.data : payload;
  return body?.pagination ?? body?.meta ?? body;
}

function totalPages(payload, firstLength) {
  const m = meta(payload);
  const explicit = num(m?.totalPages ?? m?.pages ?? m?.pageCount);
  if (explicit != null && explicit >= 1) return Math.ceil(explicit);
  const total = num(m?.total ?? m?.totalCount);
  const perPage = num(m?.pageSize ?? m?.perPage ?? m?.limit ?? firstLength);
  return total != null && perPage > 0 ? Math.ceil(total / perPage) : null;
}

function listingKey(entry) {
  const id = entry?.id ?? entry?.listingId ?? entry?.refId;
  if (id != null) return `id:${id}`;
  return `data:${JSON.stringify([entry?.name ?? entry?.pokemon?.name, entry?.quality ?? entry?.pokemon?.quality,
    entry?.ivTotal ?? entry?.pokemon?.ivTotal, entry?.price, entry?.currency, entry?.sellerId ?? entry?.seller?.id])}`;
}

async function fetchAllListings(fetchPage, { signal, onProgress = () => {} }) {
  const first = await fetchPage(null);
  const firstEntries = listFromPayload(first);
  const known = totalPages(first, firstEntries.length);
  const firstNumber = num(meta(first)?.page ?? meta(first)?.currentPage ?? meta(first)?.pageIndex);
  const offset = firstNumber === 0 ? 0 : 1;
  const all = [];
  const seen = new Set();
  const signatures = new Set();
  let page = 1;
  let complete = known === 1;
  let reason = complete ? 'Total confirmado pela API.' : '';
  while (page <= 200 && all.length < 20000) {
    if (signal?.aborted) throw Object.assign(new Error('Busca cancelada.'), { name: 'AbortError' });
    const entries = page === 1 ? firstEntries : listFromPayload(await fetchPage(page - 1 + offset));
    if (!entries.length) { complete = true; reason = 'Última página vazia.'; break; }
    const signature = JSON.stringify(entries.map(listingKey));
    if (signatures.has(signature)) {
      complete = known != null && page > known;
      reason = complete ? 'Total confirmado pela API.' : 'A API repetiu uma página.';
      break;
    }
    signatures.add(signature);
    let added = 0;
    for (const entry of entries) {
      const key = listingKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(entry);
      added++;
    }
    onProgress(page, all.length);
    if (known != null && page >= known) { complete = true; reason = 'Total confirmado pela API.'; break; }
    if (!added) { reason = 'A página seguinte não trouxe anúncios novos.'; break; }
    page++;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  return { entries: all, pages: page, complete, reason: reason || 'Limite de segurança atingido.' };
}

function normalizeListing(entry, species) {
  if (!entry || typeof entry !== 'object') return null;
  const ref = entry.pokemon ?? entry.product ?? entry.item ?? {};
  const name = entry.name ?? entry.pokemonName ?? entry.itemName ?? entry.title ?? ref.name ?? ref.title;
  const ivTotal = num(entry.ivTotal ?? ref.ivTotal ?? entry.iv ?? ref.iv);
  const quality = num(entry.quality ?? ref.quality ?? entry.multiplier ?? ref.multiplier);
  if (!name || ivTotal == null || quality == null) return null;
  let speciesId = num(entry.speciesId ?? entry.pokeId ?? entry.pokemonId ?? ref.speciesId ?? ref.pokeId);
  if (speciesId == null) speciesId = species?.byName(name)?.pokeId ?? null;
  const price = priceNumber(entry.price ?? entry.totalPrice ?? entry.value);
  return {
    listingId: String(entry.id ?? entry.listingId ?? entry.refId ?? ''),
    name: String(name), speciesId, ivTotal, quality,
    level: num(entry.level ?? ref.level),
    shiny: Boolean(entry.shiny ?? ref.shiny),
    price, offerOnly: Boolean(entry.offerOnly || price == null || price <= 0),
    currency: String(entry.currency ?? 'GOLD').toUpperCase(),
    types: speciesId != null ? species?.profile(speciesId)?.types ?? [] : []
  };
}

const SORTERS = {
  quality: (a, b) => b.quality - a.quality || b.ivTotal - a.ivTotal,
  iv: (a, b) => b.ivTotal - a.ivTotal || b.quality - a.quality,
  price: (a, b) => (a.offerOnly ? Infinity : a.price) - (b.offerOnly ? Infinity : b.price),
  diff: (a, b) => ((b.comparison?.ivDiff ?? -999) - (a.comparison?.ivDiff ?? -999)) || (b.ivTotal - a.ivTotal)
};

async function scanMarket({ fetchPage, species, collection, config, tag = 'all', element = '', sort = 'iv', signal, onProgress }) {
  const scan = await fetchAllListings(fetchPage, { signal, onProgress });
  const familyOf = species ? species.familyOf : id => id;
  const normalizedCollection = (collection ?? []).map(normalizePoke).filter(Boolean);
  const bestMap = bestByFamily(normalizedCollection, familyOf);
  const classify = makeMarketClassifier(collection, { familyOf, config });

  const results = scan.entries.map(e => normalizeListing(e, species)).filter(Boolean)
    .map(item => {
      const cls = classify(normalizePoke({ ...item, id: null }));
      const family = item.speciesId != null ? familyOf(item.speciesId) : null;
      const myBest = family != null ? bestMap.get(family) : null;

      let comparison = null;
      if (myBest) {
        const ivDiff = item.ivTotal - myBest.ivTotal;
        const qualityDiff = Number((item.quality - (myBest.quality ?? 0)).toFixed(2));
        comparison = {
          myBest: {
            name: myBest.name,
            level: myBest.level,
            ivTotal: myBest.ivTotal,
            quality: myBest.quality,
            shiny: myBest.shiny
          },
          ivDiff,
          qualityDiff,
          isUpgrade: ivDiff > 0 || (ivDiff === 0 && qualityDiff > 0)
        };
      }

      return {
        ...item,
        ...cls,
        family,
        comparison,
        isNewSpecies: item.speciesId != null && !myBest
      };
    })
    .filter(item => item.tags.length && (tag === 'all' || item.tags.includes(tag)))
    .filter(item => !element || item.types.includes(element))
    .sort(SORTERS[sort] ?? SORTERS.iv);

  return { results, total: scan.entries.length, pages: scan.pages, complete: scan.complete, reason: scan.reason };
}

async function searchDirectMarket({ fetchDirect, species, collection, config, params = {}, signal }) {
  const payload = await fetchDirect(params, signal);
  const rawListings = listFromPayload(payload);
  const familyOf = species ? species.familyOf : id => id;
  const normalizedCollection = (collection ?? []).map(normalizePoke).filter(Boolean);
  const bestMap = bestByFamily(normalizedCollection, familyOf);
  const classify = makeMarketClassifier(collection, { familyOf, config });

  const validPrices = rawListings
    .map(e => priceNumber(e.price ?? e.totalPrice ?? e.value))
    .filter(p => p != null && p > 0)
    .sort((a, b) => a - b);
  const medianPrice = validPrices.length ? validPrices[Math.floor(validPrices.length / 2)] : null;
  const avgPrice = validPrices.length ? Math.round(validPrices.reduce((a, b) => a + b, 0) / validPrices.length) : null;
  const minPrice = validPrices.length ? validPrices[0] : null;

  const results = rawListings.map(e => normalizeListing(e, species)).filter(Boolean)
    .map(item => {
      const cls = classify(normalizePoke({ ...item, id: null }));
      const family = item.speciesId != null ? familyOf(item.speciesId) : null;
      const myBest = family != null ? bestMap.get(family) : null;

      let comparison = null;
      if (myBest) {
        const ivDiff = item.ivTotal - myBest.ivTotal;
        const qualityDiff = Number((item.quality - (myBest.quality ?? 0)).toFixed(2));
        comparison = {
          myBest: {
            name: myBest.name,
            level: myBest.level,
            ivTotal: myBest.ivTotal,
            quality: myBest.quality,
            shiny: myBest.shiny
          },
          ivDiff,
          qualityDiff,
          isUpgrade: ivDiff > 0 || (ivDiff === 0 && qualityDiff > 0)
        };
      }

      const pricePerIv = item.price && item.ivTotal ? Math.round(item.price / item.ivTotal) : null;
      const bargainPct = (medianPrice && item.price && item.price < medianPrice && !item.offerOnly)
        ? Math.round((1 - (item.price / medianPrice)) * 100)
        : null;
      const isBargain = Boolean(bargainPct != null && bargainPct >= 20);

      return {
        ...item,
        ...cls,
        family,
        comparison,
        pricePerIv,
        isBargain,
        bargainPct,
        isNewSpecies: item.speciesId != null && !myBest
      };
    });

  return {
    results,
    total: payload?.total ?? results.length,
    pages: payload?.pages ?? 1,
    stats: { minPrice, avgPrice, medianPrice, total: payload?.total ?? results.length }
  };
}

async function estimatePrice({ fetchDirect, speciesId, q, signal }) {
  const params = { browse: 'pokemon', sort: 'price-asc', page: '1' };
  if (speciesId) params.speciesId = String(speciesId);
  else if (q) params.q = String(q).trim();
  const payload = await fetchDirect(params, signal);
  const rawListings = listFromPayload(payload);
  const validPrices = rawListings
    .map(e => priceNumber(e.price ?? e.totalPrice ?? e.value))
    .filter(p => p != null && p > 0)
    .sort((a, b) => a - b);
  const minPrice = validPrices.length ? validPrices[0] : null;
  const avgPrice = validPrices.length ? Math.round(validPrices.reduce((a, b) => a + b, 0) / validPrices.length) : null;
  const medianPrice = validPrices.length ? validPrices[Math.floor(validPrices.length / 2)] : null;
  const sample = rawListings.slice(0, 5).map(e => ({
    name: e.name ?? e.pokemonName ?? 'Pokémon',
    level: num(e.level),
    ivTotal: num(e.ivTotal ?? e.iv),
    quality: num(e.quality),
    price: priceNumber(e.price ?? e.totalPrice),
    currency: String(e.currency ?? 'GOLD').toUpperCase(),
    shiny: Boolean(e.shiny)
  }));
  return {
    total: payload?.total ?? rawListings.length,
    minPrice, avgPrice, medianPrice,
    sample
  };
}

async function fetchCommodityTickers({ fetchCategory, signal }) {
  // 1. Diamonds (category=Diamonds)
  const diaPayload = await fetchCategory('Diamonds', signal).catch(() => ({}));
  const diaRaw = (diaPayload?.listings || []).filter(l => !l.offerOnly && Number(l.price) > 0);
  const diaSorted = [...diaRaw].sort((a, b) => Number(a.price) - Number(b.price));
  const diaTotalQty = diaSorted.reduce((sum, l) => sum + (Number(l.quantity) || 1), 0);
  const diaPrices = diaSorted.map(l => Number(l.price));
  const diaMinPrice = diaPrices[0] ?? null;
  const diaMedianPrice = diaPrices.length ? diaPrices[Math.floor(diaPrices.length / 2)] : null;
  const diaDepth = diaSorted.slice(0, 8).map(l => ({
    price: Number(l.price),
    qty: Number(l.quantity) || 1,
    sellers: Number(l.sellers) || 1
  }));

  // 2. Items -> Strange Pheromone (category=Items, refId 44417 or /pheromone/i)
  const itemsPayload = await fetchCategory('Items', signal).catch(() => ({}));
  const itemsRaw = (itemsPayload?.listings || []).filter(l => !l.offerOnly && Number(l.price) > 0);
  const pheroAll = itemsRaw.filter(l => l.refId === 44417 || /strange\s+pheromone|ferom/i.test(l.name));

  // Pheromones in Diamonds
  const pheroDia = pheroAll.filter(l => String(l.currency).toUpperCase() === 'DIAMONDS').sort((a, b) => Number(a.price) - Number(b.price));
  const pheroDiaQty = pheroDia.reduce((sum, l) => sum + (Number(l.quantity) || 1), 0);
  const pheroDiaPrices = pheroDia.map(l => Number(l.price));
  const pheroDiaMin = pheroDiaPrices[0] ?? null;
  const pheroDiaMedian = pheroDiaPrices.length ? pheroDiaPrices[Math.floor(pheroDiaPrices.length / 2)] : null;
  const pheroDiaDepth = pheroDia.slice(0, 8).map(l => ({
    price: Number(l.price),
    qty: Number(l.quantity) || 1,
    sellers: Number(l.sellers) || 1
  }));

  // Pheromones in Gold
  const pheroGold = pheroAll.filter(l => String(l.currency).toUpperCase() === 'GOLD').sort((a, b) => Number(a.price) - Number(b.price));
  const pheroGoldQty = pheroGold.reduce((sum, l) => sum + (Number(l.quantity) || 1), 0);
  const pheroGoldPrices = pheroGold.map(l => Number(l.price));
  const pheroGoldMin = pheroGoldPrices[0] ?? null;
  const pheroGoldMedian = pheroGoldPrices.length ? pheroGoldPrices[Math.floor(pheroGoldPrices.length / 2)] : null;
  const pheroGoldDepth = pheroGold.slice(0, 8).map(l => ({
    price: Number(l.price),
    qty: Number(l.quantity) || 1,
    sellers: Number(l.sellers) || 1
  }));

  return {
    at: Date.now(),
    diamonds: {
      minPrice: diaMinPrice,
      medianPrice: diaMedianPrice,
      totalQty: diaTotalQty,
      listingsCount: diaSorted.length,
      depth: diaDepth
    },
    pheromones: {
      diamonds: {
        minPrice: pheroDiaMin,
        medianPrice: pheroDiaMedian,
        totalQty: pheroDiaQty,
        listingsCount: pheroDia.length,
        depth: pheroDiaDepth
      },
      gold: {
        minPrice: pheroGoldMin,
        medianPrice: pheroGoldMedian,
        totalQty: pheroGoldQty,
        listingsCount: pheroGold.length,
        depth: pheroGoldDepth
      }
    }
  };
}

module.exports = { scanMarket, searchDirectMarket, estimatePrice, fetchCommodityTickers };

