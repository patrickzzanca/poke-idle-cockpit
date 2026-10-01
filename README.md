# 🎮 Poke Idle Cockpit

Painel de controle local e automação *headless* 24/7 para **[Poke Idle World](https://poke.idleworld.online/)**, com suporte a múltiplas contas, classificação inteligente de espécies, estimativas de rendimento, alertas em tempo real no Discord e integração com Docker / CasaOS.

---

## ⚡ Destaques e Funcionalidades

- **🪶 Ultraleve e Headless:** Conecta-se diretamente à API e WebSockets do jogo. Dispensa navegador aberto, consumindo menos de 40 MB de memória RAM e quase 0% de CPU.
- **👥 Múltiplas Contas (até 4):** Acompanhe o progresso de várias contas simultaneamente no mesmo painel.
- **🔔 Notificações no Discord:**
  - ✨ **Shinies capturados:** Card temático dourado com sprite oficial do Pokémon via PokéAPI.
  - ⭐ **Pokémons Raros / Top IV:** Destaques automáticos baseados na qualidade e potencial genético.
  - ⚠️ **Alertas de Suprimentos:** Avisa quando as Pokébolas de auto-captura acabarem ou quando a Box atingir 90% da capacidade.
- **⏳ Estimativas Inteligentes:**
  - Cálculo dinâmico do tempo até esgotar as Pokébolas ativas (ex: `esgota em ~8h 20m`).
  - Cálculo do tempo até a Box lotar (ex: `cheia em ~12h 45m`).
- **📋 Gestão de Coleção:**
  - Filtros por Tag, Tipo e Busca textual.
  - Seleção em lote com um clique pós-filtragem (`Selecionar tudo` / `Desmarcar`).
  - Proteção estrita contra venda acidental de pokémons do time ativo, shinies, raros ou com cadeado 🔒.
- **🏪 Scanner de Mercado:** Varredura em tempo real dos anúncios de venda de pokémons.

---

## 🛠️ Requisitos

- **Node.js** 22 ou superior (usa módulos nativos do Node; sem dependências de pacotes externos no `node_modules`).
- **Tampermonkey** instalado no navegador (Chrome, Firefox, Brave ou Edge).
- *(Opcional)* **Docker** e **Docker Compose** para execução 24/7 em servidores locais (ex: Homelab, Raspberry Pi, CasaOS).

---

## 🚀 Como Executar

### Opção 1: Execução Local (PC / Desktop)

1. Clone o repositório ou baixe os arquivos:
   ```bash
   git clone <URL_DO_REPOSITORIO>
   cd poke-cockpit
   ```

2. Inicie o servidor:
   ```bash
   npm start
   # Ou no Windows: execute o arquivo iniciar-cockpit.bat
   ```

3. Abra o painel no navegador:
   👉 **`http://localhost:8787`**

---

### Opção 2: Servidor 24/7 (Docker / CasaOS / Linux)

O projeto inclui um `docker-compose.yml` otimizado baseado na imagem oficial `node:22-alpine`:

```bash
docker compose up -d
```

O painel ficará disponível no IP do seu servidor na porta `8787`:
👉 **`http://<IP-DO-SERVIDOR>:8787`**

> **💡 Dica para CasaOS:** O arquivo `docker-compose.yml` já contém os metadados nativos (`x-casaos`) com ícone oficial de Pokébola. Basta importar o Compose pela interface para criar o card automático no dashboard.

---

## 🔌 Configurando a Conexão com o Jogo

1. **Instalar o Userscript no Navegador:**
   * Com o cockpit rodando, acesse no navegador onde você joga:
     `http://<IP-OU-LOCALHOST>:8787/piw.user.js`
   * O Tampermonkey abrirá a tela de confirmação. Clique em **Instalar** (ou *Confirmar Instalação*).
   * *(O userscript detecta automaticamente o IP de onde foi baixado e configura as permissões de rede).*

2. **Vincular suas Contas:**
   * Faça login no jogo normalmente pelo navegador.
   * Repare no canto inferior direito da tela: clique no botão **🔗 Enviar para o cockpit**.
   * Faça isso para cada conta que você deseja monitorar.

3. **Modo Automático:**
   * Enquanto você joga na aba do navegador, o cockpit permanece em modo passivo (*"No navegador"*).
   * Ao fechar a aba do jogo, o cockpit assume a caça e o gerenciamento em segundo plano após ~90 segundos.

---

## 🔔 Configuração de Alertas no Discord

Para receber notificações no seu servidor do Discord:

1. No Discord, vá nas configurações do canal desejado ➔ **Integrações** ➔ **Webhooks** ➔ **Novo Webhook** e copie o link gerado.
2. Você pode definir a URL do Webhook de duas formas:
   - **Via Variável de Ambiente:** No `docker-compose.yml` ou `.env`:
     ```yaml
     environment:
       - DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
     ```
   - **Via Arquivo de Configuração:** Crie o arquivo `cockpit/config.json` a partir do `config.example.json`:
     ```json
     {
       "discordWebhook": "https://discord.com/api/webhooks/...",
       "alerts": {
         "boxRatio": 0.9,
         "ballsMin": 100,
         "potionsMin": 20,
         "offlineMinutes": 2
       }
     }
     ```

---

## 🏷️ Sistema de Tags Padrão

| Tag | Critério de Classificação |
|---|---|
| 💎 **Raro** | Shiny, Qualidade (Q) ≥ 1.7 ou Ditto (nunca vendido) |
| ⭐ **Top** | IV Total ≥ 170 e melhor exemplar da família evolutiva na conta |
| 🧬 **Matriz** | IV Total ≥ 165 |
| ⬆ **Upar** | IV Total ≥ 145 e Qualidade (Q) ≥ 1.5 |
| 🗑 **Lixo** | IV Total < 130 e Qualidade < 1.5, fora do time, sem cadeado |

---

## 🔒 Segurança e Dados Locais

- Os tokens de autenticação gerados pelo jogo ficam salvos localmente em `cockpit/accounts.json`.
- **Nunca envie ou publique** seu arquivo `accounts.json` ou `machine.json`. O arquivo `.gitignore` deste projeto já está configurado para proteger todos os arquivos sensíveis de sessão.

---

## ⚖️ Licença

Uso pessoal e privado. Projeto desenvolvido para monitoramento e gestão de sessões do jogo Poke Idle World.
