'use strict';

// Mesma regra de shard do cliente oficial: djb2(sub do JWT) % 66.
const DEFAULT_BASE = 'wss://poke.idleworld.online/ws';
const SHARDS = 66;

function djb2Shard(text, shards) {
  if (shards <= 1) return 0;
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = (hash << 5) + hash + text.charCodeAt(i) | 0;
  return Math.abs(hash) % shards;
}

// cmid: impressão da máquina lida do próprio cliente do jogo neste PC (igual para todas as contas).
function socketUrl(accessToken, { base = DEFAULT_BASE, shards = SHARDS, cmid = null } = {}) {
  let url = base;
  try {
    const sub = String(JSON.parse(atob(accessToken.split('.')[1])).sub ?? '');
    const shard = djb2Shard(sub, shards);
    if (shard !== 0) {
      const u = new URL(base);
      if (u.pathname && u.pathname !== '/') {
        u.pathname = `${u.pathname.replace(/\/$/, '')}${shard}`;
      } else {
        const port = u.protocol === 'wss:' || u.protocol === 'https:' ? 443 : 80;
        u.port = String(Number(u.port || port) + shard);
      }
      url = u.toString().replace(/\/$/, '');
    }
  } catch {
    url = base;
  }
  return `${url}?token=${encodeURIComponent(accessToken)}${cmid ? `&cmid=${encodeURIComponent(cmid)}` : ''}`;
}

module.exports = { socketUrl, djb2Shard };
