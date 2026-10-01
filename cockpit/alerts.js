'use strict';

// Os formatos de `balls`/`potions` vêm do Auto Helper do jogo; nomes alternativos
// cobrem variações até confirmarmos com uma amostra real (cockpit/.cache/samples).
function qty(item) {
  const n = Number(item?.quantity ?? item?.qty ?? item?.count ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function supplies(state) {
  const helper = state.autohelper ?? {};
  const balls = Array.isArray(helper.balls) ? helper.balls : [];
  const potions = Array.isArray(helper.potions) ? helper.potions : [];
  const ball = balls.find(b => b.id === helper.autoCatchBallId) ?? null;
  const potion = potions.find(p => (p.id ?? p.itemId) === helper.autoPotionItemId) ?? null;
  const reviveRaw = helper.reviveCount ?? helper.revives ?? helper.reviveQty;
  return {
    ball: ball ? { name: ball.name ?? 'Pokébola', quantity: qty(ball), infinite: Boolean(ball.infinite), iconUrl: ball.iconUrl ?? null } : null,
    ballsTotal: balls.some(b => b.infinite) ? Infinity : balls.reduce((sum, b) => sum + qty(b), 0),
    potion: potion ? { name: potion.name ?? 'Poção', quantity: qty(potion) } : null,
    potionsTotal: potions.reduce((sum, p) => sum + qty(p), 0),
    revives: reviveRaw == null ? null : Number(reviveRaw),
    autoCatch: Boolean(helper.autoCatch),
    autoPotion: Boolean(helper.autoPotion),
    autoRevive: Boolean(helper.autoRevive)
  };
}

function computeAlerts(state, limits, now = Date.now()) {
  const alerts = [];
  const box = state.box;
  if (box && box.capacity > 0) {
    const ratio = box.count / box.capacity;
    if (ratio >= 1) alerts.push({ key: 'box', level: 'danger', text: `Caixa cheia (${box.count}/${box.capacity}): auto-captura parada.` });
    else if (ratio >= limits.boxRatio) alerts.push({ key: 'box', level: 'danger', text: `Caixa quase cheia (${box.count}/${box.capacity}).` });
  }
  if (state.autohelper) {
    const s = supplies(state);
    if (s.autoCatch && !s.ball) alerts.push({ key: 'balls', level: 'danger', text: 'A pokébola da auto-captura acabou.' });
    else if (s.autoCatch && s.ball && !s.ball.infinite && s.ball.quantity < limits.ballsMin) {
      alerts.push({ key: 'balls', level: 'warning', text: `${s.ball.name}: restam ${s.ball.quantity}.` });
    }
    const potionQty = s.potion ? s.potion.quantity : s.potionsTotal;
    if (s.autoPotion && potionQty < limits.potionsMin) alerts.push({ key: 'potions', level: 'warning', text: `Poções: restam ${potionQty}.` });
    if (s.autoRevive && s.revives != null && s.revives < limits.potionsMin) alerts.push({ key: 'revive', level: 'warning', text: `Revives: restam ${s.revives}.` });
  }
  if (state.sessionExpiresAt && state.sessionExpiresAt - now < 2 * 86400000) {
    const hours = Math.max(0, Math.round((state.sessionExpiresAt - now) / 3600000));
    alerts.push({ key: 'session', level: 'warning', text: `Sessão vence em ${hours} h: faça login no jogo e clique em Enviar para o cockpit.` });
  }
  const lastActivity = state.lastKillAt ?? state.connectedAt;
  if (state.status === 'online' && lastActivity && now - lastActivity > 3 * 60000) {
    const minutes = Math.round((now - lastActivity) / 60000);
    alerts.push({ key: 'stalled', level: 'danger', text: state.hunt
      ? `Nenhum kill há ${minutes} min: a conta pode ter parado de caçar.`
      : 'Fora de hunt: abra a sessão e entre numa hunt.' });
  }
  if (state.leaderFainted) alerts.push({ key: 'fainted', level: 'danger', text: 'Líder desmaiado.' });
  if (state.status === 'error') alerts.push({ key: 'conn', level: 'danger', text: state.error || 'Conta com erro.' });
  else if (['offline', 'connecting'].includes(state.status) && state.offlineSince &&
           now - state.offlineSince > limits.offlineMinutes * 60000) {
    alerts.push({ key: 'conn', level: 'danger', text: `Desconectada há mais de ${limits.offlineMinutes} min.` });
  }
  return alerts;
}

module.exports = { computeAlerts, supplies };
