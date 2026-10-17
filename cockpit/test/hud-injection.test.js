'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createInGameHud, computeDexSpeciesStatus } = require('../../shared/in-game-hud.js');

function createMockDom() {
  const elementsById = new Map();

  class MockElement {
    constructor(tagName) {
      this.tagName = String(tagName).toUpperCase();
      this._id = '';
      this.className = '';
      this.textContent = '';
      this._innerHTML = '';
      this.style = {
        props: {},
        setProperty(k, v) { this.props[k] = v; }
      };
      this.dataset = {};
      this.attributes = new Map();
      this.children = [];
      this.parentElement = null;
      this.listeners = new Map();
    }
    get id() { return this._id; }
    set id(v) {
      if (this._id) elementsById.delete(this._id);
      this._id = v;
      if (v) elementsById.set(v, this);
    }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(html) {
      this._innerHTML = String(html);
      // Registra IDs presentes no template HTML para busca via getElementById
      const idMatches = this._innerHTML.matchAll(/\bid="([^"]+)"/g);
      for (const m of idMatches) {
        const childId = m[1];
        if (!elementsById.has(childId)) {
          const el = new MockElement('div');
          el.id = childId;
          this.children.push(el);
        }
      }
    }
    get firstChild() { return this.children[0] ?? null; }
    get firstElementChild() { return this.children[0] ?? null; }
    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      if (child.id) elementsById.set(child.id, child);
      return child;
    }
    append(...nodes) {
      for (const n of nodes) {
        if (typeof n === 'object' && n) this.appendChild(n);
      }
    }
    insertBefore(node, ref) {
      node.parentElement = this;
      const idx = ref ? this.children.indexOf(ref) : -1;
      if (idx >= 0) this.children.splice(idx, 0, node);
      else this.children.unshift(node);
      return node;
    }
    replaceChildren(...nodes) {
      this.children = [];
      this.append(...nodes);
    }
    querySelector(sel) {
      if (sel.startsWith('#')) return elementsById.get(sel.slice(1)) ?? null;
      for (const c of this.children) {
        if (sel.startsWith('.') && c.className.split(/\s+/).includes(sel.slice(1))) return c;
      }
      return null;
    }
    querySelectorAll(sel) {
      const out = [];
      for (const c of this.children) {
        if (sel.startsWith('.') && c.className.split(/\s+/).includes(sel.slice(1))) out.push(c);
      }
      return out;
    }
    addEventListener(ev, fn) {
      this.listeners.set(ev, fn);
    }
    getBoundingClientRect() {
      return { left: 10, top: 10, width: 290, height: 200 };
    }
  }

  const head = new MockElement('head');
  const body = new MockElement('body');
  const document = {
    readyState: 'complete',
    head,
    body,
    documentElement: head,
    createElement: tag => new MockElement(tag),
    getElementById: id => elementsById.get(id) ?? null,
    querySelectorAll: sel => body.querySelectorAll(sel),
    addEventListener: () => {}
  };

  const sessionStore = new Map([
    ['pokeweb:tokens', JSON.stringify({ accessToken: 'tok_hud_1', refreshToken: 'ref_hud_1' })]
  ]);
  const localStore = new Map();

  const window = {
    location: { origin: 'https://poke.idleworld.online', pathname: '/play', href: 'https://poke.idleworld.online/play' },
    document,
    sessionStorage: {
      getItem: k => sessionStore.get(k) ?? null,
      setItem: (k, v) => sessionStore.set(k, String(v))
    },
    localStorage: {
      getItem: k => localStore.get(k) ?? null,
      setItem: (k, v) => localStore.set(k, String(v))
    },
    addEventListener: () => {}
  };

  return { window, document, MockElement, elementsById };
}

test('In-Game HUD, Pokedex Badges, IV Tooltip & Telemetry Forwarding', async (t) => {
  await t.test('renderiza container #piw-hud e atualiza metricas via frames WebSocket', async () => {
    const { window, document } = createMockDom();
    const sentTelemetry = [];

    const hud = createInGameHud({
      window,
      document,
      cockpitUrl: 'http://127.0.0.1:8787',
      fetchImpl: async (url, opts) => {
        sentTelemetry.push({ url, body: JSON.parse(opts.body) });
        return { ok: true, json: async () => ({ ok: true }) };
      }
    });

    hud.mount();

    const hudRoot = document.getElementById('piw-hud');
    assert.ok(hudRoot, '#piw-hud deve ser criado no DOM');

    hud.onSocketEvent('frame', JSON.stringify({
      type: 'hunt-state',
      slug: 'cerulean-cave',
      name: 'Cerulean Cave'
    }));

    assert.equal(document.getElementById('piw-hud-hunt-name').textContent, 'Cerulean Cave');

    hud.onSocketEvent('frame', JSON.stringify({
      type: 'analyzer',
      seconds: 1800,
      kills: 240,
      killsPerHour: 480,
      captures: 12,
      xpPerHour: 95000
    }));

    assert.equal(document.getElementById('piw-hud-kills').textContent, '240');
    assert.equal(document.getElementById('piw-hud-captures').textContent, '12');

    hud.onSocketEvent('frame', JSON.stringify({
      type: 'hunt-kill',
      speciesId: 150,
      speciesName: 'Mewtwo',
      shiny: true
    }));

    assert.equal(document.getElementById('piw-hud-shiny-count').textContent, '1');

    await hud.flushTelemetry();
    assert.ok(sentTelemetry.length >= 1, 'deve ter enviado telemetria ao Cockpit');
    const killPayload = sentTelemetry.find(s => Array.isArray(s.body.telemetry.kills))?.body;
    assert.ok(killPayload, 'deve ter enviado lote com kills');
    assert.equal(killPayload.telemetry.hunt, 'cerulean-cave');
    assert.equal(killPayload.telemetry.kills.length, 1);
    assert.equal(killPayload.telemetry.kills[0].shiny, true);
  });

  await t.test('decodifica status da Pokedex para uma especie (missing, normal, shiny)', () => {
    const ownedPokes = [
      { id: 1, speciesId: 1, name: 'Bulbasaur', shiny: false },
      { id: 2, speciesId: 4, name: 'Shiny Charmander', shiny: true }
    ];

    assert.equal(computeDexSpeciesStatus(ownedPokes, 1, 'Bulbasaur'), 'normal');
    assert.equal(computeDexSpeciesStatus(ownedPokes, 4, 'Charmander'), 'shiny');
    assert.equal(computeDexSpeciesStatus(ownedPokes, 7, 'Squirtle'), 'missing');
  });

  await t.test('injeta badge de IV Total, Qualidade e Tag no tooltip de Pokemon', () => {
    const { window, document, MockElement } = createMockDom();
    const hud = createInGameHud({
      window,
      document,
      fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) })
    });

    // Carrega colecao para permitir classificacao
    hud.onSocketEvent('frame', JSON.stringify({
      type: 'pokes',
      list: [
        { id: 10, speciesId: 25, name: 'Pikachu', level: 50, ivTotal: 175, quality: 1.75, shiny: false }
      ]
    }));

    const tipEl = new MockElement('div');
    tipEl.className = 'poke-tip';
    const nameChild = new MockElement('div');
    nameChild.className = 'inv-tip-name';
    nameChild.textContent = 'Pikachu Lv. 50';
    tipEl.appendChild(nameChild);
    tipEl.textContent = 'Pikachu Lv. 50 HP 120 IV: 175/192 Qualidade x1.75';

    hud.enhanceTooltip(tipEl);

    assert.equal(tipEl.dataset.piwEnhanced, 'true');
    const badge = tipEl.firstChild;
    assert.ok(badge, 'deve inserir .piw-tip-badge no topo do tooltip');
    assert.equal(badge.className, 'piw-tip-badge');
    assert.match(badge.innerHTML, /IV 175\/192/);
    assert.match(badge.innerHTML, /91\.1%/);
    assert.match(badge.innerHTML, /Q ×1\.75/);
    assert.match(badge.innerHTML, /💎 Raro/);
  });
});
