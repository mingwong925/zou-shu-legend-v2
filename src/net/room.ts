import { io, type Socket } from "socket.io-client";

export type RoomRole = "host" | "cactus";
export interface RoomPlayer { id: string; role: RoomRole; playerIndex: number; label: string; color: string; }
export interface MatchStartPayload { code: string; players: RoomPlayer[]; }
export interface InputPayload { playerId: string; dir: string; }
export interface GameStatePayload { coin: { x: number; y: number; dir: string; lives: number }; cacti: { id: string; x: number; y: number; dir: string; color: string; playerIndex: number; jailed: boolean }[]; dots: string[]; goodShows: { x: number; y: number }[]; fright: number; message: string | null; winner: "coin" | "cacti" | null; }

const SERVER_URL = (import.meta.env.VITE_GAME_SERVER_URL as string | undefined) ?? "http://127.0.0.1:3001";

export function generateRoomCode(): string { return String(Math.floor(100000 + Math.random() * 900000)); }
export function colorForPlayer(index: number): string { return ["#f7c948", "#22aa55", "#3aa0ff", "#ff4040", "#b050ff", "#f7c948"][index - 1] ?? "#ffffff"; }

export class RoomConnection {
  readonly clientId: string;
  readonly code: string;
  readonly role: RoomRole;
  readonly playerIndex: number;
  private socket: Socket;
  private playersListener: ((players: RoomPlayer[]) => void) | null = null;
  private matchStartListener: ((payload: MatchStartPayload) => void) | null = null;
  private closedListener: (() => void) | null = null;
  private pendingMatchStart: MatchStartPayload | null = null;
  private inputListener: ((payload: InputPayload) => void) | null = null;
  private stateListener: ((payload: GameStatePayload) => void) | null = null;
  private players: RoomPlayer[] = [];

  constructor(socket: Socket, code: string, role: RoomRole, player: RoomPlayer) {
    this.socket = socket; this.code = code; this.role = role; this.playerIndex = player.playerIndex; this.clientId = player.id; this.players = [player];
    socket.on("room-players", (players: RoomPlayer[]) => { this.players = players; this.playersListener?.(players); });
    socket.on("match-start", (payload: MatchStartPayload) => {
      if (this.matchStartListener) this.matchStartListener(payload);
      else this.pendingMatchStart = payload;
    });
    socket.on("room-closed", () => this.closedListener?.());
    socket.on("game-state", (payload: GameStatePayload) => this.stateListener?.(payload));
    socket.on("game-input", (payload: InputPayload) => this.inputListener?.(payload));
  }
  onPlayers(listener: (players: RoomPlayer[]) => void): void { this.playersListener = listener; }
  onMatchStart(listener: (payload: MatchStartPayload) => void): void {
    this.matchStartListener = listener;
    if (this.pendingMatchStart) {
      const payload = this.pendingMatchStart;
      this.pendingMatchStart = null;
      listener(payload);
    }
  }
  onClosed(listener: () => void): void { this.closedListener = listener; }
  onInput(listener: (payload: InputPayload) => void): void { this.inputListener = listener; }
  onState(listener: (payload: GameStatePayload) => void): void { this.stateListener = listener; }
  getPlayers(): RoomPlayer[] { return this.players; }
  async startMatch(): Promise<void> { await this.request("room:start", { code: this.code }); }
  async sendInput(dir: string): Promise<void> { this.socket.emit("game-input", { code: this.code, playerId: this.clientId, dir }); }
  async sendState(_payload: GameStatePayload): Promise<void> { /* Server is authoritative. */ }
  async leave(): Promise<void> { this.socket.disconnect(); }
  private request(event: string, payload: unknown): Promise<void> { return new Promise((resolve, reject) => this.socket.emit(event, payload, (result: { ok: boolean; error?: string }) => result.ok ? resolve() : reject(new Error(result.error ?? "Server request failed")))); }
}

async function connectRoom(code: string, role: RoomRole): Promise<RoomConnection> {
  const socket = io(SERVER_URL, {
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: 12,
    reconnectionDelay: 1500,
    timeout: 10000,
  });
  const event = role === "host" ? "room:create" : "room:join";
  const result = await new Promise<{ ok: boolean; error?: string; player: RoomPlayer }>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      socket.disconnect();
      reject(new Error("遊戲伺服器仍在喚醒中，請稍後再試。"));
    }, 65_000);
    socket.on("connect", () => socket.emit(event, { code }, (reply: { ok: boolean; error?: string; player: RoomPlayer }) => { window.clearTimeout(timer); reply.ok ? resolve(reply) : reject(new Error(reply.error)); }));
  });
  return new RoomConnection(socket, code, role, result.player);
}

export async function createRoom(code = generateRoomCode()): Promise<RoomConnection> { return connectRoom(code, "host"); }
export async function joinRoom(code: string): Promise<RoomConnection> { return connectRoom(code, "cactus"); }
