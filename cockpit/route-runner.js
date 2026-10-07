'use strict';

function toSlug(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

class RouteRunner {
  constructor({ account, speciesCatalog, onLog, onStatusChange }) {
    this.account = account;
    this.speciesCatalog = speciesCatalog;
    this.onLog = onLog;
    this.onStatusChange = onStatusChange;

    this.state = {
      running: false,
      paused: false,
      startedAt: null,
      originalHunt: null,
      originalHuntName: null,
      targetCapturesPerSpecies: 1,
      maxTimePerHuntSec: 300,
      returnHome: true,
      currentIndex: 0,
      currentCaptures: 0,
      currentHuntStartedAt: null,
      queue: [],
      history: []
    };

    this.timer = null;
    this.onCaptureBound = this.handleCapture.bind(this);
  }

  getStatus() {
    const total = this.state.queue.length;
    const completed = this.state.queue.filter(q => q.status === 'completed').length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    return {
      accountId: this.account.id,
      accountName: this.account.name,
      ...this.state,
      totalTargets: total,
      completedTargets: completed,
      progressPct: pct,
      currentTarget: this.getCurrentTarget()
    };
  }

  start({ queue, route, targetCaptures, targetPerPoke, maxTimeSec, timeoutSec, returnHome = true }) {
    const list = Array.isArray(queue) && queue.length ? queue : (Array.isArray(route) ? route : []);
    if (!list.length) {
      throw new Error('A rota precisa ter pelo menos 1 Pokémon.');
    }
    if (this.state.running) this.stop(false);

    const origSlug = this.account.lastHunt || this.account.state.hunt || 'caterpie';
    const origName = this.account.state.hunt || origSlug;

    this.state.running = true;
    this.state.paused = false;
    this.state.startedAt = Date.now();
    this.state.originalHunt = origSlug;
    this.state.originalHuntName = origName;
    this.state.targetCapturesPerSpecies = Math.max(1, Number(targetCaptures ?? targetPerPoke) || 1);
    this.state.maxTimePerHuntSec = Math.max(60, Number(maxTimeSec ?? timeoutSec) || 300);
    this.state.returnHome = Boolean(returnHome);
    this.state.queue = list.map((q, idx) => ({
      index: idx,
      speciesId: Number(q.speciesId || q.pokeId || q.id),
      name: q.name || `Pokémon #${q.speciesId}`,
      slug: q.slug || toSlug(q.name),
      level: q.level || q.huntLevel || 1,
      types: q.types || (q.type1 ? [q.type1, q.type2].filter(Boolean) : []),
      captures: 0,
      target: this.state.targetCapturesPerSpecies,
      status: 'pending'
    }));
    this.state.currentIndex = 0;
    this.state.currentCaptures = 0;
    this.state.history = [];

    this.account.on('capture', this.onCaptureBound);

    this.log(`🚀 Rota Automática iniciada com ${this.state.queue.length} Pokémon! Hunt de retorno: ${origName}.`);

    this.enterCurrentHunt();
    this.startWatchdog();
    this.emitStatus();
  }

  pause() {
    if (!this.state.running || this.state.paused) return;
    this.state.paused = true;
    const target = this.getCurrentTarget();
    this.log(`⏸️ Rota Automática pausada em ${target?.name || 'hunt atual'}.`);
    this.emitStatus();
  }

  resume() {
    if (!this.state.running || !this.state.paused) return;
    this.state.paused = false;
    const target = this.getCurrentTarget();
    this.log(`▶️ Rota Automática retomada em ${target?.name || 'hunt atual'}.`);
    this.enterCurrentHunt();
    this.emitStatus();
  }

  skipCurrent() {
    if (!this.state.running) return;
    const target = this.getCurrentTarget();
    if (target) {
      this.log(`⏭️ Pulando manualmente ${target.name}…`);
      target.status = 'skipped';
      this.advanceNext();
    }
  }

  stop(returnHome = true) {
    if (!this.state.running) return;
    this.state.running = false;
    this.state.paused = false;
    this.account.off('capture', this.onCaptureBound);
    clearInterval(this.timer);

    if (returnHome && this.state.returnHome && this.state.originalHunt) {
      this.log(`⏹️ Rota parada. Retornando para a hunt base: ${this.state.originalHuntName} (${this.state.originalHunt})…`);
      this.account.setHunt(this.state.originalHunt, this.state.originalHuntName);
      this.account.send({ type: 'enter-hunt', slug: this.state.originalHunt });
    }

    this.emitStatus();
  }

  getCurrentTarget() {
    return this.state.queue[this.state.currentIndex] || null;
  }

  enterCurrentHunt() {
    const target = this.getCurrentTarget();
    if (!target) {
      this.finishRoute();
      return;
    }

    target.status = 'hunting';
    this.state.currentCaptures = 0;
    this.state.currentHuntStartedAt = Date.now();

    this.log(`🧭 [${this.state.currentIndex + 1}/${this.state.queue.length}] Indo caçar: ${target.name} (Nv ${target.level}) [hunt: ${target.slug}]…`);
    this.account.setHunt(target.slug, target.name);
    this.account.send({ type: 'enter-hunt', slug: target.slug });
    this.emitStatus();
  }

  handleCapture({ at, poke }) {
    if (!this.state.running || this.state.paused) return;
    const target = this.getCurrentTarget();
    if (!target) return;

    const pokeSpeciesId = Number(poke.speciesId || poke.pokeId || poke.id);
    const pokeName = String(poke.name || '').toLowerCase();
    const targetName = String(target.name || '').toLowerCase();

    // Valida se a captura é da espécie alvo
    const isTarget = (target.speciesId && pokeSpeciesId === target.speciesId) ||
                     (targetName && pokeName.includes(targetName)) ||
                     (target.slug && toSlug(pokeName) === target.slug);

    if (isTarget) {
      this.state.currentCaptures++;
      target.captures = this.state.currentCaptures;

      this.log(`🎯 [${this.state.currentIndex + 1}/${this.state.queue.length}] Capturado: ${poke.name} (${this.state.currentCaptures}/${target.target})!`);

      if (this.state.currentCaptures >= target.target) {
        target.status = 'completed';
        this.state.history.push({
          speciesId: target.speciesId,
          name: target.name,
          slug: target.slug,
          captures: this.state.currentCaptures,
          completedAt: Date.now()
        });
        this.advanceNext();
      } else {
        this.emitStatus();
      }
    }
  }

  advanceNext() {
    this.state.currentIndex++;
    if (this.state.currentIndex >= this.state.queue.length) {
      this.finishRoute();
    } else {
      this.enterCurrentHunt();
    }
  }

  finishRoute() {
    this.state.running = false;
    this.state.paused = false;
    this.account.off('capture', this.onCaptureBound);
    clearInterval(this.timer);

    const totalMin = Math.max(1, Math.round((Date.now() - this.state.startedAt) / 60000));
    const completedCount = this.state.queue.filter(q => q.status === 'completed').length;
    this.log(`🏆 ROTA AUTOMÁTICA FINALIZADA! ${completedCount} de ${this.state.queue.length} Pokémon capturados com sucesso em ~${totalMin} min.`);

    if (this.state.returnHome && this.state.originalHunt) {
      this.log(`🏠 Retornando para a hunt base: ${this.state.originalHuntName} (${this.state.originalHunt})…`);
      this.account.setHunt(this.state.originalHunt, this.state.originalHuntName);
      this.account.send({ type: 'enter-hunt', slug: this.state.originalHunt });
    }

    this.emitStatus();
  }

  startWatchdog() {
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (!this.state.running || this.state.paused) return;
      const target = this.getCurrentTarget();
      if (!target) return;

      const elapsedSec = Math.round((Date.now() - (this.state.currentHuntStartedAt || Date.now())) / 1000);
      if (elapsedSec > this.state.maxTimePerHuntSec) {
        this.log(`⚠️ Tempo limite de ${Math.round(this.state.maxTimePerHuntSec / 60)} min atingido em ${target.name}. Avançando para o próximo alvo…`);
        target.status = 'skipped';
        this.advanceNext();
      }
    }, 4000);
  }

  log(text) {
    if (this.onLog) {
      this.onLog({
        at: Date.now(),
        account: this.account.id,
        accountName: this.account.name,
        text
      });
    }
  }

  emitStatus() {
    if (this.onStatusChange) this.onStatusChange(this.getStatus());
  }
}

function buildPresetRoutes(allCreatures, ownedSpeciesSet = new Set()) {
  const creatures = Array.isArray(allCreatures) ? allCreatures : [];

  const mapCreature = c => ({
    speciesId: c.pokeId,
    name: c.name,
    slug: toSlug(c.name),
    level: c.huntLevel || 1,
    rarity: c.rarity || 'COMMON',
    type1: c.type1,
    type2: c.type2,
    owned: ownedSpeciesSet.has(c.pokeId)
  });

  // Presets
  const presets = [
    {
      id: 'kanto_lvl1',
      title: '🌱 Fase 1: Iniciais de Kanto (Lv 1)',
      description: 'Monstros de nível 1 com 100% de taxa de captura imediata.',
      filter: c => c.huntLevel === 1 && !c.area
    },
    {
      id: 'kanto_lvl10',
      title: '⚡ Fase 2: Cavernas e Rotas (Lv 10)',
      description: 'Monstros de nível 10 para expandir tipos elementais (Zubat, Diglett, Mankey, Abra…).',
      filter: c => c.huntLevel === 10 && !c.area
    },
    {
      id: 'starters_lvl20',
      title: '🔥 Fase 3: Iniciais & Eevee (Lv 20)',
      description: 'Iniciais de Kanto/Johto/Hoenn, Eevee, Machop, Vulpix, Houndour e raros de Lv 20.',
      filter: c => c.huntLevel === 20 && !c.area
    },
    {
      id: 'dragons_lvl30',
      title: '🐉 Fase 4: Dragões & Semilendários (Lv 20-30)',
      description: 'Dratini, Larvitar, Beldum, Gible, Riolu, Goomy e outros de grande valor.',
      filter: c => [147, 246, 374, 443, 447, 704, 371].includes(c.pokeId)
    },
    {
      id: 'unowned_lvl20',
      title: '✨ Pokédex Speedrun: Não Capturados (Lv 1 a 20)',
      description: 'Todos os Pokémon até nível 20 que você AINDA NÃO TEM na coleção.',
      filter: c => c.huntLevel != null && c.huntLevel <= 20 && !c.area && !ownedSpeciesSet.has(c.pokeId)
    },
    {
      id: 'unowned_lvl30',
      title: '🚀 Pokédex Master: Todos Não Capturados (Lv 1 a 30)',
      description: 'Todos os Pokémon até nível 30 que faltam na sua Pokédex, ordenados por nível.',
      filter: c => c.huntLevel != null && c.huntLevel <= 30 && !c.area && !ownedSpeciesSet.has(c.pokeId)
    }
  ];

  return presets.map(p => {
    const list = creatures.filter(p.filter);
    list.sort((a, b) => (a.huntLevel || 1) - (b.huntLevel || 1) || a.pokeId - b.pokeId);
    return {
      id: p.id,
      title: p.title,
      name: p.title,
      description: p.description,
      count: list.length,
      unownedCount: list.filter(c => !ownedSpeciesSet.has(c.pokeId)).length,
      items: list.map(mapCreature),
      route: list.map(mapCreature)
    };
  });
}

module.exports = {
  RouteRunner,
  toSlug,
  buildPresetRoutes
};
