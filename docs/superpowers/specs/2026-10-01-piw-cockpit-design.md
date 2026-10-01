# PIW Cockpit — design

Data: 2026-10-01 · Status: aguardando revisão

## 1. Objetivo

Um painel local para acompanhar e gerenciar até 4 contas do Poke Idle World ao mesmo tempo, sem precisar manter uma aba do jogo aberta por conta.

O que o usuário pediu:

- **Cockpit:** mostrar as contas com nível, Pokémon atual, gold e diamantes.
- **Conexões:** manter as contas conectadas fora do navegador. O usuário assume o risco perante as regras do jogo.
- **Coleção:** ver a coleção, entender pontos fortes e fracos e, principalmente, achar o lixo e vendê-lo rápido.
- **Tags:** padronizar as tags no sistema todo (cards do jogo, cockpit e mercado).
- **Destaques:** o jogo captura muito lixo, então o cockpit mostra só as capturas boas.
- **Mercado:** varrer o mercado por tag, como já faz o `editado.js`.
- **Abrir sessão:** um botão que abre uma aba do jogo já logada na conta, para as ações que ficam no jogo (loja, hunt, held, máquinas).

### Critério de sucesso

- **Abrir:** um único `node cockpit/server.js` abre o cockpit em `http://localhost:8787`, com as contas conectadas e os números atualizando.
- **Classificar:** a mesma função de tags produz o mesmo resultado nos cards do jogo, no cockpit e no mercado.
- **Vender:** vender o lixo de uma conta leva no máximo 2 cliques mais a confirmação, e nunca inclui Pokémon protegidos.
- **Trocar para o jogo:** o "Abrir sessão" entrega uma aba logada, e o cockpit reassume a conexão quando a aba fecha.

### Fora do escopo (YAGNI)

- **Ações de jogo no cockpit:** comprar itens, trocar a hunt, held, TM e máquinas ficam no jogo, via "Abrir sessão".
- **Automação de ações:** nada de vender sozinho, capturar ou comprar. Toda ação parte de um clique.
- **Imitar o cliente oficial:** nada de falsificar o fingerprint `cmid` nem simular tráfego de tela (`view`, `field-get`).
- **Login automático:** o login exige o captcha Turnstile, então é sempre feito pelo usuário no site oficial.

## 2. Fatos do protocolo (extraídos do bundle do jogo em 2026-10-01)

| Item | Detalhe |
|---|---|
| WebSocket | `wss://poke.idleworld.online/ws?token=<accessToken>[&cmid=…]`. Shard = djb2(`sub` do JWT) % 66. Shard 0 usa a URL base; nos outros, o número vai como sufixo do path (`/ws<n>`). |
| Keep-alive | O cliente manda `{"type":"ping"}` após 45 s sem mensagens e fecha se não houver resposta em 15 s. |
| Códigos de fechamento | 4001 token inválido (renovar) · 4002 recarregar · 4003 manutenção · 4005 sessão substituída · 4006 limite de IP · 4007 limite de máquina · 4008 bloqueio de nome · 4009 troca de senha |
| Tokens | `{accessToken, refreshToken}`. Ficam em `sessionStorage["pokeweb:tokens"]` e o jogo migra o valor da `localStorage` se ele estiver lá. Renovação: `POST /api/auth/refresh {refreshToken}`. |
| Login | `POST /api/auth/login {identifier, password, captchaToken}`, com Turnstile ligado. **Não é usado pelo cockpit.** |
| Coleção | Envia `pokes-get` e recebe `{type:"pokes", list}`. Atualizações incrementais: `poke-delta {poke}` e `poke-xp {id, xp, level}`. |
| Auto Helper | `autohelper-get` → `{type:"autohelper", autoCatch, balls[], potions[], pokeCount, pokeCapacity, isVip, …}` |
| Hunt | `enter-hunt {slug}` e `leave-hunt`. O servidor manda `hunt-cooldown {ms}` e o cliente reenvia `enter-hunt`. |
| Venda | `POST /api/game/pokemon/sell {pokeIds:[…]}` → `{gold, goldGained, sold}` |
| Cadeado | `POST /api/game/pokemon/lock {id, locked}` |
| Personagem | `GET /api/characters/me` → `{character:{gold, diamonds, …}}` |
| Mercado | `GET /api/game/market?category=Pokemon&page=N` |
| Espécies | `GET /game/creatures.json` → `{creatures:[{pokeId, name, type1, type2, rarity, baseHp…baseSpeed, evolvesToId, evolveLevel, sellValue, attacks[]}]}` |

**A confirmar na primeira conexão real** (registrar como fixtures em `cockpit/test/fixtures/`):

1. Se o servidor aceita o socket sem `cmid`. Se recusar, **parar e decidir com o usuário**; nada de forjar.
2. Se o servidor exige `Origin`. O `WebSocket` nativo do Node não envia esse header, e não vamos forjá-lo.
3. O formato real de `pokes`, `autohelper`, `field-init` e `hunt-cooldown`, e de onde vem o slug da hunt atual.
4. Se basta reenviar `enter-hunt` com o último slug para a hunt continuar, ou se o servidor mantém a hunt sozinho.
5. Onde ficam o nível e o XP do treinador e o HP do líder.

## 3. Arquitetura

```
pk-ext/
  shared/
    classifier.js        classify(poke, ctx) → {tags, reasons}. Puro, sem I/O. UMD (Node + navegador).
    species.js           índice do creatures.json: linha evolutiva, Power, tipos.
  cockpit/
    server.js            HTTP: arquivos estáticos, API JSON local, SSE /events
    account.js           class Account: tokens, refresh, WebSocket, reconexão, estado
    store.js             leitura/escrita de accounts.json e config.json
    market.js            varredura paginada do mercado (portada do editado.js)
    handoff.js           códigos de uso único para "Abrir sessão" e "Enviar para o cockpit"
    public/index.html    interface (JS puro, sem build)
    public/app.js
    test/                node --test + fixtures
    accounts.json        refresh tokens (local, no .gitignore)
    config.json          cortes das tags (opcional; sobrescreve os padrões)
  userscript/
    piw.user.js          tags nos cards, ponte com o cockpit
  editado.js, script-original.js   referência (não são alterados)
```

Requisito: Node ≥ 22, por causa do `WebSocket` e do `fetch` nativos. Zero dependências npm.

### 3.1 Account (cockpit/account.js)

**Máquina de estados:** `offline → connecting → online(hunting|idle|cooldown) → handedOff | replaced | error`.

**Responsabilidades:**

- **Renovar o token:** antes de conectar e ao receber 4001. No 4001 tenta no máximo 2 vezes; depois vai para `error` com "Token expirou, faça login de novo".
- **Conectar:** abre o socket no shard calculado. Na abertura envia `pokes-get`, `autohelper-get` e `balls-get`. O `ping` segue a mesma regra do cliente oficial.
- **Reconectar:** backoff de 1,5 s até 24 s, com jitter. Não reconecta em 4003–4009. Em especial, **4005 vai para `replaced`**, porque a conta foi aberta em outro lugar e o cockpit não briga pela sessão.
- **Manter o estado:** `trainer`, `gold`, `diamonds`, `leader`, `hunt`, `box {count, capacity}`, `autohelper`, `pokes[]`, `lastSeenIds`.
- **Detectar capturas:** ids que aparecem num `pokes` e não estavam no anterior. A primeira carga não conta como captura.
- **Emitir eventos:** `state`, `capture`, `alert` e `log`, que o server repassa por SSE.
- **Persistir o token:** grava todo token renovado em `accounts.json` imediatamente, porque o refresh token pode rotacionar.

### 3.2 Ponte com o jogo (handoff)

O userscript usa `GM_xmlhttpRequest` com `@connect localhost` para falar com `http://localhost:8787`. Isso evita os problemas de CORS e de Private Network Access.

**Enviar para o cockpit (primeiro login):**

1. O usuário faz login no site oficial e resolve o captcha.
2. O userscript mostra o botão "Enviar para o cockpit".
3. O clique faz `POST /api/bridge/register {tokens}`.
4. O cockpit lê `GET /api/characters/me` com esse token para descobrir o nome da conta, grava em `accounts.json` e conecta.

**Abrir sessão:**

1. O clique no cockpit cria um código de uso único (válido por 60 s) e coloca a conta em `handedOff`, com o socket fechado e o reconnect suspenso.
2. O cockpit abre `https://poke.idleworld.online/play#piw=<código>`.
3. O userscript roda em `document-start`, lê o hash, faz `GET /api/bridge/claim/<código>` e recebe os tokens.
4. Ele grava os tokens em `sessionStorage["pokeweb:tokens"]`, limpa o hash com `history.replaceState` e deixa o jogo carregar.
5. A cada 30 s o userscript manda `POST /api/bridge/heartbeat {account, tokens}`. Isso devolve os tokens renovados pela aba e avisa que ela continua viva.
6. Quando o heartbeat para por 90 s (aba fechada) ou chega `POST /api/bridge/release` no `pagehide`, o cockpit sai de `handedOff` e reconecta.

**Limite de 4 contas:** o cockpit recusa cadastrar uma 5ª conta.

### 3.3 Server (cockpit/server.js)

Escuta só em `127.0.0.1`. A API JSON é usada pela página e pelo userscript:

| Rota | Função |
|---|---|
| `GET /api/accounts` | estado resumido de todas as contas |
| `GET /api/accounts/:id/pokes` | coleção com as tags já calculadas |
| `POST /api/accounts/:id/sell {pokeIds}` | revalida no servidor (ver §5) e chama o endpoint do jogo |
| `POST /api/accounts/:id/lock {pokeId, locked}` | cadeado |
| `POST /api/accounts/:id/open` | gera o handoff e devolve a URL |
| `POST /api/accounts/:id/reconnect` · `DELETE /api/accounts/:id` | reconectar · remover conta |
| `POST /api/market/scan {tag, element, sort, accountId}` | varredura do mercado com progresso por SSE |
| `GET /events` | SSE com `state`, `capture`, `alert`, `market-progress` |
| `/api/bridge/*` | rotas da §3.2 |

**Segurança local:** as rotas `/api/bridge/*` só aceitam pedidos com o header `X-PIW-Bridge: 1`, que o `GM_xmlhttpRequest` envia. As outras exigem `Origin` igual a `http://localhost:8787`. Isso impede que um site qualquer aberto no navegador chame a API local.

## 4. Classificador unificado (shared/classifier.js)

Função pura `classify(poke, ctx)`:

- **`poke`:** `{id, speciesId, quality, ivTotal, shiny, isDitto, team, starter, locked, level}`
- **`ctx`:** `{family(speciesId) → familyId, collection: poke[], config}`

As comparações acontecem dentro da **linha evolutiva** (`familyId` = espécie base, obtida seguindo `evolvesToId` no sentido inverso).

**Cortes padrão:** cerca de 12% acima da proposta inicial, a pedido do usuário, para que só o que é realmente bom ganhe tag. IV vai de 6 a 192. Todos os cortes ficam em `config.json`.

| Tag | Regra | Prioridade |
|---|---|---|
| 💎 `raro` | `shiny` **ou** `quality ≥ 1.7` **ou** `isDitto` | 1 |
| ⭐ `top` | `ivTotal ≥ 170` **e** é o maior IV da linha evolutiva na coleção. Empate: maior Q. | 2 |
| 🧬 `matriz` | `ivTotal ≥ 165` | 3 |
| ⬆ `upar` | `ivTotal ≥ 145` **e** `quality ≥ 1.5` | 4 |
| 🗑 `lixo` | `ivTotal < 130` **e** `quality < 1.5` **e** não tem nenhuma das tags acima **e** não é `team`, `starter` nem `locked` | — |
| *(nenhuma)* | meio-termo | — |

- **Combinação:** um Pokémon pode ter várias tags (ex.: `top` + `matriz`). Na UI compacta (slot do inventário) aparece só a de maior prioridade.
- **Explicação:** `reasons` traz o motivo em texto curto (ex.: "IV 171, melhor Charmander da conta").
- **Raro mantém Q ≥ 1,7:** é o piso da faixa Lendária. Capturas selvagens vão no máximo até 1,8, então subir esse corte em 12% eliminaria a tag nas capturas.

**No mercado:** `ctx.collection` é a coleção da conta escolhida. O anúncio ganha a tag como se já fosse da conta; "⭐ top" significa que ele superaria o seu melhor da linha. `lixo` não aparece no mercado.

**No userscript:** o card só é identificado pelo `id` do Pokémon. Se o card não expuser o `id`, o casamento por nome, nível, IV e Q é aceito apenas quando há um único candidato. As tags `top`/`matriz` nunca são mostradas por aproximação.

## 5. Venda rápida

1. O cartão da conta mostra **Lixo (N)**, em que N conta as tags `lixo`.
2. O clique abre um modal com a lista já marcada: espécie, nível, IV, Q, `sellValue` e o total em gold. Desmarcar é livre.
3. Ao confirmar, a página chama `POST /api/accounts/:id/sell`.
4. O server **revalida no servidor** contra o estado atual da conta e remove qualquer id que seja `team`, `starter`, `locked`, `shiny` ou `raro`, ou que não exista mais. Se nada sobrar, responde erro sem chamar o jogo.
5. Com os ids que sobraram, faz uma única chamada a `POST /api/game/pokemon/sell`, envia `pokes-get` e mostra "Vendidos X por $Y".

A venda nunca acontece sem clique. Não existe venda automática.

## 6. Destaques e alertas

**Destaques:** um feed com as capturas que receberam `raro`, `top` ou `matriz`, com filtros por conta e por tag. O lixo aparece só como contador por conta e por janela ("+48 lixo nas últimas 2 h"). O feed mantém as últimas 500 entradas em memória e não é persistido.

**Alertas** (cada um com o botão "Abrir sessão"):

| Alerta | Condição |
|---|---|
| 🔴 Caixa quase cheia | `pokeCount / pokeCapacity ≥ 0.9` (`≥ 1.0` = "auto-captura parada") |
| 🟠 Pokébolas acabando | a bola configurada em `autoCatchBallId` está abaixo de 100 e não é infinita |
| 🟠 Poção/Revive acabando | `autoPotion`/`autoRevive` ligados e o item abaixo de 20 |
| 🔴 Líder desmaiado | evento de desmaio no campo (formato a confirmar, §2) |
| 🔴 Desconectada / token expirado | estado `error` ou `offline` por mais de 2 min |

Os limites ficam em `config.json`.

## 7. Interface

A página segue o esboço aprovado:

- **Faixa de totais:** contas online, gold total, diamantes e capturas do dia.
- **Grade 2×2 de cartões:** status, treinador e nível, local, líder com Q e IV, gold, diamantes, barra da caixa, e os botões Coleção, Lixo (N) e Abrir sessão.
- **Log de eventos.**

Abas: **Contas** (padrão) · **Coleção** (tabela filtrável de uma conta: espécie, tipo, nível, IV, Q, Power, tags; ordenação e filtro por tag, tipo e espécie; botão de cadeado) · **Destaques** · **Mercado** (controles do `editado.js`: tag, elemento, ordenação, buscar todas as páginas, cancelar; os resultados usam as tags unificadas).

O tema é escuro, inspirado no jogo. O layout funciona a partir de 1024 px de largura.

## 8. Erros

- **Erros de rede ou do jogo:** aparecem no log e no cartão da conta em português claro, nunca como stack trace.
- **`accounts.json` corrompido:** o cockpit faz backup como `.bak`, começa vazio e avisa.
- **creatures.json indisponível:** usa o cache em disco (`cockpit/.cache/creatures.json`). Sem cache, o Power e a linha evolutiva ficam "?" e as tags que dependem da linha (`top`) não são aplicadas.

## 9. Testes

- **Classificador** (`node --test`): cada tag, as precedências, as proteções do lixo, o empate no `top`, a linha evolutiva e o modo mercado.
- **Revalidação da venda:** ids protegidos nunca chegam à chamada do jogo, com o `fetch` mockado.
- **Cálculo do shard e da URL do socket:** comparado com a função original extraída do bundle.
- **Manual (checklist):** conectar 1 conta, cair e reconectar, Abrir sessão e fechar a aba, vender 1 lixo, varrer o mercado.

## 10. Ordem de entrega

1. `shared/` (classificador e espécies) com testes.
2. `cockpit/` conectando **uma** conta, só leitura. Neste ponto se coletam as fixtures e se respondem as perguntas da §2.
3. Venda e cadeado.
4. Ponte do userscript (enviar conta, Abrir sessão) e tags nos cards.
5. Destaques, alertas e mercado.
6. Multi-conta completo (4 cartões, totais).
