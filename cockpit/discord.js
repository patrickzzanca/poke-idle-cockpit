'use strict';

class DiscordNotifier {
  constructor({ getWebhookUrl }) {
    this.getWebhookUrl = getWebhookUrl;
    this.lastAlerts = new Map();
  }

  async send(payload) {
    const url = this.getWebhookUrl();
    if (!url) return;
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (err) {
      console.warn('Erro ao enviar webhook para o Discord:', err.message);
    }
  }

  async sendHighlight({ accountName, poke }) {
    const isShiny = Boolean(poke.shiny);
    const color = isShiny ? 0xFFD700 : 0x3498DB; // Dourado para shiny, azul para raro/top
    const tagText = (poke.tags || []).join(' · ');
    const spriteUrl = poke.speciesId
      ? `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${isShiny ? 'shiny/' : ''}${poke.speciesId}.png`
      : null;

    await this.send({
      embeds: [{
        title: isShiny ? '✨ SHINY CAPTURADO! ✨' : '⭐ Destaque de Captura!',
        color,
        thumbnail: spriteUrl ? { url: spriteUrl } : undefined,
        fields: [
          { name: 'Treinador', value: accountName || 'Desconhecido', inline: true },
          { name: 'Pokémon', value: `${isShiny ? '✨ ' : ''}**${poke.name}** (Nv ${poke.level ?? '?'})`, inline: true },
          { name: 'Qualidade / IV', value: `Q: **${poke.quality != null ? Number(poke.quality).toFixed(2) : '—'}** | IV: **${poke.ivTotal ?? '—'}**`, inline: true },
          { name: 'Tags', value: tagText || 'Nenhuma', inline: false }
        ],
        footer: { text: 'Poke Idle Cockpit 24/7 · Gandalf' },
        timestamp: new Date().toISOString()
      }]
    });
  }

  async sendAlert(accountName, accountId, key, text, level) {
    const alertKey = `${accountId}:${key}`;
    const now = Date.now();
    const lastSent = this.lastAlerts.get(alertKey) || 0;
    // Debounce de 30 minutos para o mesmo alerta
    if (now - lastSent < 30 * 60 * 1000) return;
    this.lastAlerts.set(alertKey, now);

    const color = level === 'danger' ? 0xE74C3C : 0xE67E22; // Vermelho ou Laranja
    await this.send({
      embeds: [{
        title: `⚠️ Alerta: ${accountName}`,
        description: text,
        color,
        timestamp: new Date().toISOString()
      }]
    });
  }

  clearAlert(accountId, key) {
    this.lastAlerts.delete(`${accountId}:${key}`);
  }
}

module.exports = { DiscordNotifier };
