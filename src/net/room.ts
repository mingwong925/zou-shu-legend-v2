import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabase } from "./supabase";

export type RoomRole = "host" | "cactus";

export interface RoomPlayer {
  id: string;
  role: RoomRole;
  playerIndex: number;
  label: string;
  color: string;
}

const CACTUS_COLORS = ["#22aa55", "#3aa0ff", "#ff4040", "#b050ff", "#f7c948"];

export function generateRoomCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function createClientId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function colorForPlayer(playerIndex: number): string {
  return playerIndex === 1 ? "#f7c948" : CACTUS_COLORS[playerIndex - 2] ?? "#ffffff";
}

export class RoomConnection {
  readonly clientId: string;
  readonly code: string;
  readonly role: RoomRole;
  readonly playerIndex: number;
  private channel: RealtimeChannel | null = null;
  private playersListener: ((players: RoomPlayer[]) => void) | null = null;

  constructor(code: string, role: RoomRole, playerIndex: number, clientId = createClientId()) {
    this.code = code;
    this.role = role;
    this.playerIndex = playerIndex;
    this.clientId = clientId;
  }

  async connect(): Promise<void> {
    const supabase = getSupabase();
    const channel = supabase.channel(`room:${this.code}`, {
      config: { presence: { key: this.clientId } },
    });
    this.channel = channel;

    channel.on("presence", { event: "sync" }, () => this.emitPlayers());
    channel.on("presence", { event: "join" }, () => this.emitPlayers());
    channel.on("presence", { event: "leave" }, () => this.emitPlayers());

    await new Promise<void>((resolve, reject) => {
      channel.subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track(this.metadata());
          resolve();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          reject(new Error(`Room connection failed: ${status}`));
        }
      });
    });

    this.emitPlayers();
  }

  onPlayers(listener: (players: RoomPlayer[]) => void): void {
    this.playersListener = listener;
    this.emitPlayers();
  }

  async waitForHost(timeoutMs = 3500): Promise<void> {
    if (this.role === "host") return;
    const hasHost = () => this.getPlayers().some((player) => player.role === "host");
    if (hasHost()) return;

    await new Promise<void>((resolve, reject) => {
      const startedAt = Date.now();
      const check = () => {
        if (hasHost()) {
          resolve();
        } else if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error("找不到房間，請確認房間密碼或房主仍在線。"));
        } else {
          window.setTimeout(check, 100);
        }
      };
      check();
    });
  }

  getPlayers(): RoomPlayer[] {
    if (!this.channel) return [];
    const state = this.channel.presenceState<RoomPlayer>();
    const players: RoomPlayer[] = [];
    for (const entries of Object.values(state)) {
      const entry = entries[0];
      if (entry && !players.some((player) => player.id === entry.id)) players.push(entry);
    }
    return players.sort((a, b) => a.playerIndex - b.playerIndex);
  }

  async leave(): Promise<void> {
    if (!this.channel) return;
    await this.channel.untrack();
    await this.channel.unsubscribe();
    this.channel = null;
  }

  private metadata(): RoomPlayer {
    return {
      id: this.clientId,
      role: this.role,
      playerIndex: this.playerIndex,
      label: this.role === "host" ? "金幣 (HOST)" : "仙人掌",
      color: colorForPlayer(this.playerIndex),
    };
  }

  private emitPlayers(): void {
    if (this.playersListener) this.playersListener(this.getPlayers());
  }
}

export async function createRoom(code = generateRoomCode()): Promise<RoomConnection> {
  const room = new RoomConnection(code, "host", 1);
  await room.connect();
  return room;
}

export async function joinRoom(code: string): Promise<RoomConnection> {
  const room = new RoomConnection(code, "cactus", 2);
  await room.connect();
  await room.waitForHost();
  return room;
}
