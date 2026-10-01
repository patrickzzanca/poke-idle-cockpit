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

module.exports = { scanMarket };
