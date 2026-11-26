import {
  GRID_WIDTH,
  GRID_HEIGHT,
  CELL_SIZE,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  TerrainType,
  MapTemplate,
  BuildingType,
  DEFENSE_POST_RADIUS,
  Waypoint,
  LobbySummary,
  PlayerNetState,
  BuildingNetState,
  DotNetState,
  ShipNetState,
  CombatEffectNet,
  ClientMessage,
  ServerMessage,
  decodeRLE,
} from './shared/types';

// ==========================================
// CLIENT INTERPOLATED ENTITIES
// ==========================================
interface RenderDot extends DotNetState {
  renderX: number;
  renderY: number;
}

interface RenderShip extends ShipNetState {
  renderX: number;
  renderY: number;
}

interface SparkParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  alpha: number;
  radius: number;
}

interface CommandMarker {
  x: number;
  y: number;
  color: string;
  radius: number;
  alpha: number;
}

const FACTION_COLORS = [
  '#3b82f6',
  '#ef4444',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#84cc16',
  '#f97316',
  '#14b8a6',
  '#e11d48',
  '#6366f1',
  '#a855f7',
  '#22c55e',
  '#eab308',
];

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const num = parseInt(clean, 16) || 0x3b82f6;
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

// ==========================================
// MAIN VEXFRONT.IO CLIENT ENGINE
// ==========================================
class VexFrontClient {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private minimapCanvas: HTMLCanvasElement;
  private minimapCtx: CanvasRenderingContext2D;

  // Offscreen 160x160 buffer for sharp, ultra-fast territory & terrain rendering
  private mapOffscreen: HTMLCanvasElement;
  private mapOffscreenCtx: CanvasRenderingContext2D;
  private mapImageData: ImageData;
  private mapDirty = true;

  private ws: WebSocket | null = null;
  private selfId = '';
  private inGame = false;
  private currentLobby: LobbySummary | null = null;

  private terrain: Uint8Array = new Uint8Array(GRID_WIDTH * GRID_HEIGHT);
  private territory: Uint8Array = new Uint8Array(GRID_WIDTH * GRID_HEIGHT);
  private supplyGrid: Uint8Array = new Uint8Array(GRID_WIDTH * GRID_HEIGHT);

  private players: Map<string, PlayerNetState> = new Map();
  private numIdToPlayer: Map<number, PlayerNetState> = new Map();
  private buildings: Map<string, BuildingNetState> = new Map();
  private dots: Map<number, RenderDot> = new Map();
  private ships: Map<string, RenderShip> = new Map();
  private particles: SparkParticle[] = [];
  private commandMarkers: CommandMarker[] = [];

  // Camera state
  private camX = WORLD_WIDTH / 2;
  private camY = WORLD_HEIGHT / 2;
  private camZoom = 0.65;
  private keysPressed: Set<string> = new Set();

  // RTS Selection & Input state
  private selectedColor: string = FACTION_COLORS[0];
  private selectedDotIds: Set<number> = new Set();
  private selectedBuildingIds: Set<string> = new Set();
  private activeBuildMode: BuildingType | null = null;
  private dispatchPercentage = 0.5;

  private isBoxSelecting = false;
  private boxStartScreen = { x: 0, y: 0 };
  private boxCurrentScreen = { x: 0, y: 0 };

  private isPanning = false;
  private panLastScreen = { x: 0, y: 0 };
  private mouseWorld = { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2 };

  private dashOffset = 0;

  constructor() {
    this.canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    this.minimapCanvas = document.getElementById('minimapCanvas') as HTMLCanvasElement;
    this.minimapCtx = this.minimapCanvas.getContext('2d')!;

    this.mapOffscreen = document.createElement('canvas');
    this.mapOffscreen.width = GRID_WIDTH;
    this.mapOffscreen.height = GRID_HEIGHT;
    this.mapOffscreenCtx = this.mapOffscreen.getContext('2d')!;
    this.mapImageData = this.mapOffscreenCtx.createImageData(GRID_WIDTH, GRID_HEIGHT);

    this.handleResize();
    window.addEventListener('resize', () => this.handleResize());

    this.initLobbyUI();
    this.initHUDControls();
    this.initCanvasInputs();
    this.connectWebSocket();

    requestAnimationFrame(() => this.renderLoop());
  }

  private handleResize(): void {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  // ==========================================
  // WEBSOCKET CONNECTION (DYNAMIC TRAEFIK/SSL)
  // ==========================================
  private connectWebSocket(): void {
    const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.addEventListener('open', () => {
      this.send({ type: 'list_lobbies' });
    });

    this.ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data) as ServerMessage;
        this.handleServerMessage(msg);
      } catch {
        // ignore malformed packets
      }
    });

    this.ws.addEventListener('close', () => {
      setTimeout(() => this.connectWebSocket(), 2000);
    });
  }

  private send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'lobby_list': {
        this.renderLobbyList(msg.lobbies);
        break;
      }

      case 'init': {
        this.selfId = msg.selfId;
        this.currentLobby = msg.lobby;
        this.terrain = decodeRLE(msg.terrainRLE, GRID_WIDTH * GRID_HEIGHT);
        this.territory = decodeRLE(msg.territoryRLE, GRID_WIDTH * GRID_HEIGHT);
        this.supplyGrid = decodeRLE(msg.supplyRLE, GRID_WIDTH * GRID_HEIGHT);
        this.mapDirty = true;

        this.selectedDotIds.clear();
        this.selectedBuildingIds.clear();
        this.dots.clear();
        this.buildings.clear();
        this.ships.clear();

        this.inGame = true;
        document.getElementById('lobbyOverlay')?.classList.add('hidden');
        document.getElementById('hudContainer')?.classList.remove('hud-hidden');

        // Focus camera on player's initial territory on first state packet
        setTimeout(() => this.focusCameraOnSelf(), 120);
        break;
      }

      case 'full_map_sync': {
        this.currentLobby = msg.lobby;
        this.terrain = decodeRLE(msg.terrainRLE, GRID_WIDTH * GRID_HEIGHT);
        this.territory = decodeRLE(msg.territoryRLE, GRID_WIDTH * GRID_HEIGHT);
        this.supplyGrid = decodeRLE(msg.supplyRLE, GRID_WIDTH * GRID_HEIGHT);
        this.mapDirty = true;
        this.selectedDotIds.clear();
        this.selectedBuildingIds.clear();
        setTimeout(() => this.focusCameraOnSelf(), 120);
        break;
      }

      case 'state': {
        this.currentLobby = msg.lobby;

        // Update players
        this.players.clear();
        this.numIdToPlayer.clear();
        for (const p of msg.players) {
          this.players.set(p.id, p);
          this.numIdToPlayer.set(p.numId, p);
        }

        // Apply territory deltas
        if (msg.territoryDeltas.length > 0) {
          for (const d of msg.territoryDeltas) {
            this.territory[d.idx] = d.ownerNumId;
          }
          this.mapDirty = true;
        }

        if (msg.supplyRLE) {
          this.supplyGrid = decodeRLE(msg.supplyRLE, GRID_WIDTH * GRID_HEIGHT);
          this.mapDirty = true;
        }

        // Update buildings
        this.buildings.clear();
        for (const b of msg.buildings) {
          this.buildings.set(b.id, b);
        }
        for (const selId of Array.from(this.selectedBuildingIds)) {
          const b = this.buildings.get(selId);
          if (!b || b.ownerId !== this.selfId) {
            this.selectedBuildingIds.delete(selId);
          }
        }

        // Update physical dots with smooth interpolation state
        const seenDots = new Set<number>();
        for (const d of msg.dots) {
          seenDots.add(d.id);
          const existing = this.dots.get(d.id);
          if (existing) {
            existing.ownerId = d.ownerId;
            existing.x = d.x;
            existing.y = d.y;
            existing.vx = d.vx;
            existing.vy = d.vy;
            existing.hp = d.hp;
            existing.troops = d.troops;
            existing.encircled = d.encircled;
            existing.fighting = d.fighting;
            existing.waypoints = d.waypoints;
          } else {
            this.dots.set(d.id, {
              ...d,
              renderX: d.x,
              renderY: d.y,
            });
          }
        }
        for (const oldId of Array.from(this.dots.keys())) {
          if (!seenDots.has(oldId)) {
            this.dots.delete(oldId);
            this.selectedDotIds.delete(oldId);
          }
        }

        // Update ships
        const seenShips = new Set<string>();
        for (const s of msg.ships) {
          seenShips.add(s.id);
          const existing = this.ships.get(s.id);
          if (existing) {
            existing.x = s.x;
            existing.y = s.y;
            existing.troops = s.troops;
          } else {
            this.ships.set(s.id, {
              ...s,
              renderX: s.x,
              renderY: s.y,
            });
          }
        }
        for (const oldShipId of Array.from(this.ships.keys())) {
          if (!seenShips.has(oldShipId)) {
            this.ships.delete(oldShipId);
          }
        }

        // Spawn combat spark particles
        for (const ef of msg.effects) {
          for (let i = 0; i < 3; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 0.6 + Math.random() * 1.8;
            this.particles.push({
              x: ef.x,
              y: ef.y,
              vx: Math.cos(angle) * speed,
              vy: Math.sin(angle) * speed,
              color: ef.color,
              alpha: 1.0,
              radius: 2 + Math.random() * 1.8,
            });
          }
        }

        this.updateHUD(msg.matchWinner);
        break;
      }

      case 'notification': {
        this.showToast(msg.text, msg.level);
        break;
      }
    }
  }

  private focusCameraOnSelf(): void {
    for (const b of this.buildings.values()) {
      if (b.ownerId === this.selfId) {
        this.camX = b.x;
        this.camY = b.y;
        this.camZoom = 0.85;
        return;
      }
    }
  }

  // ==========================================
  // LOBBY UI & MULTI-ROOM BROWSER
  // ==========================================
  private initLobbyUI(): void {
    const nameInput = document.getElementById('playerNameInput') as HTMLInputElement;
    const savedName = localStorage.getItem('vexfront_name');
    nameInput.value = savedName || `Commander-${Math.floor(100 + Math.random() * 899)}`;

    const colorGrid = document.getElementById('colorPickerGrid')!;
    FACTION_COLORS.forEach((col, idx) => {
      const swatch = document.createElement('div');
      swatch.className = 'color-swatch' + (idx === 0 ? ' selected' : '');
      swatch.style.backgroundColor = col;
      swatch.addEventListener('click', () => {
        this.selectedColor = col;
        colorGrid.querySelectorAll('.color-swatch').forEach((el) => el.classList.remove('selected'));
        swatch.classList.add('selected');
      });
      colorGrid.appendChild(swatch);
    });

    // Quick Play Button
    document.getElementById('quickPlayBtn')?.addEventListener('click', () => {
      const playerName = this.getAndSavePlayerName();
      this.send({
        type: 'join_lobby',
        playerName,
        playerColor: this.selectedColor,
      });
    });

    // Join by Code Button
    document.getElementById('joinByCodeBtn')?.addEventListener('click', () => {
      const codeInput = document.getElementById('joinCodeInput') as HTMLInputElement;
      const code = codeInput.value.trim();
      if (!code) return;
      const playerName = this.getAndSavePlayerName();
      this.send({
        type: 'join_lobby',
        lobbyCode: code,
        playerName,
        playerColor: this.selectedColor,
      });
    });

    // Refresh Lobby List Button
    document.getElementById('refreshLobbiesBtn')?.addEventListener('click', () => {
      this.send({ type: 'list_lobbies' });
    });

    // Create Custom Lobby Button
    document.getElementById('createLobbyBtn')?.addEventListener('click', () => {
      const playerName = this.getAndSavePlayerName();
      const lobbyName = (document.getElementById('customLobbyName') as HTMLInputElement).value;
      const mapTemplate = (document.getElementById('customMapTemplate') as HTMLSelectElement)
        .value as MapTemplate;
      const isPublic = (document.getElementById('customLobbyPublic') as HTMLInputElement).checked;
      const fillWithBots = (document.getElementById('customLobbyBots') as HTMLInputElement).checked;

      this.send({
        type: 'create_lobby',
        lobbyName,
        mapTemplate,
        isPublic,
        fillWithBots,
        playerName,
        playerColor: this.selectedColor,
      });
    });
  }

  private getAndSavePlayerName(): string {
    const nameInput = document.getElementById('playerNameInput') as HTMLInputElement;
    const val = nameInput.value.trim() || 'Commander';
    localStorage.setItem('vexfront_name', val);
    return val;
  }

  private renderLobbyList(lobbies: LobbySummary[]): void {
    const container = document.getElementById('lobbyListContainer');
    if (!container) return;
    container.innerHTML = '';

    if (lobbies.length === 0) {
      container.innerHTML = `<div class="lobby-item"><span>Keine öffentlichen Lobbys gefunden. Erstelle eine neue!</span></div>`;
      return;
    }

    const templateNames: Record<MapTemplate, string> = {
      archipelago: 'Archipel',
      continents: 'Kontinente',
      pangaea: 'Pangäa',
    };

    for (const lob of lobbies) {
      const row = document.createElement('div');
      row.className = 'lobby-item';
      row.innerHTML = `
        <div class="lobby-item-info">
          <div class="lobby-item-title">
            <span>${this.escapeHtml(lob.name)}</span>
            <span class="badge-pill">${templateNames[lob.mapTemplate] || lob.mapTemplate}</span>
            <span class="code-pill">${this.escapeHtml(lob.code)}</span>
          </div>
          <div class="lobby-item-meta">
            <span>👤 ${lob.humanPlayers} Spieler + 🤖 ${lob.botPlayers} Bots (Max ${lob.maxPlayers})</span>
            <span>Status: ${lob.status === 'waiting' ? `Start in ${lob.countdownSec}s` : 'Laufendes Gefecht'}</span>
          </div>
        </div>
        <button class="btn-secondary">Beitreten →</button>
      `;

      row.querySelector('button')?.addEventListener('click', () => {
        const playerName = this.getAndSavePlayerName();
        this.send({
          type: 'join_lobby',
          lobbyId: lob.id,
          playerName,
          playerColor: this.selectedColor,
        });
      });

      container.appendChild(row);
    }
  }

  // ==========================================
  // HUD & TACTICAL CONTROLS
  // ==========================================
  private initHUDControls(): void {
    // Worker vs Troop allocation slider
    const slider = document.getElementById('workerRatioSlider') as HTMLInputElement;
    const workerLabel = document.getElementById('workerPctLabel')!;
    const troopLabel = document.getElementById('troopPctLabel')!;

    slider.addEventListener('input', () => {
      const val = Number(slider.value);
      workerLabel.textContent = `${val}%`;
      troopLabel.textContent = `${100 - val}%`;
      this.send({ type: 'set_slider', workerRatio: val / 100 });
    });

    // Dispatch percentage buttons (25%, 50%, 100%)
    const pctButtons = document.querySelectorAll('.pct-btn');
    pctButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        pctButtons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.dispatchPercentage = Number((btn as HTMLElement).dataset.pct || 0.5);
      });
    });

    // Building mode buttons
    const buildButtons = document.querySelectorAll('.build-btn[data-build]');
    const cancelBtn = document.getElementById('cancelBuildBtn')!;

    buildButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const bType = (btn as HTMLElement).dataset.build as BuildingType;
        if (this.activeBuildMode === bType) {
          this.setBuildMode(null);
        } else {
          this.setBuildMode(bType);
        }
      });
    });

    cancelBtn.addEventListener('click', () => this.setBuildMode(null));

    // Leave Lobby / Switch Lobby button
    document.getElementById('hudLeaveLobbyBtn')?.addEventListener('click', () => {
      this.inGame = false;
      this.send({ type: 'leave_lobby' });
      document.getElementById('hudContainer')?.classList.add('hud-hidden');
      document.getElementById('lobbyOverlay')?.classList.remove('hidden');
    });

    // Force-start waiting custom lobby button
    document.getElementById('hudStartNowBtn')?.addEventListener('click', () => {
      this.send({ type: 'start_lobby_now' });
    });

    // Keyboard shortcuts (1-4 for buildings, ESC to cancel/deselect, WASD for camera)
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.keysPressed.add(e.key.toLowerCase());

      if (e.key === '1') this.setBuildMode('city');
      else if (e.key === '2') this.setBuildMode('port');
      else if (e.key === '3') this.setBuildMode('defense');
      else if (e.key === '4') this.setBuildMode('rally');
      else if (e.key === 'Escape') {
        this.setBuildMode(null);
        this.selectedDotIds.clear();
        this.selectedBuildingIds.clear();
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keysPressed.delete(e.key.toLowerCase());
    });
  }

  private setBuildMode(mode: BuildingType | null): void {
    this.activeBuildMode = mode;
    const buildButtons = document.querySelectorAll('.build-btn[data-build]');
    buildButtons.forEach((btn) => {
      const bType = (btn as HTMLElement).dataset.build as BuildingType;
      btn.classList.toggle('active', bType === mode);
    });
    document.getElementById('cancelBuildBtn')?.classList.toggle('hidden', mode === null);
  }

  private updateHUD(
    matchWinner: {
      name: string;
      color: string;
      territoryPct: number;
      countdownSec: number;
    } | null
  ): void {
    const me = this.players.get(this.selfId);
    if (me) {
      document.getElementById('hudGold')!.textContent = me.gold.toLocaleString('de-DE');
      document.getElementById('hudGoldRate')!.textContent = `+${me.goldPerSec.toFixed(1)}/s`;
      document.getElementById('hudPop')!.textContent = `${me.population} / ${me.popCap}`;
      const popPct = Math.min(100, Math.round((me.population / Math.max(1, me.popCap)) * 100));
      (document.getElementById('hudPopBar') as HTMLElement).style.width = `${popPct}%`;

      document.getElementById('hudWorkforce')!.textContent = `${me.workers} 🛠 | ${me.troopReserve} ⚔`;
      document.getElementById('hudActiveDots')!.textContent = `Aktive Truppen: ${me.activeDots}`;
      document.getElementById('hudTerritory')!.textContent = `${me.territoryPct.toFixed(1)}%`;

      const traitorBadge = document.getElementById('hudTraitorBadge')!;
      if (me.traitorTicksLeft > 0) {
        traitorBadge.classList.remove('hidden');
        document.getElementById('hudTraitorTimer')!.textContent = String(
          Math.ceil(me.traitorTicksLeft / 20)
        );
      } else {
        traitorBadge.classList.add('hidden');
      }
    }

    if (this.currentLobby) {
      document.getElementById('hudLobbyName')!.textContent = this.currentLobby.name;
      document.getElementById('hudLobbyCode')!.textContent = `CODE: ${this.currentLobby.code}`;
      const startNowBtn = document.getElementById('hudStartNowBtn')!;
      startNowBtn.classList.toggle('hidden', this.currentLobby.status !== 'waiting');
    }

    const selCount = this.selectedDotIds.size + this.selectedBuildingIds.size;
    document.getElementById('selectionCounter')!.textContent = `${selCount} ausgewählt`;

    // Center Banner for Waiting Lobby or Match Winner
    const banner = document.getElementById('centerBanner')!;
    const bannerTitle = document.getElementById('centerBannerTitle')!;
    const bannerSub = document.getElementById('centerBannerSub')!;

    if (matchWinner) {
      banner.classList.remove('hidden');
      bannerTitle.textContent = `🏆 ${matchWinner.name} GEWINNT! (${matchWinner.territoryPct}%)`;
      bannerSub.textContent = `Neue Karte wird in ${matchWinner.countdownSec}s generiert...`;
    } else if (this.currentLobby && this.currentLobby.status === 'waiting') {
      banner.classList.remove('hidden');
      bannerTitle.textContent = `⏳ LOBBY STARTET IN ${this.currentLobby.countdownSec}s`;
      bannerSub.textContent = `Teile den Code [${this.currentLobby.code}] mit Freunden oder klicke oben auf "Jetzt starten"`;
    } else {
      banner.classList.add('hidden');
    }

    // Update Alliance Requests & Leaderboard
    this.renderLeaderboardAndDiplomacy(me);
  }

  private renderLeaderboardAndDiplomacy(me: PlayerNetState | undefined): void {
    const reqContainer = document.getElementById('hudAllianceRequests')!;
    reqContainer.innerHTML = '';

    if (me && me.pendingAlliancesFrom.length > 0) {
      for (const senderId of me.pendingAlliancesFrom) {
        const sender = this.players.get(senderId);
        if (!sender) continue;
        const card = document.createElement('div');
        card.className = 'alliance-req-card';
        card.innerHTML = `
          <span>🤝 <strong>${this.escapeHtml(sender.name)}</strong> bietet Allianz</span>
          <button class="btn-small btn-accent">Annehmen</button>
        `;
        card.querySelector('button')?.addEventListener('click', () => {
          this.send({
            type: 'diplomacy',
            action: 'accept_ally',
            targetPlayerId: sender.id,
          });
        });
        reqContainer.appendChild(card);
      }
    }

    const sortedPlayers = Array.from(this.players.values())
      .filter((p) => p.alive)
      .sort((a, b) => b.territoryCells - a.territoryCells);

    document.getElementById('hudPlayerCount')!.textContent = `${sortedPlayers.length}/15`;

    const lbContainer = document.getElementById('hudLeaderboardList')!;
    lbContainer.innerHTML = '';

    for (const p of sortedPlayers) {
      const isSelf = p.id === this.selfId;
      const isAllied = me ? me.allies.includes(p.id) : false;

      const row = document.createElement('div');
      row.className = 'lb-row' + (isSelf ? ' is-self' : '');

      const traitorIcon = p.traitorTicksLeft > 0 ? ' ⚠' : '';
      const botTag = p.isBot ? ' [KI]' : '';

      row.innerHTML = `
        <div class="lb-player">
          <span class="color-dot" style="background:${p.color}"></span>
          <span>${this.escapeHtml(p.name)}${botTag}${traitorIcon}</span>
        </div>
        <div class="lb-meta">
          <span class="lb-pct">${p.territoryPct.toFixed(1)}%</span>
          ${
            !isSelf
              ? `<button class="ally-btn ${isAllied ? 'allied' : ''}">${
                  isAllied ? '⚔ Verrat' : '🤝 Ally'
                }</button>`
              : ''
          }
        </div>
      `;

      if (!isSelf) {
        row.querySelector('.ally-btn')?.addEventListener('click', () => {
          this.send({
            type: 'diplomacy',
            action: isAllied ? 'break_ally' : 'request_ally',
            targetPlayerId: p.id,
          });
        });
      }

      lbContainer.appendChild(row);
    }
  }

  // ==========================================
  // CANVAS RTS INPUTS (BOX-SELECT, WAYPOINTS, ZOOM/PAN)
  // ==========================================
  private initCanvasInputs(): void {
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.inGame) return;
      const world = this.screenToWorld(e.clientX, e.clientY);

      // Middle click or Space+LeftClick -> Pan camera
      if (e.button === 1 || (e.button === 0 && this.keysPressed.has(' '))) {
        this.isPanning = true;
        this.panLastScreen = { x: e.clientX, y: e.clientY };
        return;
      }

      // Left click -> Build placement OR Box-Select / Unit & Building Selection
      if (e.button === 0) {
        if (this.activeBuildMode) {
          this.send({
            type: 'build',
            buildingType: this.activeBuildMode,
            x: world.x,
            y: world.y,
          });
          if (!e.shiftKey) {
            this.setBuildMode(null);
          }
          return;
        }

        this.isBoxSelecting = true;
        this.boxStartScreen = { x: e.clientX, y: e.clientY };
        this.boxCurrentScreen = { x: e.clientX, y: e.clientY };
        return;
      }

      // Right click -> Tactical RTS Order (Move / Attack / Spawn Swarm / Shift+RightClick Waypoints)
      if (e.button === 2) {
        if (this.activeBuildMode) {
          this.setBuildMode(null);
          return;
        }
        this.issueTacticalRightClickOrder(world.x, world.y, e.shiftKey);
      }
    });

    window.addEventListener('mousemove', (e) => {
      this.mouseWorld = this.screenToWorld(e.clientX, e.clientY);

      if (this.isPanning) {
        const dx = e.clientX - this.panLastScreen.x;
        const dy = e.clientY - this.panLastScreen.y;
        this.camX -= dx / this.camZoom;
        this.camY -= dy / this.camZoom;
        this.clampCamera();
        this.panLastScreen = { x: e.clientX, y: e.clientY };
      }

      if (this.isBoxSelecting) {
        this.boxCurrentScreen = { x: e.clientX, y: e.clientY };
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button === 1) {
        this.isPanning = false;
      }
      if (e.button === 0) {
        this.isPanning = false;
        if (this.isBoxSelecting) {
          this.finishSelection(e.shiftKey);
          this.isBoxSelecting = false;
        }
      }
    });

    // Smooth Zoom around mouse cursor
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.inGame) return;
        e.preventDefault();
        const before = this.screenToWorld(e.clientX, e.clientY);
        const factor = e.deltaY < 0 ? 1.14 : 0.88;
        this.camZoom = Math.max(0.24, Math.min(2.4, this.camZoom * factor));
        const after = this.screenToWorld(e.clientX, e.clientY);
        this.camX += before.x - after.x;
        this.camY += before.y - after.y;
        this.clampCamera();
      },
      { passive: false }
    );

    // Minimap Click Navigation
    this.minimapCanvas.addEventListener('mousedown', (e) => {
      const rect = this.minimapCanvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / rect.width;
      const my = (e.clientY - rect.top) / rect.height;
      this.camX = mx * WORLD_WIDTH;
      this.camY = my * WORLD_HEIGHT;
      this.clampCamera();
    });
  }

  private finishSelection(additive: boolean): void {
    const dx = Math.abs(this.boxCurrentScreen.x - this.boxStartScreen.x);
    const dy = Math.abs(this.boxCurrentScreen.y - this.boxStartScreen.y);

    if (!additive) {
      this.selectedDotIds.clear();
      this.selectedBuildingIds.clear();
    }

    if (dx < 8 && dy < 8) {
      // Single click selection: Check own Cities / Rally Nodes first, then nearby own Dot swarm
      const clickWorld = this.screenToWorld(this.boxStartScreen.x, this.boxStartScreen.y);

      for (const b of this.buildings.values()) {
        if (b.ownerId === this.selfId && (b.type === 'city' || b.type === 'rally')) {
          if (Math.hypot(b.x - clickWorld.x, b.y - clickWorld.y) <= 26) {
            this.selectedBuildingIds.add(b.id);
            return;
          }
        }
      }

      // Otherwise select friendly dots within a local platoon radius
      for (const d of this.dots.values()) {
        if (d.ownerId === this.selfId) {
          if (Math.hypot(d.renderX - clickWorld.x, d.renderY - clickWorld.y) <= 42) {
            this.selectedDotIds.add(d.id);
          }
        }
      }
    } else {
      // Box-Select over own physical Dot Swarms and Spawn Buildings
      const p1 = this.screenToWorld(
        Math.min(this.boxStartScreen.x, this.boxCurrentScreen.x),
        Math.min(this.boxStartScreen.y, this.boxCurrentScreen.y)
      );
      const p2 = this.screenToWorld(
        Math.max(this.boxStartScreen.x, this.boxCurrentScreen.x),
        Math.max(this.boxStartScreen.y, this.boxCurrentScreen.y)
      );

      for (const d of this.dots.values()) {
        if (
          d.ownerId === this.selfId &&
          d.renderX >= p1.x &&
          d.renderX <= p2.x &&
          d.renderY >= p1.y &&
          d.renderY <= p2.y
        ) {
          this.selectedDotIds.add(d.id);
        }
      }

      if (this.selectedDotIds.size === 0) {
        for (const b of this.buildings.values()) {
          if (
            b.ownerId === this.selfId &&
            (b.type === 'city' || b.type === 'rally') &&
            b.x >= p1.x &&
            b.x <= p2.x &&
            b.y >= p1.y &&
            b.y <= p2.y
          ) {
            this.selectedBuildingIds.add(b.id);
          }
        }
      }
    }
  }

  private issueTacticalRightClickOrder(targetX: number, targetY: number, queue: boolean): void {
    let orderSent = false;

    // 1. If physical dots are selected, send movement/intercept command
    if (this.selectedDotIds.size > 0) {
      this.send({
        type: 'command_dots',
        dotIds: Array.from(this.selectedDotIds),
        targetX,
        targetY,
        percentage: this.dispatchPercentage,
        queue,
      });
      orderSent = true;
    }

    // 2. If cities/rally nodes are selected (or nothing is selected), spawn new dot swarm from reserve
    if (this.selectedBuildingIds.size > 0 || !orderSent) {
      this.send({
        type: 'spawn_command',
        sourceBuildingIds: Array.from(this.selectedBuildingIds),
        targetX,
        targetY,
        percentage: this.dispatchPercentage,
        queue,
      });
    }

    // Visual command pulse marker
    const me = this.players.get(this.selfId);
    this.commandMarkers.push({
      x: targetX,
      y: targetY,
      color: me ? me.color : '#38bdf8',
      radius: 6,
      alpha: 1.0,
    });
  }

  // ==========================================
  // 60 FPS RENDERING ENGINE
  // ==========================================
  private updateOffscreenMap(): void {
    if (!this.mapDirty) return;
    this.mapDirty = false;

    const data = this.mapImageData.data;
    for (let i = 0; i < this.terrain.length; i++) {
      const t = this.terrain[i];
      const ownerNum = this.territory[i];
      const inSupply = this.supplyGrid[i] === 1;
      const pIdx = i * 4;

      if (t === TerrainType.WATER) {
        data[pIdx] = 11;
        data[pIdx + 1] = 22;
        data[pIdx + 2] = 39;
        data[pIdx + 3] = 255;
        continue;
      }

      let baseR = t === TerrainType.MOUNTAIN ? 78 : 34;
      let baseG = t === TerrainType.MOUNTAIN ? 86 : 49;
      let baseB = t === TerrainType.MOUNTAIN ? 102 : 66;

      if (ownerNum !== 0) {
        const owner = this.numIdToPlayer.get(ownerNum);
        if (owner) {
          const rgb = hexToRgb(owner.color);
          const blend = inSupply ? 0.66 : 0.35; // Encircled territory appears darkened / desaturated
          baseR = Math.round(baseR * (1 - blend) + rgb.r * blend);
          baseG = Math.round(baseG * (1 - blend) + rgb.g * blend);
          baseB = Math.round(baseB * (1 - blend) + rgb.b * blend);
        }
      }

      data[pIdx] = baseR;
      data[pIdx + 1] = baseG;
      data[pIdx + 2] = baseB;
      data[pIdx + 3] = 255;
    }

    this.mapOffscreenCtx.putImageData(this.mapImageData, 0, 0);
  }

  private renderLoop(): void {
    requestAnimationFrame(() => this.renderLoop());

    this.updateCameraKeyboardPan();
    this.updateOffscreenMap();
    this.dashOffset = (this.dashOffset - 0.55) % 24;

    const ctx = this.ctx;
    ctx.fillStyle = '#070f1d';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.save();
    ctx.translate(this.canvas.width / 2, this.canvas.height / 2);
    ctx.scale(this.camZoom, this.camZoom);
    ctx.translate(-this.camX, -this.camY);

    // 1. Draw Terrain & Faction Territory Grid
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.mapOffscreen, 0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    ctx.imageSmoothingEnabled = true;

    // Subtle tactical grid overlay when zoomed in
    if (this.camZoom > 0.7) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= WORLD_WIDTH; x += CELL_SIZE * 4) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, WORLD_HEIGHT);
      }
      for (let y = 0; y <= WORLD_HEIGHT; y += CELL_SIZE * 4) {
        ctx.moveTo(0, y);
        ctx.lineTo(WORLD_WIDTH, y);
      }
      ctx.stroke();
    }

    // 2. Draw Defense Post Radii
    for (const b of this.buildings.values()) {
      if (b.type === 'defense') {
        const owner = this.players.get(b.ownerId);
        const col = owner ? owner.color : '#94a3b8';
        ctx.save();
        ctx.beginPath();
        ctx.arc(b.x, b.y, DEFENSE_POST_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = `${col}18`;
        ctx.fill();
        ctx.setLineDash([8, 6]);
        ctx.strokeStyle = `${col}88`;
        ctx.lineWidth = 1.8;
        ctx.stroke();
        ctx.restore();
      }
    }

    // 3. Draw Animated Dashed Sea Trade & Naval Transport Routes + Ships
    this.renderShipsAndRoutes(ctx);

    // 4. Draw Buildings (Cities, Ports, Defense Posts, Rally Nodes)
    this.renderBuildings(ctx);

    // 5. Draw Selected Unit Waypoint Paths
    this.renderWaypointLines(ctx);

    // 6. Draw Interpolated Physical Dot Swarms
    this.renderDots(ctx);

    // 7. Draw Combat Sparks & Command Markers
    this.renderEffects(ctx);

    // 8. Draw Active Build Placement Ghost
    if (this.activeBuildMode && this.inGame) {
      this.renderBuildPreview(ctx);
    }

    ctx.restore();

    // 9. Draw Screen-Space RTS Box-Select Rectangle
    if (this.isBoxSelecting) {
      const x = Math.min(this.boxStartScreen.x, this.boxCurrentScreen.x);
      const y = Math.min(this.boxStartScreen.y, this.boxCurrentScreen.y);
      const w = Math.abs(this.boxCurrentScreen.x - this.boxStartScreen.x);
      const h = Math.abs(this.boxCurrentScreen.y - this.boxStartScreen.y);

      ctx.save();
      ctx.fillStyle = 'rgba(56, 189, 248, 0.15)';
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.5;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }

    // 10. Render Minimap
    if (this.inGame) {
      this.renderMinimap();
    }
  }

  private renderShipsAndRoutes(ctx: CanvasRenderingContext2D): void {
    for (const s of this.ships.values()) {
      s.renderX += (s.x - s.renderX) * 0.25;
      s.renderY += (s.y - s.renderY) * 0.25;

      // Dashed route line
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(s.fromX, s.fromY);
      ctx.lineTo(s.toX, s.toY);
      ctx.setLineDash([10, 8]);
      ctx.lineDashOffset = this.dashOffset;
      ctx.strokeStyle =
        s.kind === 'trade' ? 'rgba(250, 204, 21, 0.45)' : 'rgba(56, 189, 248, 0.55)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();

      // Ship hull vector
      const angle = Math.atan2(s.toY - s.fromY, s.toX - s.fromX);
      ctx.save();
      ctx.translate(s.renderX, s.renderY);
      ctx.rotate(angle);

      ctx.beginPath();
      ctx.moveTo(11, 0);
      ctx.lineTo(-8, 6);
      ctx.lineTo(-5, 0);
      ctx.lineTo(-8, -6);
      ctx.closePath();

      ctx.fillStyle = s.kind === 'trade' ? '#facc15' : s.color;
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();

      // Label above ship
      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 10px Inter, sans-serif';
      ctx.textAlign = 'center';
      const label = s.kind === 'trade' ? `+${s.goldValue}g` : `${s.troops}⚔`;
      ctx.fillText(label, s.renderX, s.renderY - 12);
    }
  }

  private renderBuildings(ctx: CanvasRenderingContext2D): void {
    for (const b of this.buildings.values()) {
      const owner = this.players.get(b.ownerId);
      const col = owner ? owner.color : '#94a3b8';
      const isSelected = this.selectedBuildingIds.has(b.id);

      ctx.save();
      ctx.translate(b.x, b.y);

      if (isSelected) {
        ctx.beginPath();
        ctx.arc(0, 0, 24, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }

      ctx.fillStyle = col;
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 2.2;

      if (b.type === 'city') {
        // Hexagon City Vector
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          const rx = Math.cos(a) * 15;
          const ry = Math.sin(a) * 15;
          if (i === 0) ctx.moveTo(rx, ry);
          else ctx.lineTo(rx, ry);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(0, 0, 4.5, 0, Math.PI * 2);
        ctx.fill();
      } else if (b.type === 'port') {
        // Diamond Port / Anchor Node
        ctx.beginPath();
        ctx.moveTo(0, -15);
        ctx.lineTo(15, 0);
        ctx.lineTo(0, 15);
        ctx.lineTo(-15, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('⚓', 0, 1);
      } else if (b.type === 'defense') {
        // Octagon Turret Bastion
        ctx.beginPath();
        ctx.rect(-12, -12, 24, 24);
        ctx.fill();
        ctx.stroke();

        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.strokeRect(-6, -6, 12, 12);
      } else if (b.type === 'rally') {
        // Tactical Rally Beacon Triangle
        ctx.beginPath();
        ctx.moveTo(0, -14);
        ctx.lineTo(13, 10);
        ctx.lineTo(-13, 10);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }

      // Health bar if damaged
      if (b.hp < b.maxHp) {
        const pct = Math.max(0, b.hp / b.maxHp);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(-16, -23, 32, 4);
        ctx.fillStyle = pct > 0.4 ? '#22c55e' : '#ef4444';
        ctx.fillRect(-16, -23, 32 * pct, 4);
      }

      ctx.restore();
    }
  }

  private renderWaypointLines(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.lineWidth = 1.4;
    ctx.setLineDash([5, 5]);

    for (const dotId of this.selectedDotIds) {
      const dot = this.dots.get(dotId);
      if (!dot || dot.waypoints.length === 0) continue;

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.beginPath();
      ctx.moveTo(dot.renderX, dot.renderY);
      for (const wp of dot.waypoints) {
        ctx.lineTo(wp.x, wp.y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  private renderDots(ctx: CanvasRenderingContext2D): void {
    for (const d of this.dots.values()) {
      // Smooth 60 FPS position interpolation toward authoritative 20 TPS state
      d.renderX += (d.x - d.renderX) * 0.28;
      d.renderY += (d.y - d.renderY) * 0.28;

      const owner = this.players.get(d.ownerId);
      const col = owner ? owner.color : '#ffffff';
      const isSelected = this.selectedDotIds.has(d.id);
      const radius = Math.min(10, 4.5 + Math.sqrt(d.troops) * 1.1);

      ctx.save();
      ctx.translate(d.renderX, d.renderY);

      if (isSelected) {
        ctx.beginPath();
        ctx.arc(0, 0, radius + 3.5, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }

      // Main glowing Dot body
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.shadowColor = col;
      ctx.shadowBlur = d.fighting ? 12 : 6;
      ctx.fill();

      ctx.lineWidth = 1.2;
      ctx.strokeStyle = d.encircled ? '#ef4444' : '#0f172a';
      ctx.stroke();

      // Inner bright core
      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      // Encircled / low morale indicator ring
      if (d.encircled) {
        ctx.fillStyle = '#fca5a5';
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('!', 0, -radius - 3);
      }

      ctx.restore();
    }
  }

  private renderEffects(ctx: CanvasRenderingContext2D): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.alpha -= 0.04;
      if (p.alpha <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    for (let i = this.commandMarkers.length - 1; i >= 0; i--) {
      const m = this.commandMarkers[i];
      m.radius += 1.1;
      m.alpha -= 0.035;
      if (m.alpha <= 0) {
        this.commandMarkers.splice(i, 1);
        continue;
      }
      ctx.save();
      ctx.globalAlpha = m.alpha;
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  private renderBuildPreview(ctx: CanvasRenderingContext2D): void {
    const gx = Math.floor(this.mouseWorld.x / CELL_SIZE);
    const gy = Math.floor(this.mouseWorld.y / CELL_SIZE);
    const snapX = (gx + 0.5) * CELL_SIZE;
    const snapY = (gy + 0.5) * CELL_SIZE;

    const me = this.players.get(this.selfId);
    const idx = gy * GRID_WIDTH + gx;
    const validCell =
      me &&
      gx >= 1 &&
      gx < GRID_WIDTH - 1 &&
      gy >= 1 &&
      gy < GRID_HEIGHT - 1 &&
      this.terrain[idx] !== TerrainType.WATER &&
      this.territory[idx] === me.numId;

    ctx.save();
    ctx.translate(snapX, snapY);
    if (this.activeBuildMode === 'defense') {
      ctx.beginPath();
      ctx.arc(0, 0, DEFENSE_POST_RADIUS, 0, Math.PI * 2);
      ctx.strokeStyle = validCell ? 'rgba(34, 197, 94, 0.55)' : 'rgba(239, 68, 68, 0.55)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(0, 0, 16, 0, Math.PI * 2);
    ctx.fillStyle = validCell ? 'rgba(34, 197, 94, 0.45)' : 'rgba(239, 68, 68, 0.45)';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  private renderMinimap(): void {
    const mCtx = this.minimapCtx;
    const w = this.minimapCanvas.width;
    const h = this.minimapCanvas.height;

    mCtx.clearRect(0, 0, w, h);
    mCtx.imageSmoothingEnabled = false;
    mCtx.drawImage(this.mapOffscreen, 0, 0, w, h);

    // Draw large dot swarms on minimap
    for (const d of this.dots.values()) {
      const owner = this.players.get(d.ownerId);
      if (!owner) continue;
      const mx = (d.renderX / WORLD_WIDTH) * w;
      const my = (d.renderY / WORLD_HEIGHT) * h;
      mCtx.fillStyle = '#ffffff';
      mCtx.fillRect(mx - 1, my - 1, 2.2, 2.2);
    }

    // Draw camera viewport box on minimap
    const topLeft = this.screenToWorld(0, 0);
    const bottomRight = this.screenToWorld(this.canvas.width, this.canvas.height);

    const vx = (topLeft.x / WORLD_WIDTH) * w;
    const vy = (topLeft.y / WORLD_HEIGHT) * h;
    const vw = ((bottomRight.x - topLeft.x) / WORLD_WIDTH) * w;
    const vh = ((bottomRight.y - topLeft.y) / WORLD_HEIGHT) * h;

    mCtx.strokeStyle = '#ffffff';
    mCtx.lineWidth = 1.2;
    mCtx.strokeRect(vx, vy, vw, vh);
  }

  // ==========================================
  // CAMERA & COORDINATE HELPERS
  // ==========================================
  private updateCameraKeyboardPan(): void {
    if (!this.inGame) return;
    const speed = 14 / this.camZoom;
    if (this.keysPressed.has('w') || this.keysPressed.has('arrowup')) this.camY -= speed;
    if (this.keysPressed.has('s') || this.keysPressed.has('arrowdown')) this.camY += speed;
    if (this.keysPressed.has('a') || this.keysPressed.has('arrowleft')) this.camX -= speed;
    if (this.keysPressed.has('d') || this.keysPressed.has('arrowright')) this.camX += speed;
    this.clampCamera();
  }

  private clampCamera(): void {
    this.camX = Math.max(0, Math.min(WORLD_WIDTH, this.camX));
    this.camY = Math.max(0, Math.min(WORLD_HEIGHT, this.camY));
  }

  private screenToWorld(sx: number, sy: number): Waypoint {
    return {
      x: (sx - this.canvas.width / 2) / this.camZoom + this.camX,
      y: (sy - this.canvas.height / 2) / this.camZoom + this.camY,
    };
  }

  private showToast(
    text: string,
    level: 'info' | 'warning' | 'danger' | 'success'
  ): void {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const el = document.createElement('div');
    el.className = `toast-msg ${level}`;
    el.textContent = text;
    container.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 3800);
  }

  private escapeHtml(str: string): string {
    return str.replace(/[&<>"']/g, (c) => {
      switch (c) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        default:
          return '&#39;';
      }
    });
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new VexFrontClient();
});
