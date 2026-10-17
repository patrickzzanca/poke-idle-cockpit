# Plano de Implementação: Unificação Piwdex Hub + Poke Idle Cockpit

**Data:** 2026-10-17  
**PRD de Referência:** [docs/superpowers/specs/2026-10-17-piwdex-hub-cockpit-union-prd.md](../specs/2026-10-17-piwdex-hub-cockpit-union-prd.md)  
**Issue no GitHub:** [#4](https://github.com/patrickzzanca/poke-idle-cockpit/issues/4)  
**Arquitetura:** Node.js nativo (Node >= 22, sem pacotes npm externos) + Electron (Piwdex Hub)

---

## Visão Geral das Fases

O trabalho é dividido em 4 fases incrementais orientadas a testes (TDD) com commits frequentes:
1. **Fase 1 (Cockpit Bridge & CORS):** Extensão da API do Cockpit para permitir comunicação segura com o Piwdex Hub, ingestão de telemetria externa e handoff coordenado.
2. **Fase 2 (Sincronização de Tokens no Hub):** Integração do Piwdex Hub com a API do Cockpit para carregar contas e sincronizar rotações de tokens automaticamente.
3. **Fase 3 (Augmentations & HUD in-game):** Embutir os componentes visuais do `piw.user.js` (HUD, Pokédex badges, leitor de IV/Qualidade) no preload de webview do Hub.
4. **Fase 4 (Handoff Automático & Resiliência):** Transição de estados entre Headless 24/7 (Gandalf) e Visual Desktop (Aragorn) sem duplicação de sessões (erro 4005).

---

## Tarefa 1: Testes e Suporte a CORS/Origens do Electron no Cockpit Server

### Arquivos
- **Modificar:** `Z:\docker\poke-cockpit\cockpit\server.js`
- **Criar:** `Z:\docker\poke-cockpit\cockpit\test\server-origin.test.js`

### Interfaces
- **Consome:** Requisições HTTP com headers `Origin: null` ou `Origin: file://` e header de segurança `X-PIW-Bridge: 1`.
- **Produz:** Resposta HTTP com cabeçalhos CORS adequados para o cliente desktop Electron sem violar o isolamento do loopback.

### Passo 1: Escrever teste que falha
Criar `cockpit/test/server-origin.test.js` testando se a rota `/api/accounts` e `/api/bridge/heartbeat` aceitam requisições com `X-PIW-Bridge: 1` mesmo sem `Origin: http://localhost:8787`.
```javascript
import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
// teste disparando GET /api/accounts com X-PIW-Bridge: 1 esperando 200 OK
```

### Passo 2: Verificar que o teste falha
Executar `node --test cockpit/test/server-origin.test.js` e constatar que o teste falha por rejeição de Origin (403).

### Passo 3: Implementar código mínimo
Em `cockpit/server.js`, atualizar `isAllowedOrigin(req)` para aceitar requisições que contenham o header de segurança `X-PIW-Bridge: 1` ou venham da rede local `192.168.100.*`.

### Passo 4: Verificar que o teste passa
Executar `node --test cockpit/test/server-origin.test.js` e constatar sucesso (200 OK).

### Passo 5: Commit
`git commit -m "feat(server): aceitar requisicoes do cliente desktop com header bridge"`

---

## Tarefa 2: Endpoint de Ingestão de Telemetria do Hub no Cockpit

### Arquivos
- **Modificar:** `Z:\docker\poke-cockpit\cockpit\server.js`
- **Modificar:** `Z:\docker\poke-cockpit\cockpit\account.js`
- **Criar:** `Z:\docker\poke-cockpit\cockpit\test\telemetry-ingest.test.js`

### Interfaces
- **Consome:** `POST /api/bridge/telemetry` com payload `{ accountName, events: [{ type: 'capture'|'kill'|'shiny'|'faint', ... }] }`.
- **Produz:** Emissão dos eventos no canal SSE `/events` do Cockpit e acionamento dos webhooks do Discord correspondentes.

### Passo 1: Escrever teste que falha
Criar `cockpit/test/telemetry-ingest.test.js` enviando um evento de shiny e verificando se a conta no Cockpit acumula os dados de captura e dispara o alerta.

### Passo 2: Verificar que o teste falha
Executar `node --test cockpit/test/telemetry-ingest.test.js` e constatar erro 404 (endpoint não existe).

### Passo 3: Implementar código mínimo
Em `cockpit/server.js`, adicionar a rota `POST /api/bridge/telemetry`:
- Localiza a instância da `Account` correspondente.
- Invoca `account.ingestTelemetry(events)`.
- Atualiza estatísticas em memória e notifica clientes SSE.

### Passo 4: Verificar que o teste passa
Executar `node --test cockpit/test/telemetry-ingest.test.js` e constatar 200 OK e dados persistidos.

### Passo 5: Commit
`git commit -m "feat(telemetry): adicionar endpoint de ingestao de eventos externos"`

---

## Tarefa 3: Sincronização de Tokens e Configuração de Conexão no Piwdex Hub

### Arquivos
- **Modificar:** `Z:\Gemini Playground\Study\Piwdex-Hub-0.3.5-windows\resources\app\saida\principal.js`
- **Modificar:** `Z:\Gemini Playground\Study\Piwdex-Hub-0.3.5-windows\resources\app\saida\preload-casca.js`
- **Criar:** Teste unitário de sincronização em `cockpit/test/hub-sync.test.js`

### Interfaces
- **Consome:** `GET /api/accounts` do Cockpit Server (`http://192.168.100.103:8787`).
- **Produz:** Inicialização automática das 4 WebViews com os tokens atualizados do Cockpit e persistência de novos tokens obtidos pelo desktop.

### Passo 1: Escrever teste que falha
Criar mock de servidor Cockpit e verificar que um cliente simulando o Hub obtém os tokens das 4 contas e injeta na partição correta.

### Passo 2: Verificar que o teste falha
Constatar a falha antes da implementação do conector.

### Passo 3: Implementar código mínimo
- No Hub, adicionar rotina de bootstrap que consulta `http://192.168.100.103:8787/api/accounts`.
- Se o Cockpit estiver online, preenche as contas 1 a 4 com os nomes e tokens correspondentes.
- Se o Cockpit estiver offline, utiliza o fallback local salvo em cache.

### Passo 4: Verificar que o teste passa
Executar o teste de sincronização e validar o carregamento.

### Passo 5: Commit
`git commit -m "feat(hub): sincronizar tokens das contas com o servidor cockpit"`

---

## Tarefa 4: Injeção das Augmentations do Userscript no Preload do Jogo

### Arquivos
- **Criar:** `Z:\docker\poke-cockpit\shared\in-game-hud.js` (extração modular da lógica visual do `piw.user.js`)
- **Modificar:** `Z:\Gemini Playground\Study\Piwdex-Hub-0.3.5-windows\resources\app\saida\preload-jogo.js`
- **Criar:** `cockpit/test/hud-injection.test.js`

### Interfaces
- **Consome:** Dados do WebSocket em tempo real e DOM do jogo.
- **Produz:** Renderização do HUD retrátil superior, tooltips com IV Total / Qualidade e badges da Pokédex em cada uma das 4 WebViews.

### Passo 1: Escrever teste que falha
Testar em ambiente jsdom/mock DOM que a função de injeção renderiza o container `#piw-hud` e decodifica as tags da Pokédex para uma espécie.

### Passo 2: Verificar que o teste falha
Constatar que o HUD não é renderizado sem a chamada da rotina.

### Passo 3: Implementar código mínimo
- Modularizar `shared/in-game-hud.js` contendo o HUD retrátil, o estilo CSS injetado e a escuta de frames.
- No `preload-jogo.js`, após o carregamento da página do jogo, instanciar o HUD e repassar os eventos capturados para a telemetria do Cockpit.

### Passo 4: Verificar que o teste passa
Executar o teste e constatar que os elementos visuais são criados corretamente e os eventos registrados.

### Passo 5: Commit
`git commit -m "feat(hud): injetar hud do cockpit e badges de pokedex no preload do jogo"`

---

## Tarefa 5: Handoff Automático e Coordenação de Estados (Headless 24/7 ↔ Visual)

### Arquivos
- **Modificar:** `Z:\docker\poke-cockpit\cockpit\account.js`
- **Modificar:** `Z:\docker\poke-cockpit\cockpit\route-runner.js`
- **Criar:** `Z:\docker\poke-cockpit\cockpit\test\handoff-lifecycle.test.js`

### Interfaces
- **Consome:** `POST /api/bridge/heartbeat` (ativo a cada 30s) e `POST /api/bridge/release` (ao fechar o Hub).
- **Produz:** Transição da conta entre os modos `headless_hunting` e `handed_off`.

### Passo 1: Escrever teste que falha
Criar teste simulando uma conta caçando via `RouteRunner`. Enviar `heartbeat` e verificar que o runner suspende o envio de `enter-hunt`. Disparar `release` e verificar que o runner retoma a caça imediatamente.

### Passo 2: Verificar que o teste falha
Constatar que a conta continua enviando pacotes de caça concorrentes sem a lógica de suspensão por heartbeat.

### Passo 3: Implementar código mínimo
- Em `account.js`, quando receber heartbeat de sessão visual externa, suspender temporariamente a automação de caça ativa do Cockpit e marcar `state = 'handedOff'`.
- Ao receber `release` ou se passarem 90 segundos sem heartbeat, restabelecer a caça headless na última hunt configurada.

### Passo 4: Verificar que o teste passa
Executar `node --test cockpit/test/handoff-lifecycle.test.js` e constatar que a máquina de estados transiciona perfeitamente sem colisões.

### Passo 5: Commit
`git commit -m "feat(handoff): coordenar modo headless 24/7 e visual desktop sem colisoes"`

---

## Critérios de Aceite e Verificação Final

1. **Execução sem erros:** Todas as suítes de testes (`node --test cockpit/test/*.test.js`) devem passar de forma determinística e rápida (< 2 segundos).
2. **Zero dependências novas:** O Cockpit continua rodando 100% em Node nativo sem precisar de pacotes adicionais no `node_modules`.
3. **Resiliência a falhas de rede:** Se o servidor Gandalf estiver inacessível temporariamente, o Piwdex Hub deve continuar abrindo o jogo localmente sem travar.
4. **Sem erro 4005:** Nenhuma conta deve ser desconectada por conflito de sessão simultânea ao alternar entre desktop e servidor.
