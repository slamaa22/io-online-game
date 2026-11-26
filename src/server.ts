import http from 'http';
import path from 'path';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import {
  GAME_TITLE,
  GRID_WIDTH,
  GRID_HEIGHT,
  CELL_SIZE,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  TICK_RATE,
  MAX_TOTAL_PLAYERS,
  WIN_TERRITORY_RATIO,
  TerrainType,
  MapTemplate,
  BuildingType,
  BUILDING_COSTS,
  DEFENSE_POST_RADIUS,
  TRAITOR_DURATION_TICKS,
  Waypoint,
  LobbySummary,
  PlayerNetState,
  BuildingNetState,
  DotNetState,
  ShipNetState,
  CombatEffectNet,
  TerritoryDelta,
  ClientMessage,
  ServerMessage,
  encodeRLE,
} from './shared/types';

// ==========================================
// SEEDED PRNG & VALUE NOISE FOR MAPS
// ==========================================
class SeededRNG {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 123456789;
  }
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }
}

function hash2D(ix: number, iy: number, seed: number): number {
  let n = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041);
  n = (n ^ (n >>> 13)) >>> 0;
  n = Math.imul(n, 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function valueNoise2D(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);

  const a = hash2D(ix, iy, seed);
  const b = hash2D(ix + 1, iy, seed);
  const c = hash2D(ix, iy + 1, seed);
  const d = hash2D(ix + 1, iy + 1, seed);

  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm2D(x: number, y: number, seed: number, octaves = 4): number {
  let value = 0;
  let amp = 0.5;
  let freq = 1;
  let maxAmp = 0;
  for (let i = 0; i < octaves; i++) {
    value += valueNoise2D(x * freq, y * freq, seed + i * 101) * amp;
    maxAmp += amp;
    amp *= 0.5;
    freq *= 2.05;
  }
  return value / maxAmp;
}

// ==========================================
// SPATIAL HASH GRID FOR FAST DOT QUERIES
// ==========================================
class SpatialHashGrid<T extends { x: number; y: number }> {
  private cellSize: number;
  private buckets: Map<number, T[]> = new Map();

  constructor(cellSize: number) {
    this.cellSize = cellSize;
  }

  clear(): void {
    this.buckets.clear();
  }

  private getKey(cx: number, cy: number): number {
    return ((cx & 0xffff) << 16) | (cy & 0xffff);
  }

  insert(item: T): void {
    const cx = Math.floor(item.x / this.cellSize);
    const cy = Math.floor(item.y / this.cellSize);
    const key = this.getKey(cx, cy);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = [];
      this.buckets.set(key, bucket);
    }
    bucket.push(item);
  }

  queryRadius(x: number, y: number, radius: number): T[] {
    const results: T[] = [];
    const rSq = radius * radius;
    const minCx = Math.floor((x - radius) / this.cellSize);
    const maxCx = Math.floor((x + radius) / this.cellSize);
    const minCy = Math.floor((y - radius) / this.cellSize);
    const maxCy = Math.floor((y + radius) / this.cellSize);

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const bucket = this.buckets.get(this.getKey(cx, cy));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const item = bucket[i];
          const dx = item.x - x;
          const dy = item.y - y;
          if (dx * dx + dy * dy <= rSq) {
            results.push(item);
          }
        }
      }
    }
    return results;
  }
}

// ==========================================
// INTERNAL SERVER ENTITIES
// ==========================================
interface ServerPlayer {
  id: string;
  numId: number;
  name: string;
  color: string;
  isBot: boolean;
  ws: WebSocket | null;
  alive: boolean;
  gold: number;
  goldPerSec: number;
  population: number;
  popCap: number;
  workerRatio: number;
  workers: number;
  troopReserve: number;
  activeDots: number;
  territoryCells: number;
  territoryPct: number;
  allies: Set<string>;
  pendingAlliancesFrom: Set<string>;
  traitorTicksLeft: number;
  aiCooldown: number;
}

interface ServerBuilding {
  id: string;
  ownerId: string;
  type: BuildingType;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  tradeCooldown: number;
}

interface ServerDot {
  id: number;
  ownerId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  maxHp: number;
  troops: number;
  encircled: boolean;
  fighting: boolean;
  waypoints: Waypoint[];
  boardingPortId: string | null;
  amphibiousTarget: Waypoint | null;
}

interface ServerShip {
  id: string;
  kind: 'trade' | 'transport';
  ownerId: string;
  targetOwnerId: string;
  color: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  x: number;
  y: number;
  speed: number;
  troops: number;
  goldValue: number;
  postLandingWaypoints: Waypoint[];
}

const BOT_NAMES = [
  'Aegis Prime',
  'Valkyrie AI',
  'Korsar Nord',
  'Nova Imperium',
  'Helios Synthetics',
  'Iron Archipelago',
  'Zephyr Syndicate',
  'Atlas Collective',
  'Kraken Armada',
  'Hyperion Bot',
  'Cobalt Vanguard',
  'Orion Directive',
  'Borealis Core',
  'Spartan Protocol',
  'Titan Sovereign',
];

const FACTION_COLORS = [
  '#3b82f6', // Blue
  '#ef4444', // Red
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#8b5cf6', // Violet
  '#ec4899', // Pink
  '#06b6d4', // Cyan
  '#84cc16', // Lime
  '#f97316', // Orange
  '#14b8a6', // Teal
  '#e11d48', // Rose
  '#6366f1', // Indigo
  '#a855f7', // Purple
  '#22c55e', // Green
  '#eab308', // Yellow
];

// ==========================================
// GAME ROOM / LOBBY INSTANCE
// ==========================================
class GameRoom {
  public id: string;
  public code: string;
  public name: string;
  public mapTemplate: MapTemplate;
  public isPublic: boolean;
  public fillWithBots: boolean;
  public status: 'waiting' | 'active' | 'finished' = 'active';
  public createdAt: number = Date.now();
  public tickCount = 0;

  public terrain: Uint8Array = new Uint8Array(GRID_WIDTH * GRID_HEIGHT);
  public territory: Uint8Array = new Uint8Array(GRID_WIDTH * GRID_HEIGHT);
  public supplyGrid: Uint8Array = new Uint8Array(GRID_WIDTH * GRID_HEIGHT);
  public totalLandCells = 1;

  public players: Map<string, ServerPlayer> = new Map();
  public numIdToPlayerId: Map<number, string> = new Map();
  public buildings: Map<string, ServerBuilding> = new Map();
  public dots: Map<number, ServerDot> = new Map();
  public ships: Map<string, ServerShip> = new Map();

  private spatialHash = new SpatialHashGrid<ServerDot>(75);
  private pendingDeltas: Map<number, number> = new Map();
  private combatEffects: CombatEffectNet[] = [];
  private supplyDirty = true;

  private nextDotId = 1;
  private nextEntitySeq = 1;
  private rng: SeededRNG;

  public matchWinner: {
    name: string;
    color: string;
    territoryPct: number;
    countdownTicks: number;
  } | null = null;

  public waitingCountdownTicks = 0;

  constructor(
    id: string,
    code: string,
    name: string,
    mapTemplate: MapTemplate,
    isPublic: boolean,
    fillWithBots: boolean,
    startInWaitingMode = false
  ) {
    this.id = id;
    this.code = code;
    this.name = name;
    this.mapTemplate = mapTemplate;
    this.isPublic = isPublic;
    this.fillWithBots = fillWithBots;
    this.rng = new SeededRNG(Date.now() ^ Math.floor(Math.random() * 0xffffffff));

    if (startInWaitingMode) {
      this.status = 'waiting';
      this.waitingCountdownTicks = 12 * TICK_RATE;
    } else {
      this.status = 'active';
    }

    this.generateMap();
    if (this.fillWithBots) {
      this.syncBotPopulation();
    }
  }

  public getSummary(): LobbySummary {
    let humans = 0;
    let bots = 0;
    for (const p of this.players.values()) {
      if (p.isBot) bots++;
      else humans++;
    }
    return {
      id: this.id,
      code: this.code,
      name: this.name,
      mapTemplate: this.mapTemplate,
      isPublic: this.isPublic,
      status: this.status,
      humanPlayers: humans,
      botPlayers: bots,
      maxPlayers: MAX_TOTAL_PLAYERS,
      countdownSec:
        this.status === 'waiting'
          ? Math.ceil(this.waitingCountdownTicks / TICK_RATE)
          : this.matchWinner
          ? Math.ceil(this.matchWinner.countdownTicks / TICK_RATE)
          : 0,
      uptimeSec: Math.floor((Date.now() - this.createdAt) / 1000),
    };
  }

  public generateMap(): void {
    const seed = this.rng.int(1, 999999);
    this.terrain.fill(TerrainType.WATER);
    this.territory.fill(0);
    this.supplyGrid.fill(1);
    this.totalLandCells = 0;

    // Generate island/continent centers depending on template
    const centers: { x: number; y: number; r: number }[] = [];
    if (this.mapTemplate === 'pangaea') {
      centers.push({ x: GRID_WIDTH * 0.5, y: GRID_HEIGHT * 0.5, r: GRID_WIDTH * 0.42 });
      for (let i = 0; i < 4; i++) {
        const angle = (i / 4) * Math.PI * 2 + this.rng.range(0, 0.7);
        centers.push({
          x: GRID_WIDTH * 0.5 + Math.cos(angle) * GRID_WIDTH * 0.25,
          y: GRID_HEIGHT * 0.5 + Math.sin(angle) * GRID_HEIGHT * 0.25,
          r: GRID_WIDTH * 0.2,
        });
      }
    } else if (this.mapTemplate === 'continents') {
      const angles = [0.4, 2.3, 4.4];
      for (const a of angles) {
        const dist = GRID_WIDTH * 0.26;
        centers.push({
          x: GRID_WIDTH * 0.5 + Math.cos(a) * dist,
          y: GRID_HEIGHT * 0.5 + Math.sin(a) * dist,
          r: GRID_WIDTH * 0.26,
        });
      }
      centers.push({ x: GRID_WIDTH * 0.5, y: GRID_HEIGHT * 0.5, r: GRID_WIDTH * 0.14 });
    } else {
      // Archipelago: ring of larger islands + central islands
      const numIslands = 9;
      for (let i = 0; i < numIslands; i++) {
        const angle = (i / numIslands) * Math.PI * 2 + this.rng.range(-0.2, 0.2);
        const dist = GRID_WIDTH * this.rng.range(0.24, 0.34);
        centers.push({
          x: GRID_WIDTH * 0.5 + Math.cos(angle) * dist,
          y: GRID_HEIGHT * 0.5 + Math.sin(angle) * dist,
          r: GRID_WIDTH * this.rng.range(0.14, 0.19),
        });
      }
      centers.push({ x: GRID_WIDTH * 0.5, y: GRID_HEIGHT * 0.5, r: GRID_WIDTH * 0.16 });
    }

    for (let gy = 0; gy < GRID_HEIGHT; gy++) {
      for (let gx = 0; gx < GRID_WIDTH; gx++) {
        const idx = gy * GRID_WIDTH + gx;
        // Keep border water margin
        if (gx < 4 || gx >= GRID_WIDTH - 4 || gy < 4 || gy >= GRID_HEIGHT - 4) {
          this.terrain[idx] = TerrainType.WATER;
          continue;
        }

        let maxInfluence = 0;
        for (let i = 0; i < centers.length; i++) {
          const c = centers[i];
          const dx = gx - c.x;
          const dy = gy - c.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          const inf = Math.max(0, 1 - d / c.r);
          if (inf > maxInfluence) {
            maxInfluence = inf;
          }
        }

        const n = fbm2D(gx * 0.055, gy * 0.055, seed, 4);
        const heightVal = maxInfluence * 0.65 + n * 0.55;

        if (heightVal < 0.42) {
          this.terrain[idx] = TerrainType.WATER;
        } else if (heightVal > 0.66) {
          this.terrain[idx] = TerrainType.MOUNTAIN;
          this.totalLandCells++;
        } else {
          this.terrain[idx] = TerrainType.PLAINS;
          this.totalLandCells++;
        }
      }
    }
    this.totalLandCells = Math.max(1, this.totalLandCells);
  }

  public resetMatch(): void {
    this.tickCount = 0;
    this.createdAt = Date.now();
    this.status = 'active';
    this.matchWinner = null;
    this.buildings.clear();
    this.dots.clear();
    this.ships.clear();
    this.pendingDeltas.clear();
    this.combatEffects = [];
    this.rng = new SeededRNG(Date.now() ^ Math.floor(Math.random() * 0xffffffff));

    this.generateMap();

    // Respawn all connected human players and bots
    const oldPlayers = Array.from(this.players.values());
    this.players.clear();
    this.numIdToPlayerId.clear();

    for (const p of oldPlayers) {
      if (!p.isBot && p.ws && p.ws.readyState === WebSocket.OPEN) {
        this.spawnPlayer(p.id, p.name, p.color, false, p.ws);
      }
    }

    if (this.fillWithBots) {
      this.syncBotPopulation();
    }

    this.recalculateTerritoryCounts();
    this.recalculateSupplyLines();

    // Send full map sync to all connected clients in this room
    const syncMsg: ServerMessage = {
      type: 'full_map_sync',
      lobby: this.getSummary(),
      terrainRLE: encodeRLE(this.terrain),
      territoryRLE: encodeRLE(this.territory),
      supplyRLE: encodeRLE(this.supplyGrid),
    };
    this.broadcast(syncMsg);
  }

  private allocateNumId(): number {
    for (let id = 1; id <= 250; id++) {
      if (!this.numIdToPlayerId.has(id)) {
        return id;
      }
    }
    return 251;
  }

  private findBestSpawnSpot(): { gx: number; gy: number } {
    let bestGx = Math.floor(GRID_WIDTH / 2);
    let bestGy = Math.floor(GRID_HEIGHT / 2);
    let bestScore = -1e9;

    for (let attempt = 0; attempt < 90; attempt++) {
      const gx = this.rng.int(10, GRID_WIDTH - 11);
      const gy = this.rng.int(10, GRID_HEIGHT - 11);
      const idx = gy * GRID_WIDTH + gx;

      if (this.terrain[idx] !== TerrainType.PLAINS) continue;
      if (this.territory[idx] !== 0) continue;

      // Prefer coastal or near-coastal plains with surrounding land
      let landNeighbors = 0;
      let waterNearby = 0;
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const nx = gx + dx;
          const ny = gy + dy;
          if (nx < 0 || nx >= GRID_WIDTH || ny < 0 || ny >= GRID_HEIGHT) continue;
          const t = this.terrain[ny * GRID_WIDTH + nx];
          if (t !== TerrainType.WATER) landNeighbors++;
          else waterNearby++;
        }
      }

      if (landNeighbors < 25) continue;

      // Distance to nearest existing player city/building
      let minDist = 999999;
      for (const b of this.buildings.values()) {
        const bgx = b.x / CELL_SIZE;
        const bgy = b.y / CELL_SIZE;
        const d = Math.hypot(gx - bgx, gy - bgy);
        if (d < minDist) minDist = d;
      }
      if (this.buildings.size === 0) minDist = 50;

      const coastalBonus = waterNearby > 4 && waterNearby < 45 ? 18 : 0;
      const score = minDist * 3 + landNeighbors * 0.4 + coastalBonus;
      if (score > bestScore) {
        bestScore = score;
        bestGx = gx;
        bestGy = gy;
      }
    }

    return { gx: bestGx, gy: bestGy };
  }

  public spawnPlayer(
    id: string,
    name: string,
    color: string,
    isBot: boolean,
    ws: WebSocket | null
  ): ServerPlayer {
    // If room is full and a human joins, evict a bot first
    if (!isBot && this.players.size >= MAX_TOTAL_PLAYERS) {
      const botToRemove = Array.from(this.players.values()).find((p) => p.isBot);
      if (botToRemove) {
        this.removePlayer(botToRemove.id, true);
      }
    }

    const numId = this.allocateNumId();
    const spot = this.findBestSpawnSpot();

    const player: ServerPlayer = {
      id,
      numId,
      name: name.trim().slice(0, 20) || `Commander ${numId}`,
      color,
      isBot,
      ws,
      alive: true,
      gold: 400,
      goldPerSec: 0,
      population: 120,
      popCap: 350,
      workerRatio: 0.55,
      workers: 66,
      troopReserve: 54,
      activeDots: 0,
      territoryCells: 0,
      territoryPct: 0,
      allies: new Set(),
      pendingAlliancesFrom: new Set(),
      traitorTicksLeft: 0,
      aiCooldown: this.rng.int(15, 45),
    };

    this.players.set(id, player);
    this.numIdToPlayerId.set(numId, id);

    // Claim initial circular territory around spawn spot
    const spawnRadius = 5;
    for (let dy = -spawnRadius; dy <= spawnRadius; dy++) {
      for (let dx = -spawnRadius; dx <= spawnRadius; dx++) {
        if (dx * dx + dy * dy > spawnRadius * spawnRadius + 2) continue;
        const nx = spot.gx + dx;
        const ny = spot.gy + dy;
        if (nx < 0 || nx >= GRID_WIDTH || ny < 0 || ny >= GRID_HEIGHT) continue;
        const idx = ny * GRID_WIDTH + nx;
        if (this.terrain[idx] !== TerrainType.WATER) {
          this.setTerritoryCell(idx, numId);
        }
      }
    }

    // Create Capital City at spawn center
    const cityX = (spot.gx + 0.5) * CELL_SIZE;
    const cityY = (spot.gy + 0.5) * CELL_SIZE;
    const cityId = `bld_${this.nextEntitySeq++}`;
    this.buildings.set(cityId, {
      id: cityId,
      ownerId: id,
      type: 'city',
      x: cityX,
      y: cityY,
      hp: 600,
      maxHp: 600,
      tradeCooldown: 0,
    });

    // Spawn an initial guard swarm of 8 dots around capital
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const dx = cityX + Math.cos(angle) * 28;
      const dy = cityY + Math.sin(angle) * 28;
      this.createDot(id, dx, dy, 3, []);
    }

    this.supplyDirty = true;
    return player;
  }

  public removePlayer(playerId: string, clearTerritory = false): void {
    const player = this.players.get(playerId);
    if (!player) return;

    if (clearTerritory) {
      for (let i = 0; i < this.territory.length; i++) {
        if (this.territory[i] === player.numId) {
          this.setTerritoryCell(i, 0);
        }
      }
      for (const [bid, b] of this.buildings.entries()) {
        if (b.ownerId === playerId) {
          this.buildings.delete(bid);
        }
      }
      for (const [did, d] of this.dots.entries()) {
        if (d.ownerId === playerId) {
          this.dots.delete(did);
        }
      }
    }

    for (const other of this.players.values()) {
      other.allies.delete(playerId);
      other.pendingAlliancesFrom.delete(playerId);
    }

    this.numIdToPlayerId.delete(player.numId);
    this.players.delete(playerId);
    this.supplyDirty = true;
  }

  public syncBotPopulation(): void {
    if (!this.fillWithBots) return;

    let humanCount = 0;
    const bots: ServerPlayer[] = [];
    for (const p of this.players.values()) {
      if (p.isBot) bots.push(p);
      else humanCount++;
    }

    if (humanCount >= MAX_TOTAL_PLAYERS) {
      // Remove all bots if 15 humans are online
      for (const b of bots) {
        this.removePlayer(b.id, true);
      }
      return;
    }

    const desiredTotal = MAX_TOTAL_PLAYERS;
    while (this.players.size < desiredTotal) {
      const botIndex = this.nextEntitySeq++;
      const usedNames = new Set(Array.from(this.players.values()).map((p) => p.name));
      const availableName =
        BOT_NAMES.find((n) => !usedNames.has(n)) || `Bot Squadron #${botIndex % 99}`;
      const usedColors = new Set(Array.from(this.players.values()).map((p) => p.color));
      const availableColor =
        FACTION_COLORS.find((c) => !usedColors.has(c)) ||
        FACTION_COLORS[botIndex % FACTION_COLORS.length];

      this.spawnPlayer(`bot_${botIndex}`, availableName, availableColor, true, null);
    }
  }

  private setTerritoryCell(idx: number, ownerNumId: number): void {
    if (this.territory[idx] === ownerNumId) return;
    this.territory[idx] = ownerNumId;
    this.pendingDeltas.set(idx, ownerNumId);
    this.supplyDirty = true;
  }

  private createDot(
    ownerId: string,
    x: number,
    y: number,
    troops: number,
    waypoints: Waypoint[]
  ): ServerDot {
    const id = this.nextDotId++;
    const clampedX = Math.max(20, Math.min(WORLD_WIDTH - 20, x));
    const clampedY = Math.max(20, Math.min(WORLD_HEIGHT - 20, y));
    const dot: ServerDot = {
      id,
      ownerId,
      x: clampedX,
      y: clampedY,
      vx: 0,
      vy: 0,
      hp: troops * 25,
      maxHp: troops * 25,
      troops,
      encircled: false,
      fighting: false,
      waypoints: waypoints.map((w) => ({ ...w })),
      boardingPortId: null,
      amphibiousTarget: null,
    };
    this.dots.set(id, dot);
    return dot;
  }

  // ==========================================
  // CLIENT MESSAGE HANDLERS
  // ==========================================
  public handlePlayerMessage(playerId: string, msg: ClientMessage): void {
    const player = this.players.get(playerId);
    if (!player) return;

    if (msg.type === 'start_lobby_now') {
      if (this.status === 'waiting') {
        this.status = 'active';
        this.waitingCountdownTicks = 0;
        this.sendNotificationToAll('Gefecht wurde vorzeitig gestartet!', 'info');
      }
      return;
    }

    if (!player.alive) return;

    switch (msg.type) {
      case 'set_slider': {
        player.workerRatio = Math.max(0, Math.min(1, Number(msg.workerRatio) || 0));
        break;
      }

      case 'build': {
        this.handleBuildOrder(player, msg.buildingType, msg.x, msg.y);
        break;
      }

      case 'spawn_command': {
        this.handleSpawnCommand(
          player,
          msg.sourceBuildingIds,
          msg.targetX,
          msg.targetY,
          msg.percentage,
          msg.queue
        );
        break;
      }

      case 'command_dots': {
        this.handleCommandDots(
          player,
          msg.dotIds,
          msg.targetX,
          msg.targetY,
          msg.percentage,
          msg.queue
        );
        break;
      }

      case 'diplomacy': {
        this.handleDiplomacy(player, msg.action, msg.targetPlayerId);
        break;
      }
    }
  }

  private isCoastalCell(gx: number, gy: number): boolean {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = gx + dx;
        const ny = gy + dy;
        if (nx < 0 || nx >= GRID_WIDTH || ny < 0 || ny >= GRID_HEIGHT) continue;
        if (this.terrain[ny * GRID_WIDTH + nx] === TerrainType.WATER) {
          return true;
        }
      }
    }
    return false;
  }

  public handleBuildOrder(
    player: ServerPlayer,
    buildingType: BuildingType,
    worldX: number,
    worldY: number
  ): boolean {
    const cost = BUILDING_COSTS[buildingType];
    if (!cost || player.gold < cost) {
      this.sendNotification(player, `Nicht genug Gold (${cost} benötigt)!`, 'warning');
      return false;
    }

    const gx = Math.floor(worldX / CELL_SIZE);
    const gy = Math.floor(worldY / CELL_SIZE);
    if (gx < 1 || gx >= GRID_WIDTH - 1 || gy < 1 || gy >= GRID_HEIGHT - 1) return false;

    const idx = gy * GRID_WIDTH + gx;
    if (this.terrain[idx] === TerrainType.WATER) {
      this.sendNotification(player, 'Gebäude können nicht im Wasser gebaut werden!', 'warning');
      return false;
    }

    if (this.territory[idx] !== player.numId) {
      this.sendNotification(player, 'Du kannst nur auf eigenem Territorium bauen!', 'warning');
      return false;
    }

    if (buildingType === 'port' && !this.isCoastalCell(gx, gy)) {
      this.sendNotification(player, 'Häfen müssen direkt an einer Küstenlinie liegen!', 'warning');
      return false;
    }

    // Minimum distance between buildings
    for (const b of this.buildings.values()) {
      if (Math.hypot(b.x - worldX, b.y - worldY) < 42) {
        this.sendNotification(player, 'Zu nah an einem bestehenden Gebäude!', 'warning');
        return false;
      }
    }

    player.gold -= cost;
    const maxHp =
      buildingType === 'defense' ? 750 : buildingType === 'city' ? 600 : buildingType === 'port' ? 500 : 350;

    const bldId = `bld_${this.nextEntitySeq++}`;
    this.buildings.set(bldId, {
      id: bldId,
      ownerId: player.id,
      type: buildingType,
      x: (gx + 0.5) * CELL_SIZE,
      y: (gy + 0.5) * CELL_SIZE,
      hp: maxHp,
      maxHp,
      tradeCooldown: this.rng.int(40, 100),
    });

    this.supplyDirty = true;
    return true;
  }

  public handleSpawnCommand(
    player: ServerPlayer,
    sourceBuildingIds: string[],
    targetX: number,
    targetY: number,
    percentage: number,
    queue: boolean
  ): void {
    const clampedX = Math.max(20, Math.min(WORLD_WIDTH - 20, targetX));
    const clampedY = Math.max(20, Math.min(WORLD_HEIGHT - 20, targetY));
    const pct = Math.max(0.1, Math.min(1.0, percentage || 0.5));

    // Find valid spawn buildings owned by player (Cities & Rally Nodes that are in supply)
    let sources: ServerBuilding[] = [];
    for (const bid of sourceBuildingIds) {
      const b = this.buildings.get(bid);
      if (b && b.ownerId === player.id && (b.type === 'city' || b.type === 'rally')) {
        const idx = Math.floor(b.y / CELL_SIZE) * GRID_WIDTH + Math.floor(b.x / CELL_SIZE);
        if (this.supplyGrid[idx] === 1) {
          sources.push(b);
        }
      }
    }

    if (sources.length === 0) {
      // Fallback: all supplied cities and rally nodes of player
      for (const b of this.buildings.values()) {
        if (b.ownerId === player.id && (b.type === 'city' || b.type === 'rally')) {
          const idx = Math.floor(b.y / CELL_SIZE) * GRID_WIDTH + Math.floor(b.x / CELL_SIZE);
          if (this.supplyGrid[idx] === 1) {
            sources.push(b);
          }
        }
      }
    }

    if (sources.length === 0) return;

    const availableReserve = Math.floor(player.troopReserve * pct);
    if (availableReserve < 2) return;

    // Limit active physical dots per player to keep 20 TPS rock solid
    const currentPlayerDots = Array.from(this.dots.values()).filter(
      (d) => d.ownerId === player.id
    ).length;
    const maxNewDots = Math.max(1, Math.min(28, 70 - currentPlayerDots));
    if (maxNewDots <= 0) return;

    const troopsPerDot = Math.max(2, Math.ceil(availableReserve / Math.min(16, maxNewDots)));
    const numDotsToSpawn = Math.min(maxNewDots, Math.floor(availableReserve / troopsPerDot));
    if (numDotsToSpawn <= 0) return;

    let totalTroopsSpent = 0;
    for (let i = 0; i < numDotsToSpawn; i++) {
      const src = sources[i % sources.length];
      const angle = (i / numDotsToSpawn) * Math.PI * 2 + this.rng.range(-0.2, 0.2);
      const radius = 14 + (i % 3) * 7;
      const sx = src.x + Math.cos(angle) * radius;
      const sy = src.y + Math.sin(angle) * radius;

      const dot = this.createDot(player.id, sx, sy, troopsPerDot, []);
      this.assignWaypointToDot(dot, clampedX, clampedY, queue);
      totalTroopsSpent += troopsPerDot;
    }

    player.population = Math.max(15, player.population - totalTroopsSpent);
  }

  public handleCommandDots(
    player: ServerPlayer,
    dotIds: number[],
    targetX: number,
    targetY: number,
    percentage: number,
    queue: boolean
  ): void {
    const clampedX = Math.max(20, Math.min(WORLD_WIDTH - 20, targetX));
    const clampedY = Math.max(20, Math.min(WORLD_HEIGHT - 20, targetY));
    const ownedDots: ServerDot[] = [];
    for (const id of dotIds) {
      const d = this.dots.get(id);
      if (d && d.ownerId === player.id) {
        ownedDots.push(d);
      }
    }
    if (ownedDots.length === 0) return;

    const pct = Math.max(0.1, Math.min(1.0, percentage || 1.0));
    const countToMove = Math.max(1, Math.round(ownedDots.length * pct));

    for (let i = 0; i < countToMove; i++) {
      const dot = ownedDots[i];
      this.assignWaypointToDot(dot, clampedX, clampedY, queue);
    }
  }

  private assignWaypointToDot(
    dot: ServerDot,
    targetX: number,
    targetY: number,
    queue: boolean
  ): void {
    // Check if straight path crosses significant water and player has a port
    const needsNavalTransport = this.pathNeedsNavalTransport(dot.x, dot.y, targetX, targetY);
    if (needsNavalTransport) {
      const nearestPort = this.findNearestFriendlyPort(dot.ownerId, dot.x, dot.y);
      if (nearestPort) {
        dot.boardingPortId = nearestPort.id;
        dot.amphibiousTarget = { x: targetX, y: targetY };
        dot.waypoints = [{ x: nearestPort.x, y: nearestPort.y }];
        return;
      }
    }

    dot.boardingPortId = null;
    dot.amphibiousTarget = null;
    if (queue && dot.waypoints.length < 6) {
      dot.waypoints.push({ x: targetX, y: targetY });
    } else {
      dot.waypoints = [{ x: targetX, y: targetY }];
    }
  }

  private pathNeedsNavalTransport(x1: number, y1: number, x2: number, y2: number): boolean {
    const dist = Math.hypot(x2 - x1, y2 - y1);
    if (dist < CELL_SIZE * 3) return false;
    const samples = Math.min(30, Math.ceil(dist / CELL_SIZE));
    let waterCount = 0;
    for (let i = 1; i <= samples; i++) {
      const t = i / samples;
      const sx = x1 + (x2 - x1) * t;
      const sy = y1 + (y2 - y1) * t;
      const gx = Math.floor(sx / CELL_SIZE);
      const gy = Math.floor(sy / CELL_SIZE);
      if (gx >= 0 && gx < GRID_WIDTH && gy >= 0 && gy < GRID_HEIGHT) {
        if (this.terrain[gy * GRID_WIDTH + gx] === TerrainType.WATER) {
          waterCount++;
        }
      }
    }
    return waterCount >= 2;
  }

  private findNearestFriendlyPort(
    ownerId: string,
    x: number,
    y: number
  ): ServerBuilding | null {
    let best: ServerBuilding | null = null;
    let bestDist = Infinity;
    for (const b of this.buildings.values()) {
      if (b.ownerId === ownerId && b.type === 'port') {
        const d = Math.hypot(b.x - x, b.y - y);
        if (d < bestDist) {
          bestDist = d;
          best = b;
        }
      }
    }
    return best;
  }

  private handleDiplomacy(
    player: ServerPlayer,
    action: 'request_ally' | 'accept_ally' | 'break_ally',
    targetPlayerId: string
  ): void {
    const target = this.players.get(targetPlayerId);
    if (!target || target.id === player.id || !target.alive) return;

    if (action === 'request_ally') {
      if (player.allies.has(target.id)) return;
      if (player.traitorTicksLeft > 0) {
        this.sendNotification(
          player,
          'Als gebrandmarkter Verräter kannst du aktuell keine Allianz anfragen!',
          'danger'
        );
        return;
      }

      // If target already requested us, form alliance immediately
      if (player.pendingAlliancesFrom.has(target.id)) {
        this.formAlliance(player, target);
        return;
      }

      target.pendingAlliancesFrom.add(player.id);
      this.sendNotification(player, `Allianz-Anfrage an ${target.name} gesendet.`, 'info');
      this.sendNotification(
        target,
        `${player.name} bietet dir eine Allianz an!`,
        'info'
      );

      // If target is a bot, evaluate acceptance
      if (target.isBot && player.traitorTicksLeft === 0) {
        if (target.allies.size < 2 && this.rng.next() < 0.72) {
          this.formAlliance(target, player);
        }
      }
    } else if (action === 'accept_ally') {
      if (player.pendingAlliancesFrom.has(target.id)) {
        this.formAlliance(player, target);
      }
    } else if (action === 'break_ally') {
      if (player.allies.has(target.id)) {
        player.allies.delete(target.id);
        target.allies.delete(player.id);
        player.traitorTicksLeft = TRAITOR_DURATION_TICKS;
        this.sendNotificationToAll(
          `VERRAT! ${player.name} hat das Bündnis mit ${target.name} gebrochen! (-35% Gold & Verteidigung für 60s)`,
          'danger'
        );
      }
    }
  }

  private formAlliance(p1: ServerPlayer, p2: ServerPlayer): void {
    p1.pendingAlliancesFrom.delete(p2.id);
    p2.pendingAlliancesFrom.delete(p1.id);
    p1.allies.add(p2.id);
    p2.allies.add(p1.id);
    this.sendNotification(p1, `Allianz mit ${p2.name} geschlossen!`, 'success');
    this.sendNotification(p2, `Allianz mit ${p1.name} geschlossen!`, 'success');
  }

  // ==========================================
  // MAIN 20 TPS SIMULATION TICK
  // ==========================================
  public updateTick(): void {
    this.tickCount++;
    this.combatEffects = [];

    if (this.status === 'waiting') {
      this.waitingCountdownTicks--;
      if (this.waitingCountdownTicks <= 0) {
        this.status = 'active';
        this.sendNotificationToAll('Das Gefecht hat begonnen!', 'success');
      }
      this.broadcastState();
      return;
    }

    if (this.matchWinner) {
      this.matchWinner.countdownTicks--;
      if (this.matchWinner.countdownTicks <= 0) {
        this.resetMatch();
        return;
      }
      this.broadcastState();
      return;
    }

    // 1. Supply line & territory recalculation (every 15 ticks or when dirty)
    if (this.supplyDirty && this.tickCount % 10 === 0) {
      this.recalculateSupplyLines();
      this.supplyDirty = false;
    }

    this.recalculateTerritoryCounts();

    // 2. Economy: Logistic population growth, worker gold income, traitor timer
    this.updateEconomy();

    // 3. Ports & Maritime Trade / Transport Ships
    this.updatePortsAndShips();

    // 4. Physical Dot Swarm Movement, Boids Flocking, Combat & Territory Painting
    this.updateDotsAndCombat();

    // 5. AI Bot Decision Loop
    this.updateBots();

    // 6. Check Elimination & Victory Conditions (80% dominance)
    this.checkVictoryAndEliminations();

    // 7. Broadcast Delta State to all room clients
    this.broadcastState();
  }

  private recalculateTerritoryCounts(): void {
    const counts = new Map<number, number>();
    for (let i = 0; i < this.territory.length; i++) {
      const owner = this.territory[i];
      if (owner !== 0) {
        counts.set(owner, (counts.get(owner) || 0) + 1);
      }
    }

    const activeDotsByOwner = new Map<string, number>();
    for (const d of this.dots.values()) {
      activeDotsByOwner.set(d.ownerId, (activeDotsByOwner.get(d.ownerId) || 0) + d.troops);
    }

    for (const p of this.players.values()) {
      const cells = counts.get(p.numId) || 0;
      p.territoryCells = cells;
      p.territoryPct = Number(((cells / this.totalLandCells) * 100).toFixed(1));
      p.activeDots = activeDotsByOwner.get(p.id) || 0;
    }
  }

  private recalculateSupplyLines(): void {
    // Flood-fill from each player's Cities across contiguous friendly territory.
    // Any cell owned by a player that has cities, but isn't connected to any city of that player, is encircled (supplyGrid[idx] = 0).
    this.supplyGrid.fill(1);
    const visited = new Uint8Array(GRID_WIDTH * GRID_HEIGHT);
    const playerHasCities = new Set<number>();
    const queue: number[] = [];

    for (const b of this.buildings.values()) {
      if (b.type === 'city') {
        const owner = this.players.get(b.ownerId);
        if (!owner) continue;
        playerHasCities.add(owner.numId);
        const gx = Math.floor(b.x / CELL_SIZE);
        const gy = Math.floor(b.y / CELL_SIZE);
        const idx = gy * GRID_WIDTH + gx;
        if (idx >= 0 && idx < this.territory.length && !visited[idx]) {
          visited[idx] = 1;
          queue.push(idx);
        }
      }
    }

    let head = 0;
    while (head < queue.length) {
      const curr = queue[head++];
      const ownerNum = this.territory[curr];
      if (ownerNum === 0) continue;
      const cx = curr % GRID_WIDTH;
      const cy = Math.floor(curr / GRID_WIDTH);

      const neighbors = [
        cy > 0 ? curr - GRID_WIDTH : -1,
        cy < GRID_HEIGHT - 1 ? curr + GRID_WIDTH : -1,
        cx > 0 ? curr - 1 : -1,
        cx < GRID_WIDTH - 1 ? curr + 1 : -1,
      ];

      for (let i = 0; i < 4; i++) {
        const nIdx = neighbors[i];
        if (nIdx !== -1 && !visited[nIdx] && this.territory[nIdx] === ownerNum) {
          visited[nIdx] = 1;
          queue.push(nIdx);
        }
      }
    }

    for (let i = 0; i < this.territory.length; i++) {
      const ownerNum = this.territory[i];
      if (ownerNum !== 0 && playerHasCities.has(ownerNum) && !visited[i]) {
        this.supplyGrid[i] = 0; // Encircled / Cut off from capital & cities!
      }
    }
  }

  private updateEconomy(): void {
    const dt = 1 / TICK_RATE;

    // Count supplied cities per player
    const cityBonusByPlayer = new Map<string, number>();
    for (const b of this.buildings.values()) {
      if (b.type === 'city') {
        const idx = Math.floor(b.y / CELL_SIZE) * GRID_WIDTH + Math.floor(b.x / CELL_SIZE);
        if (this.supplyGrid[idx] === 1) {
          cityBonusByPlayer.set(b.ownerId, (cityBonusByPlayer.get(b.ownerId) || 0) + 180);
        }
      }
    }

    for (const p of this.players.values()) {
      if (!p.alive) continue;

      if (p.traitorTicksLeft > 0) {
        p.traitorTicksLeft--;
      }

      const cityPopBonus = cityBonusByPlayer.get(p.id) || 0;
      p.popCap = Math.max(100, Math.floor(80 + p.territoryCells * 2.4 + cityPopBonus));

      // Logistic population growth: dP/dt = r * P * (1 - P / K)
      // Fastest at P = K / 2, flattens near Pop-Cap
      const r = 0.085;
      const ratio = Math.min(1, p.population / p.popCap);
      const logisticGrowth = r * p.population * (1 - ratio);
      p.population = Math.min(p.popCap, Math.max(10, p.population + logisticGrowth * dt));

      p.workers = Math.floor(p.population * p.workerRatio);
      p.troopReserve = Math.max(0, Math.floor(p.population - p.workers));

      // Continuous Gold income from workers + base territory yield
      const traitorMultiplier = p.traitorTicksLeft > 0 ? 0.65 : 1.0;
      const rawGoldPerSec = (3.5 + p.workers * 0.14 + p.territoryCells * 0.025) * traitorMultiplier;
      p.goldPerSec = Number(rawGoldPerSec.toFixed(1));
      p.gold += rawGoldPerSec * dt;
    }
  }

  private updatePortsAndShips(): void {
    const allPorts: ServerBuilding[] = [];
    for (const b of this.buildings.values()) {
      if (b.type === 'port') {
        allPorts.push(b);
      }
    }

    // Spawn automatic trade ships from supplied ports
    for (const port of allPorts) {
      const idx = Math.floor(port.y / CELL_SIZE) * GRID_WIDTH + Math.floor(port.x / CELL_SIZE);
      if (this.supplyGrid[idx] === 0) continue; // Cut-off ports pause production

      if (port.tradeCooldown > 0) {
        port.tradeCooldown--;
        continue;
      }

      const owner = this.players.get(port.ownerId);
      if (!owner || !owner.alive) continue;

      // Prefer allied ports first, then own distant ports or neutral/non-hostile ports
      const candidateTargets = allPorts.filter((other) => {
        if (other.id === port.id) return false;
        const dist = Math.hypot(other.x - port.x, other.y - port.y);
        if (dist < 220) return false;
        if (other.ownerId === owner.id || owner.allies.has(other.ownerId)) return true;
        return false;
      });

      const fallbackTargets =
        candidateTargets.length > 0
          ? candidateTargets
          : allPorts.filter(
              (other) => other.id !== port.id && Math.hypot(other.x - port.x, other.y - port.y) >= 220
            );

      if (fallbackTargets.length > 0) {
        const dest = fallbackTargets[this.rng.int(0, fallbackTargets.length - 1)];
        const dist = Math.hypot(dest.x - port.x, dest.y - port.y);
        const isAlliedTrade = owner.allies.has(dest.ownerId);
        const goldBonus = Math.round((dist / 15) * (isAlliedTrade ? 1.45 : 1.0));

        const shipId = `ship_${this.nextEntitySeq++}`;
        this.ships.set(shipId, {
          id: shipId,
          kind: 'trade',
          ownerId: owner.id,
          targetOwnerId: dest.ownerId,
          color: owner.color,
          fromX: port.x,
          fromY: port.y,
          toX: dest.x,
          toY: dest.y,
          x: port.x,
          y: port.y,
          speed: 3.4,
          troops: 0,
          goldValue: goldBonus,
          postLandingWaypoints: [],
        });

        port.tradeCooldown = this.rng.int(130, 200);
      } else {
        port.tradeCooldown = 60;
      }
    }

    // Advance all active ships (trade & transport)
    for (const [shipId, ship] of this.ships.entries()) {
      const dx = ship.toX - ship.x;
      const dy = ship.toY - ship.y;
      const dist = Math.hypot(dx, dy);

      if (dist <= ship.speed * 1.5) {
        if (ship.kind === 'trade') {
          const sender = this.players.get(ship.ownerId);
          const receiver = this.players.get(ship.targetOwnerId);
          if (sender && sender.alive) {
            sender.gold += ship.goldValue;
          }
          if (receiver && receiver.alive && receiver.id !== sender?.id) {
            receiver.gold += Math.round(ship.goldValue * 0.85);
          }
        } else if (ship.kind === 'transport') {
          // Disembark troops as physical dot swarm at landing shore
          const owner = this.players.get(ship.ownerId);
          if (owner && owner.alive && ship.troops > 0) {
            const dot = this.createDot(
              owner.id,
              ship.toX,
              ship.toY,
              ship.troops,
              ship.postLandingWaypoints
            );
            this.paintTerritoryUnderDot(dot, owner);
          }
        }
        this.ships.delete(shipId);
      } else {
        ship.x += (dx / dist) * ship.speed;
        ship.y += (dy / dist) * ship.speed;
      }
    }
  }

  private updateDotsAndCombat(): void {
    this.spatialHash.clear();
    for (const dot of this.dots.values()) {
      dot.fighting = false;
      this.spatialHash.insert(dot);
    }

    const defensePosts: ServerBuilding[] = [];
    for (const b of this.buildings.values()) {
      if (b.type === 'defense') {
        defensePosts.push(b);
      }
    }

    for (const [dotId, dot] of this.dots.entries()) {
      const owner = this.players.get(dot.ownerId);
      if (!owner || !owner.alive) {
        this.dots.delete(dotId);
        continue;
      }

      const gx = Math.max(0, Math.min(GRID_WIDTH - 1, Math.floor(dot.x / CELL_SIZE)));
      const gy = Math.max(0, Math.min(GRID_HEIGHT - 1, Math.floor(dot.y / CELL_SIZE)));
      const cellIdx = gy * GRID_WIDTH + gx;

      // Encirclement check
      dot.encircled =
        this.territory[cellIdx] === owner.numId && this.supplyGrid[cellIdx] === 0;

      // Check if boarding a port for naval transport
      if (dot.boardingPortId && dot.amphibiousTarget) {
        const port = this.buildings.get(dot.boardingPortId);
        if (!port || port.ownerId !== owner.id) {
          dot.boardingPortId = null;
        } else if (Math.hypot(dot.x - port.x, dot.y - port.y) <= 28) {
          // Transform into transport ship heading to amphibious target
          const landing = this.findCoastalLandingPoint(
            port.x,
            port.y,
            dot.amphibiousTarget.x,
            dot.amphibiousTarget.y
          );
          const shipId = `ship_${this.nextEntitySeq++}`;
          this.ships.set(shipId, {
            id: shipId,
            kind: 'transport',
            ownerId: owner.id,
            targetOwnerId: owner.id,
            color: owner.color,
            fromX: port.x,
            fromY: port.y,
            toX: landing.x,
            toY: landing.y,
            x: port.x,
            y: port.y,
            speed: 3.9,
            troops: dot.troops,
            goldValue: 0,
            postLandingWaypoints: [dot.amphibiousTarget],
          });
          this.dots.delete(dotId);
          continue;
        }
      }

      // Query neighbors via Spatial Hash Grid for Boids Flocking & Open-Field Interception
      const nearby = this.spatialHash.queryRadius(dot.x, dot.y, 44);
      let sepX = 0;
      let sepY = 0;
      let alignX = 0;
      let alignY = 0;
      let friendlyCount = 0;
      const enemiesInRange: ServerDot[] = [];

      for (let i = 0; i < nearby.length; i++) {
        const other = nearby[i];
        if (other.id === dot.id) continue;
        const dx = dot.x - other.x;
        const dy = dot.y - other.y;
        const dSq = dx * dx + dy * dy;
        const dist = Math.sqrt(dSq) || 0.01;

        if (other.ownerId === dot.ownerId) {
          if (dist < 18) {
            sepX += (dx / dist) * ((18 - dist) / 18);
            sepY += (dy / dist) * ((18 - dist) / 18);
          }
          alignX += other.vx;
          alignY += other.vy;
          friendlyCount++;
        } else if (!owner.allies.has(other.ownerId)) {
          if (dist < 30) {
            enemiesInRange.push(other);
          }
        }
      }

      // Open-field swarm combat
      if (enemiesInRange.length > 0) {
        dot.fighting = true;
        const targetEnemy = enemiesInRange[0];
        targetEnemy.fighting = true;

        // Calculate tactical modifiers: local numerical superiority, Defense Posts, Encirclement Morale, Traitor Debuff
        const localRatio = Math.min(2.0, Math.max(0.5, (friendlyCount + 1) / (enemiesInRange.length + 0.5)));
        let defenseMultiplier = 1.0;
        for (const dp of defensePosts) {
          const d = Math.hypot(dp.x - dot.x, dp.y - dot.y);
          if (d <= DEFENSE_POST_RADIUS) {
            if (dp.ownerId === owner.id || owner.allies.has(dp.ownerId)) {
              defenseMultiplier *= 1.4;
            }
          }
        }

        const moraleMultiplier = dot.encircled ? 0.55 : 1.0;
        const traitorPenalty = owner.traitorTicksLeft > 0 ? 0.65 : 1.0;

        const enemyOwner = this.players.get(targetEnemy.ownerId);
        let enemyDefenseBonus = 1.0;
        for (const dp of defensePosts) {
          const d = Math.hypot(dp.x - targetEnemy.x, dp.y - targetEnemy.y);
          if (d <= DEFENSE_POST_RADIUS && dp.ownerId === targetEnemy.ownerId) {
            enemyDefenseBonus *= 1.45;
          }
        }
        if (enemyOwner && enemyOwner.traitorTicksLeft > 0) {
          enemyDefenseBonus *= 0.65;
        }

        const damageDealt =
          (1.8 + dot.troops * 0.55) *
          localRatio *
          defenseMultiplier *
          moraleMultiplier *
          traitorPenalty /
          enemyDefenseBonus;

        targetEnemy.hp -= damageDealt;
        targetEnemy.troops = Math.max(1, Math.ceil(targetEnemy.hp / 25));

        if (this.tickCount % 3 === 0 && this.combatEffects.length < 35) {
          this.combatEffects.push({
            x: (dot.x + targetEnemy.x) * 0.5,
            y: (dot.y + targetEnemy.y) * 0.5,
            color: owner.color,
          });
        }

        if (targetEnemy.hp <= 0) {
          this.dots.delete(targetEnemy.id);
        }
      }

      // Attack nearby enemy buildings
      for (const [bid, bld] of this.buildings.entries()) {
        if (bld.ownerId !== owner.id && !owner.allies.has(bld.ownerId)) {
          const d = Math.hypot(bld.x - dot.x, bld.y - dot.y);
          if (d <= 28) {
            dot.fighting = true;
            bld.hp -= 2.2 + dot.troops * 0.6;
            if (bld.hp <= 0) {
              // Capture or destroy building
              if (bld.type === 'city' || bld.type === 'port') {
                bld.ownerId = owner.id;
                bld.hp = bld.maxHp * 0.5;
                this.sendNotification(
                  owner,
                  `${bld.type === 'city' ? 'Stadt' : 'Hafen'} erobert!`,
                  'success'
                );
              } else {
                this.buildings.delete(bid);
              }
              this.supplyDirty = true;
            }
          }
        }
      }

      // Movement calculation with terrain & enemy defense post slow modifiers
      let baseSpeed = 2.65;
      const terrainHere = this.terrain[cellIdx];
      if (terrainHere === TerrainType.MOUNTAIN) {
        baseSpeed *= 0.52;
      } else if (terrainHere === TerrainType.WATER) {
        baseSpeed *= 0.38;
      }

      // Slow down inside enemy Defense Post radius
      for (const dp of defensePosts) {
        if (dp.ownerId !== owner.id && !owner.allies.has(dp.ownerId)) {
          if (Math.hypot(dp.x - dot.x, dp.y - dot.y) <= DEFENSE_POST_RADIUS) {
            baseSpeed *= 0.62;
            break;
          }
        }
      }

      if (dot.fighting) {
        baseSpeed *= 0.35;
      }

      let dirX = 0;
      let dirY = 0;

      if (dot.waypoints.length > 0) {
        const wp = dot.waypoints[0];
        const dx = wp.x - dot.x;
        const dy = wp.y - dot.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= 16) {
          dot.waypoints.shift();
        } else {
          dirX = dx / dist;
          dirY = dy / dist;
        }
      } else if (enemiesInRange.length > 0) {
        // Gravitate slightly toward engaged enemy
        const e = enemiesInRange[0];
        const dx = e.x - dot.x;
        const dy = e.y - dot.y;
        const dist = Math.hypot(dx, dy) || 1;
        dirX = (dx / dist) * 0.6;
        dirY = (dy / dist) * 0.6;
      }

      if (friendlyCount > 0) {
        alignX /= friendlyCount;
        alignY /= friendlyCount;
      }

      dot.vx = dirX * baseSpeed + sepX * 1.35 + alignX * 0.12;
      dot.vy = dirY * baseSpeed + sepY * 1.35 + alignY * 0.12;

      const nextX = Math.max(15, Math.min(WORLD_WIDTH - 15, dot.x + dot.vx));
      const nextY = Math.max(15, Math.min(WORLD_HEIGHT - 15, dot.y + dot.vy));
      const nextGx = Math.floor(nextX / CELL_SIZE);
      const nextGy = Math.floor(nextY / CELL_SIZE);
      const nextIdx = nextGy * GRID_WIDTH + nextGx;

      // Prevent marching directly into water unless already on water
      if (this.terrain[nextIdx] === TerrainType.WATER && terrainHere !== TerrainType.WATER) {
        dot.vx = 0;
        dot.vy = 0;
        if (dot.waypoints.length > 0 && !dot.boardingPortId) {
          dot.waypoints.shift();
        }
      } else {
        dot.x = nextX;
        dot.y = nextY;
      }

      // Live territory painting under marching dot
      this.paintTerritoryUnderDot(dot, owner);
    }
  }

  private findCoastalLandingPoint(
    fromX: number,
    fromY: number,
    targetX: number,
    targetY: number
  ): Waypoint {
    const steps = 45;
    let lastLandX = targetX;
    let lastLandY = targetY;
    for (let i = steps; i >= 1; i--) {
      const t = i / steps;
      const sx = fromX + (targetX - fromX) * t;
      const sy = fromY + (targetY - fromY) * t;
      const gx = Math.max(0, Math.min(GRID_WIDTH - 1, Math.floor(sx / CELL_SIZE)));
      const gy = Math.max(0, Math.min(GRID_HEIGHT - 1, Math.floor(sy / CELL_SIZE)));
      if (this.terrain[gy * GRID_WIDTH + gx] !== TerrainType.WATER) {
        lastLandX = sx;
        lastLandY = sy;
      } else {
        break;
      }
    }
    return { x: lastLandX, y: lastLandY };
  }

  private paintTerritoryUnderDot(dot: ServerDot, owner: ServerPlayer): void {
    const gx = Math.floor(dot.x / CELL_SIZE);
    const gy = Math.floor(dot.y / CELL_SIZE);

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx !== 0 && dy !== 0) continue; // Plus-shaped paint brush
        const nx = gx + dx;
        const ny = gy + dy;
        if (nx < 0 || nx >= GRID_WIDTH || ny < 0 || ny >= GRID_HEIGHT) continue;
        const idx = ny * GRID_WIDTH + nx;
        if (this.terrain[idx] === TerrainType.WATER) continue;

        const currentOwnerNum = this.territory[idx];
        if (currentOwnerNum === owner.numId) continue;

        const currentOwnerId = this.numIdToPlayerId.get(currentOwnerNum);
        if (currentOwnerId && owner.allies.has(currentOwnerId)) {
          continue; // Never overwrite allied territory!
        }

        this.setTerritoryCell(idx, owner.numId);
      }
    }
  }

  // ==========================================
  // AUTONOMOUS AI BOT CONTROLLER
  // ==========================================
  private updateBots(): void {
    for (const bot of this.players.values()) {
      if (!bot.isBot || !bot.alive) continue;
      if (bot.aiCooldown > 0) {
        bot.aiCooldown--;
        continue;
      }
      bot.aiCooldown = this.rng.int(22, 42);

      // Dynamic Worker-vs-Troop slider adjustment
      const popFill = bot.population / Math.max(1, bot.popCap);
      if (popFill < 0.45) {
        bot.workerRatio = 0.65;
      } else if (bot.gold > 350) {
        bot.workerRatio = 0.42;
      } else {
        bot.workerRatio = 0.52;
      }

      // Collect bot's buildings
      const myBuildings: ServerBuilding[] = [];
      let myPorts = 0;
      let myCities = 0;
      let myDefenses = 0;
      for (const b of this.buildings.values()) {
        if (b.ownerId === bot.id) {
          myBuildings.push(b);
          if (b.type === 'port') myPorts++;
          else if (b.type === 'city') myCities++;
          else if (b.type === 'defense') myDefenses++;
        }
      }

      // 1. Infrastructure construction with Gold
      if (bot.gold >= 260 && myBuildings.length > 0) {
        const anchor = myBuildings[this.rng.int(0, myBuildings.length - 1)];
        const tryX = anchor.x + this.rng.range(-180, 180);
        const tryY = anchor.y + this.rng.range(-180, 180);
        const gx = Math.floor(tryX / CELL_SIZE);
        const gy = Math.floor(tryY / CELL_SIZE);

        if (gx > 2 && gx < GRID_WIDTH - 2 && gy > 2 && gy < GRID_HEIGHT - 2) {
          if (myPorts < 2 && bot.gold >= BUILDING_COSTS.port && this.isCoastalCell(gx, gy)) {
            this.handleBuildOrder(bot, 'port', tryX, tryY);
          } else if (myCities < 4 && bot.gold >= BUILDING_COSTS.city) {
            this.handleBuildOrder(bot, 'city', tryX, tryY);
          } else if (myDefenses < 3 && bot.gold >= BUILDING_COSTS.defense) {
            this.handleBuildOrder(bot, 'defense', tryX, tryY);
          }
        }
      }

      // 2. Expand & Attack with Dot Swarms
      if (bot.troopReserve >= 28 && myBuildings.length > 0) {
        const anchor = myBuildings[this.rng.int(0, myBuildings.length - 1)];
        const target = this.findBotExpansionTarget(bot, anchor.x, anchor.y);
        if (target) {
          this.handleSpawnCommand(
            bot,
            [anchor.id],
            target.x,
            target.y,
            0.5,
            false
          );
        }
      }

      // 3. Command idle bot dots to march toward frontiers
      const idleDotIds: number[] = [];
      let sumX = 0;
      let sumY = 0;
      for (const d of this.dots.values()) {
        if (d.ownerId === bot.id && d.waypoints.length === 0 && !d.fighting) {
          idleDotIds.push(d.id);
          sumX += d.x;
          sumY += d.y;
        }
      }
      if (idleDotIds.length >= 3) {
        const cx = sumX / idleDotIds.length;
        const cy = sumY / idleDotIds.length;
        const target = this.findBotExpansionTarget(bot, cx, cy);
        if (target) {
          this.handleCommandDots(bot, idleDotIds, target.x, target.y, 1.0, false);
        }
      }
    }
  }

  private findBotExpansionTarget(
    bot: ServerPlayer,
    fromX: number,
    fromY: number
  ): Waypoint | null {
    let bestTarget: Waypoint | null = null;
    let bestScore = -1e9;

    for (let i = 0; i < 24; i++) {
      const angle = this.rng.range(0, Math.PI * 2);
      const dist = this.rng.range(120, 680);
      const tx = Math.max(40, Math.min(WORLD_WIDTH - 40, fromX + Math.cos(angle) * dist));
      const ty = Math.max(40, Math.min(WORLD_HEIGHT - 40, fromY + Math.sin(angle) * dist));
      const gx = Math.floor(tx / CELL_SIZE);
      const gy = Math.floor(ty / CELL_SIZE);
      const idx = gy * GRID_WIDTH + gx;

      if (this.terrain[idx] === TerrainType.WATER) continue;
      const cellOwnerNum = this.territory[idx];
      if (cellOwnerNum === bot.numId) continue;

      const cellOwnerId = this.numIdToPlayerId.get(cellOwnerNum);
      if (cellOwnerId && bot.allies.has(cellOwnerId)) continue;

      // Prefer unclaimed land early, then enemy territory
      const isNeutral = cellOwnerNum === 0;
      const score = (isNeutral ? 120 : 85) - dist * 0.12;
      if (score > bestScore) {
        bestScore = score;
        bestTarget = { x: tx, y: ty };
      }
    }

    return bestTarget;
  }

  private checkVictoryAndEliminations(): void {
    for (const p of this.players.values()) {
      if (!p.alive) continue;

      // Check elimination
      if (p.territoryCells === 0 && p.activeDots === 0 && this.tickCount > 60) {
        p.alive = false;
        if (p.isBot) {
          // Respawn a fresh bot if space/land permits or keep slot clean
          this.removePlayer(p.id, false);
        } else {
          this.sendNotification(
            p,
            'Dein Reich wurde vollständig erobert! Klicke auf Respawn oder wechsle die Lobby.',
            'danger'
          );
        }
        continue;
      }

      // Check 80% dominance victory
      if (p.territoryCells / this.totalLandCells >= WIN_TERRITORY_RATIO) {
        this.status = 'finished';
        this.matchWinner = {
          name: p.name,
          color: p.color,
          territoryPct: p.territoryPct,
          countdownTicks: 10 * TICK_RATE,
        };
        this.sendNotificationToAll(
          `${p.name} dominiert ${p.territoryPct}% der Karte und gewinnt die Runde!`,
          'success'
        );
        break;
      }
    }
  }

  // ==========================================
  // NETWORK SERIALIZATION & BROADCAST
  // ==========================================
  private broadcastState(): void {
    const playersNet: PlayerNetState[] = [];
    for (const p of this.players.values()) {
      playersNet.push({
        id: p.id,
        numId: p.numId,
        name: p.name,
        color: p.color,
        isBot: p.isBot,
        alive: p.alive,
        gold: Math.floor(p.gold),
        goldPerSec: p.goldPerSec,
        population: Math.floor(p.population),
        popCap: p.popCap,
        workerRatio: p.workerRatio,
        workers: p.workers,
        troopReserve: p.troopReserve,
        activeDots: p.activeDots,
        territoryCells: p.territoryCells,
        territoryPct: p.territoryPct,
        allies: Array.from(p.allies),
        pendingAlliancesFrom: Array.from(p.pendingAlliancesFrom),
        traitorTicksLeft: p.traitorTicksLeft,
      });
    }

    const buildingsNet: BuildingNetState[] = [];
    for (const b of this.buildings.values()) {
      buildingsNet.push({
        id: b.id,
        ownerId: b.ownerId,
        type: b.type,
        x: Math.round(b.x),
        y: Math.round(b.y),
        hp: Math.round(b.hp),
        maxHp: b.maxHp,
      });
    }

    const dotsNet: DotNetState[] = [];
    for (const d of this.dots.values()) {
      dotsNet.push({
        id: d.id,
        ownerId: d.ownerId,
        x: Number(d.x.toFixed(1)),
        y: Number(d.y.toFixed(1)),
        vx: Number(d.vx.toFixed(2)),
        vy: Number(d.vy.toFixed(2)),
        hp: Math.round(d.hp),
        troops: d.troops,
        encircled: d.encircled,
        fighting: d.fighting,
        waypoints: d.waypoints,
      });
    }

    const shipsNet: ShipNetState[] = [];
    for (const s of this.ships.values()) {
      shipsNet.push({
        id: s.id,
        kind: s.kind,
        ownerId: s.ownerId,
        color: s.color,
        fromX: Math.round(s.fromX),
        fromY: Math.round(s.fromY),
        toX: Math.round(s.toX),
        toY: Math.round(s.toY),
        x: Number(s.x.toFixed(1)),
        y: Number(s.y.toFixed(1)),
        troops: s.troops,
        goldValue: s.goldValue,
      });
    }

    const territoryDeltas: TerritoryDelta[] = [];
    for (const [idx, ownerNumId] of this.pendingDeltas.entries()) {
      territoryDeltas.push({ idx, ownerNumId });
    }
    this.pendingDeltas.clear();

    const stateMsg: ServerMessage = {
      type: 'state',
      tick: this.tickCount,
      lobby: this.getSummary(),
      players: playersNet,
      buildings: buildingsNet,
      dots: dotsNet,
      ships: shipsNet,
      effects: this.combatEffects,
      territoryDeltas,
      supplyRLE: this.tickCount % 20 === 0 ? encodeRLE(this.supplyGrid) : undefined,
      matchWinner: this.matchWinner
        ? {
            name: this.matchWinner.name,
            color: this.matchWinner.color,
            territoryPct: this.matchWinner.territoryPct,
            countdownSec: Math.ceil(this.matchWinner.countdownTicks / TICK_RATE),
          }
        : null,
    };

    this.broadcast(stateMsg);
  }

  public broadcast(msg: ServerMessage): void {
    const payload = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (!p.isBot && p.ws && p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(payload);
      }
    }
  }

  public sendNotification(
    player: ServerPlayer,
    text: string,
    level: 'info' | 'warning' | 'danger' | 'success'
  ): void {
    if (player.isBot || !player.ws || player.ws.readyState !== WebSocket.OPEN) return;
    const msg: ServerMessage = { type: 'notification', text, level };
    player.ws.send(JSON.stringify(msg));
  }

  public sendNotificationToAll(
    text: string,
    level: 'info' | 'warning' | 'danger' | 'success'
  ): void {
    const msg: ServerMessage = { type: 'notification', text, level };
    this.broadcast(msg);
  }
}

// ==========================================
// MULTI-LOBBY MANAGER & EXPRESS / WS SERVER
// ==========================================
const rooms: Map<string, GameRoom> = new Map();
const clientRoomMap: Map<string, string> = new Map(); // clientId -> roomId

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function initDefaultLobbies(): void {
  const presets: { id: string; code: string; name: string; template: MapTemplate }[] = [
    { id: 'eu-archipelago-1', code: 'VEX101', name: 'EU #1 — Archipel Blitz', template: 'archipelago' },
    { id: 'global-continents-2', code: 'VEX202', name: 'Global #2 — Kontinental Krieg', template: 'continents' },
    { id: 'pangaea-arena-3', code: 'VEX303', name: 'Arena #3 — Pangäa Front', template: 'pangaea' },
  ];

  for (const p of presets) {
    const room = new GameRoom(p.id, p.code, p.name, p.template, true, true, false);
    rooms.set(room.id, room);
  }
}

function getPublicLobbyList(): LobbySummary[] {
  const list: LobbySummary[] = [];
  for (const room of rooms.values()) {
    if (room.isPublic) {
      list.push(room.getSummary());
    }
  }
  return list;
}

function getTotalHumanPlayers(): number {
  let count = 0;
  for (const room of rooms.values()) {
    for (const p of room.players.values()) {
      if (!p.isBot) count++;
    }
  }
  return count;
}

initDefaultLobbies();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static frontend files from public/
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// Coolify Healthcheck Endpoint
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    game: GAME_TITLE,
    uptime: process.uptime(),
    players: getTotalHumanPlayers(),
    lobbies: rooms.size,
  });
});

// Optional REST API for lobby list
app.get('/api/lobbies', (_req, res) => {
  res.status(200).json({ lobbies: getPublicLobbyList() });
});

let nextClientSeq = 1;

wss.on('connection', (ws: WebSocket) => {
  const clientId = `plr_${Date.now()}_${nextClientSeq++}`;

  // Immediately send available public lobbies
  const welcomeMsg: ServerMessage = {
    type: 'lobby_list',
    lobbies: getPublicLobbyList(),
  };
  ws.send(JSON.stringify(welcomeMsg));

  ws.on('message', (raw: Buffer) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'list_lobbies') {
      const listMsg: ServerMessage = {
        type: 'lobby_list',
        lobbies: getPublicLobbyList(),
      };
      ws.send(JSON.stringify(listMsg));
      return;
    }

    if (msg.type === 'create_lobby') {
      leaveCurrentRoom(clientId);
      const code = generateRoomCode();
      const roomId = `custom_${code.toLowerCase()}`;
      const lobbyName =
        (msg.lobbyName || '').trim().slice(0, 28) || `${msg.playerName || 'Commander'}s Front`;
      const room = new GameRoom(
        roomId,
        code,
        lobbyName,
        msg.mapTemplate || 'archipelago',
        Boolean(msg.isPublic),
        Boolean(msg.fillWithBots),
        true
      );
      rooms.set(room.id, room);
      joinRoom(ws, clientId, room, msg.playerName, msg.playerColor);
      return;
    }

    if (msg.type === 'join_lobby') {
      leaveCurrentRoom(clientId);
      let targetRoom: GameRoom | undefined;

      if (msg.lobbyCode) {
        const cleanCode = msg.lobbyCode.trim().toUpperCase();
        targetRoom = Array.from(rooms.values()).find(
          (r) => r.code.toUpperCase() === cleanCode || r.id === msg.lobbyCode
        );
      } else if (msg.lobbyId) {
        targetRoom = rooms.get(msg.lobbyId);
      }

      if (!targetRoom) {
        // Quick-Play fallback: pick public room with most humans that still has space
        const publicRooms = Array.from(rooms.values()).filter(
          (r) => r.isPublic && r.getSummary().humanPlayers < MAX_TOTAL_PLAYERS
        );
        publicRooms.sort((a, b) => b.getSummary().humanPlayers - a.getSummary().humanPlayers);
        targetRoom = publicRooms[0] || Array.from(rooms.values())[0];
      }

      if (targetRoom) {
        joinRoom(ws, clientId, targetRoom, msg.playerName, msg.playerColor);
      }
      return;
    }

    if (msg.type === 'leave_lobby') {
      leaveCurrentRoom(clientId);
      const listMsg: ServerMessage = {
        type: 'lobby_list',
        lobbies: getPublicLobbyList(),
      };
      ws.send(JSON.stringify(listMsg));
      return;
    }

    // Forward in-game actions to the player's current room
    const currentRoomId = clientRoomMap.get(clientId);
    if (currentRoomId) {
      const room = rooms.get(currentRoomId);
      if (room) {
        room.handlePlayerMessage(clientId, msg);
      }
    }
  });

  ws.on('close', () => {
    leaveCurrentRoom(clientId);
  });
});

function joinRoom(
  ws: WebSocket,
  clientId: string,
  room: GameRoom,
  playerName: string,
  playerColor: string
): void {
  const safeColor = FACTION_COLORS.includes(playerColor) ? playerColor : FACTION_COLORS[0];
  room.spawnPlayer(clientId, playerName, safeColor, false, ws);
  clientRoomMap.set(clientId, room.id);

  const initMsg: ServerMessage = {
    type: 'init',
    selfId: clientId,
    lobby: room.getSummary(),
    gridWidth: GRID_WIDTH,
    gridHeight: GRID_HEIGHT,
    cellSize: CELL_SIZE,
    terrainRLE: encodeRLE(room.terrain),
    territoryRLE: encodeRLE(room.territory),
    supplyRLE: encodeRLE(room.supplyGrid),
  };
  ws.send(JSON.stringify(initMsg));
}

function leaveCurrentRoom(clientId: string): void {
  const roomId = clientRoomMap.get(clientId);
  if (!roomId) return;
  clientRoomMap.delete(clientId);

  const room = rooms.get(roomId);
  if (!room) return;

  room.removePlayer(clientId, true);
  if (room.fillWithBots) {
    room.syncBotPopulation();
  }

  // Clean up empty custom lobbies
  if (room.id.startsWith('custom_') && room.getSummary().humanPlayers === 0) {
    rooms.delete(room.id);
  }
}

// ==========================================
// AUTHORITATIVE 20 TPS GAME LOOP
// ==========================================
const tickInterval = setInterval(() => {
  for (const room of rooms.values()) {
    room.updateTick();
  }
}, 1000 / TICK_RATE);

// ==========================================
// SERVER STARTUP & GRACEFUL SHUTDOWN
// ==========================================
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`[${GAME_TITLE}] Server listening on http://${HOST}:${PORT} (${TICK_RATE} TPS)`);
});

let isShuttingDown = false;
function gracefulShutdown(signal: string): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[${GAME_TITLE}] Received ${signal}. Starting graceful shutdown...`);

  clearInterval(tickInterval);

  for (const client of wss.clients) {
    try {
      client.close(1001, 'Server shutting down');
    } catch {
      // ignore close errors
    }
  }

  wss.close(() => {
    server.close(() => {
      console.log(`[${GAME_TITLE}] HTTP and WebSocket servers closed cleanly.`);
      process.exit(0);
    });
  });

  // Fallback force-exit after 4 seconds so Coolify redeploys never hang
  setTimeout(() => {
    console.warn(`[${GAME_TITLE}] Forcing exit after shutdown timeout.`);
    process.exit(0);
  }, 4000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
