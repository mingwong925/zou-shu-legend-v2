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
type Player = { id: string; role: "host" | "cactus"; playerIndex: number; color: string; x: number; y: number; dir: Dir };
type Room = { code: string; players: Map<string, Player>; inputs: Map<string, Dir>; dots: Set<string>; coin: { x: number; y: number; dir: Dir; lives: number }; goodShow: { x: number; y: number } | null; nextGoodShowAt: number; frightUntil: number; winner: Winner; timer?: NodeJS.Timeout };

const rooms = new Map<string, Room>();
const app = express();
app.use(cors());
app.get("/health", (_req, res) => res.json({ ok: true, rooms: rooms.size }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const dirs: Record<Exclude<Dir, "none">, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

function dots(): Set<string> { const result = new Set<string>(); for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (MAP[y][x] === ".") result.add(`${x},${y}`); return result; }
function newRoom(code: string): Room { return { code, players: new Map(), inputs: new Map(), dots: dots(), coin: { x: 112, y: 624, dir: "none", lives: 3 }, goodShow: null, nextGoodShowAt: Date.now() + GOOD_SHOW_INTERVAL, frightUntil: 0, winner: null }; }
function walkable(x: number, y: number): boolean { const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE); return tx >= 0 && tx < COLS && ty >= 0 && ty < ROWS && !["#", "-", "="].includes(MAP[ty][tx]); }
function move(entity: { x: number; y: number; dir: Dir }, speed: number): void { if (entity.dir === "none") return; const [dx, dy] = dirs[entity.dir]; const x = entity.x + dx * speed / 20, y = entity.y + dy * speed / 20; if (walkable(x, y)) { entity.x = x; entity.y = y; } else entity.dir = "none"; }
function snapshot(room: Room) { return { coin: room.coin, cacti: [...room.players.values()].filter((p) => p.role === "cactus").map((p) => ({ id: p.id, x: p.x, y: p.y, dir: p.dir, color: p.color, playerIndex: p.playerIndex })), dots: [...room.dots], goodShow: room.goodShow, fright: Math.max(0, room.frightUntil - Date.now()), winner: room.winner }; }
function spawnGoodShow(room: Room): void { const spaces: string[] = []; for (let y = 1; y < ROWS - 1; y++) for (let x = 1; x < COLS - 1; x++) if (walkable(x * TILE + 16, y * TILE + 16) && !room.dots.has(`${x},${y}`)) spaces.push(`${x},${y}`); if (spaces.length) { const [x, y] = spaces[Math.floor(Math.random() * spaces.length)].split(",").map(Number); room.goodShow = { x: x * TILE + 16, y: y * TILE + 16 }; } room.nextGoodShowAt = Date.now() + GOOD_SHOW_INTERVAL; }
function tick(room: Room): void { if (room.winner) return; const now = Date.now(); if (!room.goodShow && now >= room.nextGoodShowAt) spawnGoodShow(room); room.coin.dir = room.inputs.get("coin") ?? room.coin.dir; move(room.coin, COIN_SPEED); for (const player of room.players.values()) if (player.role === "cactus") { player.dir = room.inputs.get(player.id) ?? player.dir; move(player, CACTUS_SPEED); }
  const tile = `${Math.floor(room.coin.x / TILE)},${Math.floor(room.coin.y / TILE)}`; room.dots.delete(tile);
  if (room.goodShow && Math.hypot(room.goodShow.x - room.coin.x, room.goodShow.y - room.coin.y) < 22) { room.goodShow = null; room.frightUntil = now + FRIGHT_DURATION; }
  for (const player of room.players.values()) if (player.role === "cactus" && Math.hypot(player.x - room.coin.x, player.y - room.coin.y) < 21) { if (room.frightUntil > now) { player.x = (9 + player.playerIndex - 2) * TILE + 16; player.y = 624; player.dir = "none"; } else { room.coin.lives--; room.coin.x = 112; room.coin.y = 624; room.coin.dir = "none"; if (room.coin.lives <= 0) room.winner = "cacti"; } }
  if (room.dots.size === 0) room.winner = "coin";
  io.to(room.code).emit("game-state", snapshot(room));
}
function roster(room: Room) { return [...room.players.values()].map(({ id, role, playerIndex, color }) => ({ id, role, playerIndex, color, label: role === "host" ? "金幣 (HOST)" : "仙人掌" })); }

io.on("connection", (socket) => {
  socket.on("room:create", ({ code }, reply) => { if (rooms.has(code)) return reply({ ok: false, error: "房間已存在" }); const room = newRoom(code); room.players.set(socket.id, { id: socket.id, role: "host", playerIndex: 1, color: COLORS[0], x: 0, y: 0, dir: "none" }); rooms.set(code, room); socket.join(code); reply({ ok: true, code, player: roster(room)[0] }); io.to(code).emit("room-players", roster(room)); });
  socket.on("room:join", ({ code }, reply) => { const room = rooms.get(code); if (!room) return reply({ ok: false, error: "找不到房間，請確認房間密碼。" }); if (room.players.size >= 6) return reply({ ok: false, error: "房間已滿" }); const playerIndex = room.players.size + 1; const player: Player = { id: socket.id, role: "cactus", playerIndex, color: COLORS[playerIndex - 1], x: (9 + playerIndex - 2) * TILE + 16, y: 624, dir: "none" }; room.players.set(socket.id, player); socket.join(code); const players = roster(room); reply({ ok: true, code, player: players.find((p) => p.id === socket.id) }); io.to(code).emit("room-players", players); if (room.timer) socket.emit("match-start", { code, players }); });
  socket.on("room:start", ({ code }, reply) => { const room = rooms.get(code); if (!room || room.players.size < 2) return reply({ ok: false, error: "至少需要 2 人" }); room.winner = null; room.dots = dots(); room.goodShow = null; room.nextGoodShowAt = Date.now() + GOOD_SHOW_INTERVAL; room.frightUntil = 0; room.coin = { x: 112, y: 624, dir: "none", lives: 3 }; for (const p of room.players.values()) { p.x = p.role === "host" ? 0 : (9 + p.playerIndex - 2) * TILE + 16; p.y = p.role === "host" ? 0 : 624; p.dir = "none"; } if (!room.timer) room.timer = setInterval(() => tick(room), 50); io.to(code).emit("match-start", { code, players: roster(room) }); reply({ ok: true }); });
  socket.on("game-input", ({ code, playerId, dir }, reply) => { const room = rooms.get(code); if (!room || playerId !== socket.id) return reply?.({ ok: false }); room.inputs.set(room.players.get(socket.id)?.role === "host" ? "coin" : socket.id, dir); reply?.({ ok: true }); });
  socket.on("disconnect", () => { for (const [code, room] of rooms) if (room.players.delete(socket.id)) { io.to(code).emit("room-players", roster(room)); if (room.players.size === 0) { if (room.timer) clearInterval(room.timer); rooms.delete(code); } else if ([...room.players.values()].every((p) => p.role !== "host")) { if (room.timer) clearInterval(room.timer); io.to(code).emit("room-closed"); rooms.delete(code); } } });
});
server.listen(PORT, () => console.log(`Authoritative game server listening on ${PORT}`));
