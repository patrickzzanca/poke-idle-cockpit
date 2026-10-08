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
      maxTimeWithoutKillSec: 60,
      returnHome: true,
      currentIndex: 0,
      currentCaptures: 0,
      currentHuntKills: 0,
      currentHuntStartedAt: null,
      lastKillInHuntAt: null,
      queue: [],
      history: []
    };

    this.timer = null;
    this.onCaptureBound = this.handleCapture.bind(this);
    this.onKillBound = this.handleKill.bind(this);
    this.onFieldNoneBound = this.handleFieldNone.bind(this);
    this.onGameErrorBound = this.handleGameError.bind(this);
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

  start({ queue, route, targetCaptures, targetPerPoke, targetKills, maxTimeSec, timeoutSec, noKillTimeoutSec, maxTimeWithoutKillSec, returnHome = true }) {
    const list = Array.isArray(queue) && queue.length ? queue : (Array.isArray(route) ? route : []);
    if (!list.length) {
      throw new Error('A rota precisa ter pelo menos 1 Pokémon.');
    }
    if (this.state.running) this.stop(false);

    const origSlug = this.account.lastHunt || this.account.state.hunt || 'caterpie';
    const origName = this.account.state.hunt || origSlug;

    const rawNoKill = noKillTimeoutSec !== undefined ? noKillTimeoutSec : maxTimeWithoutKillSec;
    const resolvedNoKill = rawNoKill !== undefined ? Math.max(0, Number(rawNoKill) || 0) : 60;
    const resolvedTargetKills = Number(targetKills) > 0 ? Number(targetKills) : 0;

    this.state.running = true;
    this.state.paused = false;
    this.state.startedAt = Date.now();
    this.state.originalHunt = origSlug;
    this.state.originalHuntName = origName;
    this.state.targetCapturesPerSpecies = Math.max(1, Number(targetCaptures ?? targetPerPoke) || 1);
    this.state.targetKillsPerSpecies = resolvedTargetKills;
    this.state.maxTimePerHuntSec = Math.max(60, Number(maxTimeSec ?? timeoutSec) || 300);
    this.state.maxTimeWithoutKillSec = resolvedNoKill;
    this.state.returnHome = Boolean(returnHome);
    this.state.queue = list.map((q, idx) => ({
      index: idx,
      speciesId: Number(q.speciesId || q.pokeId || q.id),
      name: q.name || `Pokémon #${q.speciesId}`,
      slug: q.slug || toSlug(q.name),
      level: q.level || q.huntLevel || 1,
      types: q.types || (q.type1 ? [q.type1, q.type2].filter(Boolean) : []),
      captures: 0,
      kills: 0,
      target: Number(q.target || q.targetCaptures) || this.state.targetCapturesPerSpecies,
      targetKills: Number(q.targetKills) || resolvedTargetKills,
      status: 'pending'
    }));
    this.state.currentIndex = 0;
    this.state.currentCaptures = 0;
    this.state.currentHuntKills = 0;
    this.state.lastKillInHuntAt = null;
    this.state.history = [];

    this.account.on('capture', this.onCaptureBound);
    this.account.on('kill', this.onKillBound);
    this.account.on('field-none', this.onFieldNoneBound);
    this.account.on('game-error', this.onGameErrorBound);

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
    this.account.off('kill', this.onKillBound);
    this.account.off('field-none', this.onFieldNoneBound);
    this.account.off('game-error', this.onGameErrorBound);
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
    this.state.currentHuntKills = 0;
    this.state.currentHuntStartedAt = Date.now();
    this.state.lastKillInHuntAt = Date.now();

    this.log(`🧭 [${this.state.currentIndex + 1}/${this.state.queue.length}] Indo caçar: ${target.name} (Nv ${target.level}) [hunt: ${target.slug}]…`);
    this.account.setHunt(target.slug, target.name);
    this.account.send({ type: 'enter-hunt', slug: target.slug });
    this.emitStatus();
  }

  handleKill(message) {
    if (!this.state.running || this.state.paused) return;
    this.state.currentHuntKills++;
    this.state.lastKillInHuntAt = Date.now();
    const target = this.getCurrentTarget();
    if (!target) return;

    if (target.targetKills > 0 && this.state.currentHuntKills >= target.targetKills) {
      target.status = 'completed';
      this.log(`⚔️ [${this.state.currentIndex + 1}/${this.state.queue.length}] Meta de kills atingida: ${target.name} (${this.state.currentHuntKills}/${target.targetKills} kills)!`);
      this.state.history.push({
        speciesId: target.speciesId,
        name: target.name,
        slug: target.slug,
        captures: this.state.currentCaptures,
        kills: this.state.currentHuntKills,
        completedAt: Date.now()
      });
      this.advanceNext();
    }
  }

  handleCapture({ at, poke }) {
    if (!this.state.running || this.state.paused) return;
    this.state.currentHuntKills++;
    this.state.lastKillInHuntAt = Date.now();
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

  handleFieldNone(message) {
    if (!this.state.running || this.state.paused) return;
    const target = this.getCurrentTarget();
    if (!target) return;
    if (!message?.slug || message.slug === target.slug) {
      this.log(`⚠️ Hunt indisponível no servidor: ${target.name} [slug: ${target.slug}]. Pulando para o próximo alvo…`);
      target.status = 'skipped';
      this.advanceNext();
    }
  }

  handleGameError(message) {
    if (!this.state.running || this.state.paused) return;
    const target = this.getCurrentTarget();
    if (!target) return;
    const msg = String(message?.message || '');
    if (msg.includes('nível') || msg.includes('caçar') || msg.includes('bloqueada')) {
      this.log(`⚠️ Hunt bloqueada para este nível: "${msg}". Pulando ${target.name}…`);
      target.status = 'skipped';
      this.advanceNext();
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
    this.account.off('kill', this.onKillBound);
    this.account.off('field-none', this.onFieldNoneBound);
    this.account.off('game-error', this.onGameErrorBound);
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

      const now = Date.now();

      // Watchdog 1: Se não houver kill em X segundos (padrão: 60s / 1 min)
      if (this.state.maxTimeWithoutKillSec > 0) {
        const timeWithoutKill = Math.round((now - (this.state.lastKillInHuntAt || this.state.currentHuntStartedAt || now)) / 1000);
        if (timeWithoutKill >= this.state.maxTimeWithoutKillSec) {
          const tempoDesc = this.state.maxTimeWithoutKillSec >= 60
            ? `${Math.round(this.state.maxTimeWithoutKillSec / 60)} min`
            : `${this.state.maxTimeWithoutKillSec}s`;
          this.log(`⚠️ Nenhuma kill em ${tempoDesc} na hunt de ${target.name}. Pulando para o próximo alvo…`);
          target.status = 'skipped';
          this.advanceNext();
          return;
        }
      }

      // Watchdog 2: Tempo máximo total por hunt (ex: 3, 5 ou 10 min)
      const elapsedSec = Math.round((now - (this.state.currentHuntStartedAt || now)) / 1000);
      if (elapsedSec > this.state.maxTimePerHuntSec) {
        this.log(`⚠️ Tempo limite de ${Math.round(this.state.maxTimePerHuntSec / 60)} min atingido em ${target.name}. Avançando para o próximo alvo…`);
        target.status = 'skipped';
        this.advanceNext();
      }
    }, 2000);
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

// Os 46 Pokémon desbloqueados para caça confirmados na Pokédex:
const UNLOCKED_SPECIES_IDS = new Set([
  16,  // Pidgey (Lv 1)
  43,  // Oddish (Lv 1)
  46,  // Paras (Lv 1)
  69,  // Bellsprout (Lv 1)
  50,  // Diglett (Lv 10)
  81,  // Magnemite (Lv 10)
  102, // Exeggcute (Lv 10)
  109, // Koffing (Lv 10)
  1,   // Bulbasaur (Lv 20)
  37,  // Vulpix (Lv 20)
  92,  // Gastly (Lv 20)
  138, // Omanyte (Lv 20)
  228, // Houndour (Lv 20)
  30,  // Nidorina (Lv 30)
  147, // Dratini (Lv 30)
  216, // Teddiursa (Lv 30)
  238, // Smoochum (Lv 30)
  24,  // Arbok (Lv 40)
  47,  // Parasect (Lv 50)
  93,  // Haunter (Lv 50)
  193, // Yanma (Lv 50)
  106, // Hitmonlee (Lv 60)
  128, // Tauros (Lv 60)
  237, // Hitmontop (Lv 60)
  3,   // Venusaur (Lv 80)
  6,   // Charizard (Lv 80)
  40,  // Wigglytuff (Lv 80)
  76,  // Golem (Lv 80)
  82,  // Magneton (Lv 80)
  89,  // Muk (Lv 80)
  148, // Dragonair (Lv 80)
  157, // Typhlosion (Lv 80)
  160, // Feraligatr (Lv 80)
  241, // Miltank (Lv 80)
  65,  // Alakazam (Lv 100)
  94,  // Gengar (Lv 100)
  123, // Scyther (Lv 100)
  124, // Jynx (Lv 100)
  125, // Electabuzz (Lv 100)
  126, // Magmar (Lv 100)
  127, // Pinsir (Lv 100)
  130, // Gyarados (Lv 100)
  212, // Scizor (Lv 100)
  214, // Heracross (Lv 100)
  217, // Ursaring (Lv 100)
  226  // Mantine (Lv 100)
]);

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
      id: 'unowned_final',
      title: '🎯 Pokédex: Faltantes (46 Desbloqueados)',
      description: 'Rota contendo apenas os Pokémon desbloqueados para caça que ainda faltam registrar na sua Pokédex.',
      filter: c => UNLOCKED_SPECIES_IDS.has(c.pokeId) && !ownedSpeciesSet.has(c.pokeId)
    },
    {
      id: 'all_unlocked',
      title: '🗺️ Rota Completa (46 Desbloqueados)',
      description: 'Rota contendo todos os 46 Pokémon desbloqueados para caça no jogo, ordenados por nível.',
      filter: c => UNLOCKED_SPECIES_IDS.has(c.pokeId)
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
