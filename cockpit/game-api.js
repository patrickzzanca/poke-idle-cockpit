'use strict';

const ORIGIN = 'https://poke.idleworld.online';

class GameApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GameApiError';
    this.status = status;
  }
}

function createGameApi({ fetchImpl = globalThis.fetch, origin = ORIGIN } = {}) {
  async function request(path, { method = 'GET', token, body, signal } = {}) {
    let response;
    try {
      response = await fetchImpl(origin + path, {
        method, signal,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new GameApiError(`Sem conexão com o jogo (${error.message}).`, 0);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new GameApiError(data?.message || `O jogo respondeu HTTP ${response.status}.`, response.status);
    return data;
  }

  return {
    refresh: refreshToken => request('/api/auth/refresh', { method: 'POST', body: { refreshToken } }),
    me: token => request('/api/characters/me', { token }),
    sell: (token, pokeIds) => request('/api/game/pokemon/sell', { method: 'POST', token, body: { pokeIds } }),
    lock: (token, id, locked) => request('/api/game/pokemon/lock', { method: 'POST', token, body: { id, locked } }),
    market: (token, page, signal) => request(`/api/game/market?category=Pokemon${page != null ? `&page=${page}` : ''}`, { token, signal }),
    marketSearch: (token, params = {}, signal) => {
      const q = new URLSearchParams({ browse: 'pokemon', category: 'Pokemon', ...params });
      return request(`/api/game/market?${q.toString()}`, { token, signal });
    },
    marketCategory: (token, category, signal) => request(`/api/game/market?category=${encodeURIComponent(category)}`, { token, signal }),
    marketAction: (token, body) => request('/api/game/market/action', { method: 'POST', token, body }),
    creatures: () => request('/game/creatures.json'),
    items: () => request('/game/items.json')
  };
}

module.exports = { createGameApi, GameApiError };
