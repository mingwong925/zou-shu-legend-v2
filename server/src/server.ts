import http from "node:http";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";

const PORT = Number(process.env.PORT ?? 3001);
const TILE = 32;
const COLS = 17;
const ROWS = 21;
const COIN_SPEED = 138;
const CACTUS_SPEED = 92;
const GOOD_SHOW_INTERVAL = 90_000;
const FRIGHT_DURATION = 8_000;
const INITIAL_GOOD_SHOWS = 4;
const MAP = [
  "#################", "#o......#......o#", "#.##.##.#.##.##.#", "#...............#",
  "#.##.#.###.#.##.#", "#....#.....#....#", "###.###.#.###.###", "#...............#",
  "#.##.###=###.##.#", "#...####-####...#", "##.####---####.##", "#...#.#####.#...#",
  "#.###.#####.###.#", "#...............#", "#.##.##.#.##.##.#", "#....#.....#....#",
  "###.###.#.###.###", "#...............#", "#.##.##.#.##.##.#", "#o.P.........E.o#",
  "#################",
];
const COLORS = ["#f7c948", "#22aa55", "#3aa0ff", "#ff4040", "#b050ff", "#f7c948"];
type Dir = "up" | "down" | "left" | "right" | "none";
type Winner = "coin" | "cacti" | null;
type Player = { id: string; role: "host" | "cactus"; playerIndex: number; color: string; x: number; y: number; dir: Dir; want: Dir; jailedUntil: number };
type Room = { code: string; players: Map<string, Player>; inputs: Map<string, Dir>; dots: Set<string>; coin: { x: number; y: number; dir: Dir; want: Dir; lives: number }; goodShows: { x: number; y: number }[]; nextGoodShowAt: number; frightUntil: number; message: string | null; messageUntil: number; winner: Winner; timer?: NodeJS.Timeout };

const rooms = new Map<string, Room>();
const app = express();
app.use(cors());
app.get("/health", (_req, res) => res.json({ ok: true, rooms: rooms.size }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const dirs: Record<Exclude<Dir, "none">, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

function dots(): Set<string> { const result = new Set<string>(); for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (MAP[y][x] === ".") result.add(`${x},${y}`); return result; }
function newRoom(code: string): Room { return { code, players: new Map(), inputs: new Map(), dots: dots(), coin: { x: 112, y: 624, dir: "none", want: "none", lives: 3 }, goodShows: [], nextGoodShowAt: Date.now() + GOOD_SHOW_INTERVAL, frightUntil: 0, message: null, messageUntil: 0, winner: null }; }
function walkable(x: number, y: number): boolean { const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE); return tx >= 0 && tx < COLS && ty >= 0 && ty < ROWS && !["#", "-", "="].includes(MAP[ty][tx]); }
function walkableFootprint(x: number, y: number, halfWidth: number, halfHeight: number): boolean { return walkable(x - halfWidth, y - halfHeight) && walkable(x + halfWidth, y - halfHeight) && walkable(x - halfWidth, y + halfHeight) && walkable(x + halfWidth, y + halfHeight); }
function applyQueuedTurn(entity: { x: number; y: number; dir: Dir; want: Dir }, _halfWidth: number, _halfHeight: number): void { if (entity.want === "none") return; const tileX = Math.floor(entity.x / TILE), tileY = Math.floor(entity.y / TILE); const centerX = tileX * TILE + TILE / 2, centerY = tileY * TILE + TILE / 2; if (Math.abs(entity.x - centerX) > 2 || Math.abs(entity.y - centerY) > 2) return; const [dx, dy] = dirs[entity.want]; if (!walkable(centerX + dx * TILE, centerY + dy * TILE)) return; entity.x = centerX; entity.y = centerY; entity.dir = entity.want; }
function move(entity: { x: number; y: number; dir: Dir; want: Dir }, speed: number, halfWidth: number, halfHeight: number): void { applyQueuedTurn(entity, halfWidth, halfHeight); if (entity.dir === "none") return; const [dx, dy] = dirs[entity.dir]; const distance = speed / 20; const steps = Math.max(1, Math.ceil(distance / 2)); const step = distance / steps; for (let i = 0; i < steps; i++) { const x = entity.x + dx * step, y = entity.y + dy * step; if (!walkable(x, y)) { if (dx !== 0) entity.x = Math.floor(entity.x / TILE) * TILE + TILE / 2; if (dy !== 0) entity.y = Math.floor(entity.y / TILE) * TILE + TILE / 2; entity.dir = "none"; return; } entity.x = x; entity.y = y; } }
function snapshot(room: Room) { const now = Date.now(); return { coin: room.coin, cacti: [...room.players.values()].filter((p) => p.role === "cactus").map((p) => ({ id: p.id, x: p.x, y: p.y, dir: p.dir, color: p.color, playerIndex: p.playerIndex, jailed: p.jailedUntil > now })), dots: [...room.dots], goodShows: room.goodShows, fright: Math.max(0, room.frightUntil - now), message: room.messageUntil > now ? room.message : null, winner: room.winner }; }
function spawnGoodShow(room: Room): void { const spaces: string[] = []; const used = new Set(room.goodShows.map((item) => `${Math.floor(item.x / TILE)},${Math.floor(item.y / TILE)}`)); for (let y = 1; y < ROWS - 1; y++) for (let x = 1; x < COLS - 1; x++) { const px = x * TILE + 16; const py = y * TILE + 16; if (walkable(px, py) && !room.dots.has(`${x},${y}`) && !used.has(`${x},${y}`) && Math.hypot(px - room.coin.x, py - room.coin.y) > 64) spaces.push(`${x},${y}`); } if (spaces.length) { const [x, y] = spaces[Math.floor(Math.random() * spaces.length)].split(",").map(Number); room.goodShows.push({ x: x * TILE + 16, y: y * TILE + 16 }); } room.nextGoodShowAt = Date.now() + GOOD_SHOW_INTERVAL; }
function spawnInitialGoodShows(room: Room): void { for (let i = 0; i < INITIAL_GOOD_SHOWS; i++) spawnGoodShow(room); }
function tick(room: Room): void { if (room.winner) return; const now = Date.now(); if (now >= room.nextGoodShowAt) spawnGoodShow(room); room.coin.want = room.inputs.get("coin") ?? room.coin.want; move(room.coin, COIN_SPEED, 7, 8); for (const player of room.players.values()) if (player.role === "cactus" && player.jailedUntil <= now) { if (player.x === 240 && player.y === 336) { player.x = 272; player.y = 240; } player.want = room.inputs.get(player.id) ?? player.want; move(player, CACTUS_SPEED, 6, 8); }
  const tile = `${Math.floor(room.coin.x / TILE)},${Math.floor(room.coin.y / TILE)}`; room.dots.delete(tile);
  const collected = room.goodShows.findIndex((item) => Math.hypot(item.x - room.coin.x, item.y - room.coin.y) < 22); if (collected >= 0) { room.goodShows.splice(collected, 1); room.frightUntil = now + FRIGHT_DURATION; }
  for (const player of room.players.values()) if (player.role === "cactus" && player.jailedUntil <= now && Math.hypot(player.x - room.coin.x, player.y - room.coin.y) < 21) { if (room.frightUntil > now) { player.x = 240; player.y = 336; player.dir = "none"; player.jailedUntil = now + 3_000; } else { room.coin.lives--; room.coin.x = 112; room.coin.y = 624; room.coin.dir = "none"; player.x = 240; player.y = 336; player.dir = "none"; player.jailedUntil = now + 3_000; room.message = "金幣 ♥ -1"; room.messageUntil = now + 1_200; if (room.coin.lives <= 0) room.winner = "cacti"; } }
  if (room.dots.size === 0) room.winner = "coin";
  io.to(room.code).emit("game-state", snapshot(room));
}
function roster(room: Room) { return [...room.players.values()].map(({ id, role, playerIndex, color }) => ({ id, role, playerIndex, color, label: role === "host" ? "金幣 (HOST)" : "仙人掌" })); }

io.on("connection", (socket) => {
  socket.on("room:create", ({ code }, reply) => { if (rooms.has(code)) return reply({ ok: false, error: "房間已存在" }); const room = newRoom(code); room.players.set(socket.id, { id: socket.id, role: "host", playerIndex: 1, color: COLORS[0], x: 0, y: 0, dir: "none", want: "none", jailedUntil: 0 }); rooms.set(code, room); socket.join(code); reply({ ok: true, code, player: roster(room)[0] }); io.to(code).emit("room-players", roster(room)); });
  socket.on("room:join", ({ code }, reply) => { const room = rooms.get(code); if (!room) return reply({ ok: false, error: "找不到房間，請確認房間密碼。" }); if (room.players.size >= 6) return reply({ ok: false, error: "房間已滿" }); const playerIndex = room.players.size + 1; const player: Player = { id: socket.id, role: "cactus", playerIndex, color: COLORS[playerIndex - 1], x: 240, y: 336, dir: "none", want: "none", jailedUntil: Date.now() + 2_000 }; room.players.set(socket.id, player); socket.join(code); const players = roster(room); reply({ ok: true, code, player: players.find((p) => p.id === socket.id) }); io.to(code).emit("room-players", players); if (room.timer) socket.emit("match-start", { code, players }); });
  socket.on("room:start", ({ code }, reply) => { const room = rooms.get(code); if (!room || room.players.size < 2) return reply({ ok: false, error: "至少需要 2 人" }); const now = Date.now(); room.winner = null; room.dots = dots(); room.goodShows = []; room.nextGoodShowAt = now + GOOD_SHOW_INTERVAL; room.frightUntil = 0; room.message = null; room.coin = { x: 112, y: 624, dir: "none", want: "none", lives: 3 }; spawnInitialGoodShows(room); for (const p of room.players.values()) { p.x = p.role === "host" ? 0 : 240; p.y = p.role === "host" ? 0 : 336; p.dir = "none"; p.want = "none"; p.jailedUntil = p.role === "host" ? 0 : now + 2_000; } if (!room.timer) room.timer = setInterval(() => tick(room), 50); io.to(code).emit("match-start", { code, players: roster(room) }); reply({ ok: true }); });
  socket.on("game-input", ({ code, playerId, dir }, reply) => { const room = rooms.get(code); if (!room || playerId !== socket.id) return reply?.({ ok: false }); room.inputs.set(room.players.get(socket.id)?.role === "host" ? "coin" : socket.id, dir); reply?.({ ok: true }); });
  socket.on("disconnect", () => { for (const [code, room] of rooms) if (room.players.delete(socket.id)) { io.to(code).emit("room-players", roster(room)); if (room.players.size === 0) { if (room.timer) clearInterval(room.timer); rooms.delete(code); } else if ([...room.players.values()].every((p) => p.role !== "host")) { if (room.timer) clearInterval(room.timer); io.to(code).emit("room-closed"); rooms.delete(code); } } });
});
server.listen(PORT, () => console.log(`Authoritative game server listening on ${PORT}`));
