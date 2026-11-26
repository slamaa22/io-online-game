export const GAME_TITLE = 'VexFront.io';
export const GRID_WIDTH = 160;
export const GRID_HEIGHT = 160;
export const CELL_SIZE = 20;
export const WORLD_WIDTH = GRID_WIDTH * CELL_SIZE; // 3200
export const WORLD_HEIGHT = GRID_HEIGHT * CELL_SIZE; // 3200
export const TICK_RATE = 20;
export const MAX_TOTAL_PLAYERS = 15;
export const WIN_TERRITORY_RATIO = 0.80;

export enum TerrainType {
  WATER = 0,
  PLAINS = 1,
  MOUNTAIN = 2,
}

export type MapTemplate = 'archipelago' | 'continents' | 'pangaea';
export type BuildingType = 'city' | 'port' | 'defense' | 'rally';

export const BUILDING_COSTS: Record<BuildingType, number> = {
  city: 250,
  port: 300,
  defense: 200,
  rally: 100,
};

export const DEFENSE_POST_RADIUS = 180;
export const TRAITOR_DURATION_TICKS = 60 * TICK_RATE; // 60 seconds

export interface Waypoint {
  x: number;
  y: number;
}

export interface LobbySummary {
  id: string;
  code: string;
  name: string;
  mapTemplate: MapTemplate;
  isPublic: boolean;
  status: 'waiting' | 'active' | 'finished';
  humanPlayers: number;
  botPlayers: number;
  maxPlayers: number;
  countdownSec: number;
  uptimeSec: number;
}

export interface PlayerNetState {
  id: string;
  numId: number;
  name: string;
  color: string;
  isBot: boolean;
  alive: boolean;
  gold: number;
  goldPerSec: number;
  population: number;
  popCap: number;
  workerRatio: number; // 0.0 to 1.0 (workers proportion)
  workers: number;
  troopReserve: number;
  activeDots: number;
  territoryCells: number;
  territoryPct: number;
  allies: string[];
  pendingAlliancesFrom: string[];
  traitorTicksLeft: number;
}

export interface BuildingNetState {
  id: string;
  ownerId: string;
  type: BuildingType;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
}

export interface DotNetState {
  id: number;
  ownerId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  troops: number;
  encircled: boolean;
  fighting: boolean;
  waypoints: Waypoint[];
}

export interface ShipNetState {
  id: string;
  kind: 'trade' | 'transport';
  ownerId: string;
  color: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  x: number;
  y: number;
  troops: number;
  goldValue: number;
}

export interface CombatEffectNet {
  x: number;
  y: number;
  color: string;
}

export interface TerritoryDelta {
  idx: number;
  ownerNumId: number;
}

export interface RLEPair {
  value: number;
  count: number;
}

// Client -> Server Messages
export type ClientMessage =
  | {
      type: 'list_lobbies';
    }
  | {
      type: 'create_lobby';
      lobbyName: string;
      mapTemplate: MapTemplate;
      isPublic: boolean;
      fillWithBots: boolean;
      playerName: string;
      playerColor: string;
    }
  | {
      type: 'join_lobby';
      lobbyId?: string;
      lobbyCode?: string;
      playerName: string;
      playerColor: string;
    }
  | {
      type: 'leave_lobby';
    }
  | {
      type: 'start_lobby_now';
    }
  | {
      type: 'set_slider';
      workerRatio: number;
    }
  | {
      type: 'build';
      buildingType: BuildingType;
      x: number;
      y: number;
    }
  | {
      type: 'spawn_command';
      sourceBuildingIds: string[];
      targetX: number;
      targetY: number;
      percentage: number; // 0.25, 0.5, 1.0
      queue: boolean;
    }
  | {
      type: 'command_dots';
      dotIds: number[];
      targetX: number;
      targetY: number;
      percentage: number; // 0.25, 0.5, 1.0
      queue: boolean;
    }
  | {
      type: 'diplomacy';
      action: 'request_ally' | 'accept_ally' | 'break_ally';
      targetPlayerId: string;
    };

// Server -> Client Messages
export type ServerMessage =
  | {
      type: 'lobby_list';
      lobbies: LobbySummary[];
    }
  | {
      type: 'init';
      selfId: string;
      lobby: LobbySummary;
      gridWidth: number;
      gridHeight: number;
      cellSize: number;
      terrainRLE: RLEPair[];
      territoryRLE: RLEPair[];
      supplyRLE: RLEPair[];
    }
  | {
      type: 'state';
      tick: number;
      lobby: LobbySummary;
      players: PlayerNetState[];
      buildings: BuildingNetState[];
      dots: DotNetState[];
      ships: ShipNetState[];
      effects: CombatEffectNet[];
      territoryDeltas: TerritoryDelta[];
      supplyRLE?: RLEPair[];
      matchWinner: {
        name: string;
        color: string;
        territoryPct: number;
        countdownSec: number;
      } | null;
    }
  | {
      type: 'full_map_sync';
      lobby: LobbySummary;
      terrainRLE: RLEPair[];
      territoryRLE: RLEPair[];
      supplyRLE: RLEPair[];
    }
  | {
      type: 'notification';
      text: string;
      level: 'info' | 'warning' | 'danger' | 'success';
    };

export function encodeRLE(arr: Uint8Array | number[]): RLEPair[] {
  const result: RLEPair[] = [];
  if (arr.length === 0) return result;
  let currentVal = arr[0];
  let count = 1;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] === currentVal) {
      count++;
    } else {
      result.push({ value: currentVal, count });
      currentVal = arr[i];
      count = 1;
    }
  }
  result.push({ value: currentVal, count });
  return result;
}

export function decodeRLE(rle: RLEPair[], totalLength: number): Uint8Array {
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (let i = 0; i < rle.length; i++) {
    const { value, count } = rle[i];
    for (let c = 0; c < count && offset < totalLength; c++) {
      out[offset++] = value;
    }
  }
  return out;
}
