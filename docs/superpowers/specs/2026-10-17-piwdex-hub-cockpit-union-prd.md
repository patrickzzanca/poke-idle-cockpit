# PRD: Unificação Piwdex Hub (Desktop Client) + Poke Idle Cockpit (Backend 24/7)

**Issue no GitHub:** [#4](https://github.com/patrickzzanca/poke-idle-cockpit/issues/4)  
**Data:** 2026-10-17 · **Status:** Pronto para Planejamento/Implementação (`ready-for-agent`)

---

## Problem Statement

The user currently faces an operational dichotomy between two separate tools for managing their *Poke Idle World* accounts:

1. **Poke Idle Cockpit (Gandalf Server):** A lightweight, headless Node.js service running 24/7 in a Docker container on Gandalf. It provides advanced hunting expeditions, automated bag liquidation (undercutting market orders with NPC floor limits), market opportunity radar, breeder calculator, and Discord notifications at near-zero CPU and <40 MB RAM. However, it lacks a dedicated multi-window visual client on the desktop for actively watching battles, evolving Pokémon, or managing 4 accounts simultaneously without video streaming latency or keeping dozens of browser tabs open.
2. **Piwdex Hub (Aragorn PC):** An Electron desktop client on the primary workstation designed specifically for running up to 4 accounts in a split-grid or tabbed layout with individual audio mute, per-account zoom, system tray minimization, and memory leak watchdogs. However, its automation capabilities are primitive (simple shiny/faint notifications and a blind "return to current hunt" button), it lacks intelligent route expeditions, market intelligence, and breeder synergy, and all operations halt the moment the desktop PC is turned off.

Operating these tools in silos causes fragmented session tokens, desynchronized hunting targets, duplicate WebSocket sniffing code, and manual effort to transfer credentials between environments.

---

## Solution

Unify **Piwdex Hub** (Desktop Visual Client) and **Poke Idle Cockpit** (24/7 Homelab Automation Server) into an integrated Client-Server architecture:

- **Gandalf Cockpit as the Headless Core & Source of Truth:** Manages 24/7 hunting expeditions, automated market tracking, breeder algorithms, token persistence, and Discord alerts.
- **Piwdex Hub as the Native Desktop Cockpit UI:** Provides the primary visual interface on Aragorn with 4 split-view webviews, per-account sound/zoom control, and memory watchdogs.
- **Bi-directional Handoff Protocol:** When Piwdex Hub opens on the desktop, it claims active session tokens from Gandalf and transitions Cockpit to spectator/standby mode; when Piwdex Hub closes or the PC shuts down, Cockpit seamlessly reassumes headless 24/7 hunting.
- **Unified In-Game Augmentation:** Inject the Cockpit HUD, Pokédex completion badges, and IV/Quality tooltips directly into the Piwdex Hub webview preload layers, with live telemetry streaming back to Cockpit.

---

## User Stories

1. As a player, I want Piwdex Hub to automatically retrieve my 4 account tokens from the Cockpit server on launch, so that I never have to manually re-login or copy tokens between machines.
2. As a player, I want Piwdex Hub to inform the Cockpit server when a desktop visual session starts, so that Cockpit pauses headless hunt commands and avoids duplicate WebSocket session conflicts (error 4005).
3. As a player, I want the Cockpit server to automatically resume headless hunting within 90 seconds of Piwdex Hub closing or shutting down, so that my accounts continue hunting 24/7 without interruption.
4. As a player, I want all 4 webviews in Piwdex Hub to display the in-game Cockpit HUD (progress, target hunt, kill counter), so that I have identical in-game telemetry on desktop as on the web userscript.
5. As a player, I want Pokémon tooltips inside Piwdex Hub to display IV Total, Quality, and Pokédex status badges, so that I can immediately evaluate caught Pokémon during manual gameplay.
6. As a player, I want Piwdex Hub's WebSocket sniffer to forward captured frames (captures, kills, drops, shiny encounters) to the Cockpit server, so that Cockpit's statistics, history, and Discord webhooks stay up to date during visual play.
7. As a player, I want to view and activate Cockpit hunting route presets (e.g. Pokédex missing species, level brackets) directly from Piwdex Hub, so that I do not need a separate browser window to trigger expeditions.
8. As a player, I want Piwdex Hub to notify Cockpit when a token refresh occurs in the desktop webview, so that the renewed refresh token is persisted to Cockpit's `accounts.json` on Gandalf immediately.
9. As a player, I want Piwdex Hub to embed or link directly to Cockpit's Bag and Market Assistant, so that I can execute 1-click batch item sales and inspect market depth without leaving the desktop app.
10. As a player, I want Piwdex Hub to display Cockpit's Breeder recommendations alongside my account boxes, so that I can identify high-IV and high-Quality pairs for breeding.
11. As a player, I want desktop system tray audio notifications when Cockpit detects a critical event (Shiny encounter, team faint, or Box reaching 90% capacity), so that I am alerted even if the Hub is minimized.
12. As a player, I want Piwdex Hub's memory watchdog to gracefully reload an overloaded webview without losing Cockpit session state, so that long gaming sessions remain stable.
13. As a player, I want Piwdex Hub to support offline/degraded mode if the Gandalf server is temporarily unreachable, so that I can still play locally and reconnect telemetry when the server returns.
14. As a player, I want clear visual status indicators in Piwdex Hub showing whether each account is currently controlled by Desktop Visual Mode or Gandalf Headless Mode, so that I always know which environment is driving the game.

---

## Implementation Decisions

### Module & Service Topology
- **Server Authority (Gandalf):** Cockpit remains the authority for `accounts.json`, route execution state, market scanning, breeder calculations, and Discord webhooks.
- **Client Consumer (Aragorn):** Piwdex Hub acts as an authenticated client consuming Cockpit's REST API and Server-Sent Events (`/events`) stream.

### Architecture & Protocol Contracts
- **Session Claim & Token Synchronization:**
  - On startup, Piwdex Hub queries `GET /api/accounts` from Cockpit to fetch account profiles and valid session tokens.
  - Hub initializes webview partitions with `sessionStorage['pokeweb:tokens']`.
  - When tokens are rotated via webview, Hub posts `POST /api/bridge/heartbeat` with the new credentials to persist them on Gandalf.
- **Handoff State Machine:**
  - An account transitions through: `OFFLINE` ➔ `HEADLESS_HUNTING` (Cockpit active) ➔ `HANDED_OFF` (Piwdex Hub visual mode active) ➔ `RESUMING` ➔ `HEADLESS_HUNTING`.
  - Piwdex Hub sends periodic heartbeats (every 30s) while a webview is open; Cockpit sets a 90s grace period after the last heartbeat or receives `POST /api/bridge/release` before resuming headless socket operations.
- **In-Game Augmentation Injection:**
  - The logic from `piw.user.js` (HUD, tooltip IV calculator, missing Pokédex overlay) is consolidated into a shared bundle and injected via Piwdex Hub's `saida/preload-jogo.js`.
  - Telemetry hooks in `preload-jogo.js` are updated to report structured events directly to Cockpit's HTTP ingest endpoints.
- **Security & Network Boundaries:**
  - Cross-Origin Resource Sharing (CORS) and origin validation on Cockpit (`server.js`) are adjusted to permit requests originating from Electron local files (`file://`, `capacitor://`, or custom scheme) alongside existing local subnet IPs (`192.168.100.x`).
  - Sensitive files (`accounts.json`, `machine.json`) remain strictly confined to local storage and Gandalf bind mounts, never bundled into public code.

---

## Testing Decisions

### What Makes a Good Test
- Tests must verify external behavioral contracts, network boundaries, and state transitions rather than private implementation details or DOM rendering.
- No live requests should hit the official `poke.idleworld.online` game servers during automated test execution.

### Modules & Seams to Test
- **Handoff State Machine Contract:** Test that starting a visual session cleanly suspends headless socket reconnects, and terminating heartbeats triggers safe headless resumption without duplicate connection collisions (code 4005).
- **Token Exchange & Persistence:** Test that invalid/expired tokens trigger refresh flows and update the server store, handling corrupted or rate-limited responses gracefully.
- **Telemetry Ingestion & Event Forwarding:** Test that WebSocket frame fixtures (`pokes-get`, `poke-delta`, `field-init`, `enter-hunt`) injected via mock clients produce expected updates in Cockpit's collection ledger, XP counters, and Discord notification triggers.
- **Network Resilience:** Test that Piwdex Hub survives Cockpit server restarts or transient network dropouts without crashing the Electron renderer or losing user input.

### Prior Art
- Existing test fixtures and specifications in `Z:\docker\poke-cockpit\docs\superpowers\specs\2026-10-01-piw-cockpit-design.md`.
- Node.js native test runner (`node --test`) using mock WebSocket servers and mock REST responders.

---

## Out of Scope

- Bypassing or automating Cloudflare Turnstile CAPTCHA during initial user registration/login.
- Active combat botting or cheating mechanisms that violate game invariants beyond existing route automation.
- Rewriting Piwdex Hub from scratch in a different desktop technology (we maintain the existing Electron foundation and inject Cockpit capabilities surgically).
- Mobile native application development.

---

## Further Notes

- Gandalf server path: `/mnt/Sam/docker/poke-cockpit/` (accessible on Aragorn via Samba share `Z:\docker\poke-cockpit\`).
- Cockpit web UI port: `http://192.168.100.103:8787`.
- Piwdex Hub source tree: `Z:\Gemini Playground\Study\Piwdex-Hub-0.3.5-windows`.
