import "./style.css";
import { createRoom, joinRoom, type GameStatePayload, type RoomConnection, type RoomPlayer } from "./net/room";

type Dir = "up" | "down" | "left" | "right" | "none";

const TILE = 32;
const COLS = 17;
const ROWS = 21;
const W = COLS * TILE;
const H = ROWS * TILE;
const PLAYER_SPEED = 138;
const GHOST_BASE = 92;
const FRIGHT_TIME = 8;
const JAIL_HOLD = 10; // seconds after a cactus is caught during invincibility

/* Validated maze (17x21). '#' wall, '.' dot, 'o' power, ' ' path (no dot),
   'P' player spawn, '-' jail interior, '=' jail door, 'E' ghost spawn (walkable). */
const MAP = [
  "#################",
  "#o......#......o#",
  "#.##.##.#.##.##.#",
  "#...............#",
  "#.##.#.###.#.##.#",
  "#....#.....#....#",
  "###.###.#.###.###",
  "#...............#",
  "#.##.###=###.##.#",
  "#...####-####...#",
  "##.####---####.##",
  "#...#.#####.#...#",
  "#.###.#####.###.#",
  "#...............#",
  "#.##.##.#.##.##.#",
  "#....#.....#....#",
  "###.###.#.###.###",
  "#...............#",
  "#.##.##.#.##.##.#",
  "#o.P.........E.o#",
  "#################",
];

const DIRS: Record<Exclude<Dir, "none">, [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};
const OPPOSITE: Record<Exclude<Dir, "none">, Exclude<Dir, "none">> = {
  up: "down", down: "up", left: "right", right: "left",
};

interface Ghost {
  x: number; y: number;
  dir: Dir;
  color: string;
  state: "chase" | "fright" | "jailed" | "exit";
  jailedTimer: number;
  flashTimer: number;
  target: { tx: number; ty: number } | null;
}

declare global {
  interface Window { __GS_INPUT__?: { setDir: (d: Dir) => void }; game?: Game }
}

class Game {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private startScreen = document.getElementById("startScreen") as HTMLElement;
  private mobileControls = document.getElementById("mobileControls") as HTMLElement;
  private overlay = document.getElementById("overlay") as HTMLElement;
  private hudL = document.getElementById("hudLeft") as HTMLElement;
  private hudM = document.getElementById("hudMid") as HTMLElement;
  private hudR = document.getElementById("hudRight") as HTMLElement;

  private stage = 1;
  private score = 0;
  private lives = 3;
  private fright = 0;
  private readyTimer = 1.2;
  private started = false;
  private over = false;

  private map: string[][] = [];
  private dots = new Set<string>();
  private powers: { x: number; y: number }[] = [];
  private player = { x: 0, y: 0, dir: "none" as Dir, want: "none" as Dir, alive: true };
  private ghosts: Ghost[] = [];

  private keys = new Set<string>();
  private swipe: Dir = "none";
  private gamepadDir: Dir = "none";
  private gamepadActionHeld = false;

  private ticks = 0;
  private updateTicks = 0;
  private playerMoveTotal = 0;
  private ghostMoveTotal = 0;
  private audioCtx: AudioContext | null = null;

  constructor() {
    const container = document.getElementById("game")!;
    this.canvas = document.createElement("canvas");
    this.canvas.width = W; this.canvas.height = H;
    const ctx = this.canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    this.ctx = ctx;
    container.prepend(this.canvas);

    this.bindInput(container);
    this.bindMobileControls();
    window.__GS_INPUT__ = { setDir: (d) => this.swipe = d };
    document.getElementById("multiRestart")?.addEventListener("click", () => window.location.reload());

    this.loadStage();
    this.hideOverlay();
    window.setInterval(() => this.loop(performance.now()), 1000 / 60);
  }

  public debugState() {
    return {
      player: { ...this.player, ...this.tileOf(this.player.x, this.player.y) },
      ghosts: this.ghosts.map((g) => ({ ...g, ...this.tileOf(g.x, g.y) })),
      score: this.score,
      stage: this.stage,
      lives: this.lives,
      fright: this.fright,
      readyTimer: this.readyTimer,
      started: this.started,
      over: this.over,
      ticks: this.ticks,
      updateTicks: this.updateTicks,
      playerMoveTotal: this.playerMoveTotal,
      ghostMoveTotal: this.ghostMoveTotal,
      gamepadDir: this.gamepadDir,
    };
  }

  private unlockAudio(): void {
    if (!this.audioCtx) {
      const AudioCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtor) return;
      this.audioCtx = new AudioCtor();
    }
    if (this.audioCtx.state === "suspended") void this.audioCtx.resume();
  }

  private beep(freq: number, duration: number, type: OscillatorType, gain = 0.06, delay = 0): void {
    this.unlockAudio();
    const audio = this.audioCtx;
    if (!audio) return;
    const start = audio.currentTime + delay;
    const osc = audio.createOscillator();
    const volume = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    volume.gain.setValueAtTime(0.0001, start);
    volume.gain.exponentialRampToValueAtTime(gain, start + 0.01);
    volume.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(volume).connect(audio.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  private playSound(name: "dot" | "power" | "hit" | "eat" | "stage" | "gameover"): void {
    if (name === "dot") this.beep(780, 0.045, "square", 0.035);
    else if (name === "power") {
      this.beep(440, 0.08, "square", 0.055);
      this.beep(660, 0.08, "square", 0.055, 0.08);
      this.beep(880, 0.12, "square", 0.06, 0.16);
    } else if (name === "hit") {
      this.beep(160, 0.16, "sawtooth", 0.08);
      this.beep(95, 0.22, "sawtooth", 0.07, 0.12);
    } else if (name === "eat") {
      this.beep(880, 0.06, "triangle", 0.06);
      this.beep(1180, 0.1, "triangle", 0.06, 0.06);
    } else if (name === "stage") {
      this.beep(520, 0.08, "square", 0.055);
      this.beep(700, 0.08, "square", 0.055, 0.08);
      this.beep(1040, 0.14, "square", 0.06, 0.16);
    } else {
      this.beep(220, 0.12, "sawtooth", 0.075);
      this.beep(160, 0.12, "sawtooth", 0.075, 0.13);
      this.beep(110, 0.24, "sawtooth", 0.075, 0.26);
    }
  }

  /* ---------- input ---------- */
  private bindInput(container: HTMLElement): void {
    window.addEventListener("keydown", (e) => {
      this.unlockAudio();
      const k = e.key.toLowerCase();
      if (["arrowup","arrowdown","arrowleft","arrowright","w","a","s","d"," "].includes(k)) e.preventDefault();
      this.keys.add(k);
      if (this.over && (k === "enter" || k === " ")) { this.returnToCover(); return; }
      if (!this.started && (k === "enter" || k === " ")) this.startGame();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));

    let sx: number | null = null, sy: number | null = null;
    container.style.touchAction = "none";
    container.addEventListener("pointerdown", (e) => {
      if (!this.started) return;
      this.unlockAudio();
      sx = e.clientX; sy = e.clientY;
      container.setPointerCapture(e.pointerId);
      if (this.over) { this.returnToCover(); e.preventDefault(); return; }
      e.preventDefault();
    });
    container.addEventListener("pointermove", (e) => {
      if (sx === null || sy === null) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      const ax = Math.abs(dx), ay = Math.abs(dy);
      if (Math.max(ax, ay) < 16) return;
      this.swipe = ax > ay ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
      e.preventDefault();
    });
    const end = (e: PointerEvent) => { sx = sy = null; this.swipe = "none"; e.preventDefault(); };
    container.addEventListener("pointerup", end);
    container.addEventListener("pointercancel", end);
  }

  private bindMobileControls(): void {
    const buttons = Array.from(this.mobileControls.querySelectorAll<HTMLButtonElement>("[data-dir]"));
    for (const button of buttons) {
      const dir = button.dataset.dir as Dir;
      button.addEventListener("pointerdown", (e) => {
        this.unlockAudio();
        this.swipe = dir;
        this.player.want = dir;
        e.preventDefault();
      });
      button.addEventListener("pointerup", (e) => { this.swipe = "none"; e.preventDefault(); });
      button.addEventListener("pointercancel", (e) => { this.swipe = "none"; e.preventDefault(); });
    }
  }

  private inputDir(): Dir {
    if (this.keys.has("arrowup") || this.keys.has("w")) return "up";
    if (this.keys.has("arrowdown") || this.keys.has("s")) return "down";
    if (this.keys.has("arrowleft") || this.keys.has("a")) return "left";
    if (this.keys.has("arrowright") || this.keys.has("d")) return "right";
    if (this.gamepadDir !== "none") return this.gamepadDir;
    return this.swipe;
  }

  private pollGamepad(): void {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = Array.from(pads).find((candidate): candidate is Gamepad => candidate !== null);
    if (!pad) {
      this.gamepadDir = "none";
      this.gamepadActionHeld = false;
      return;
    }

    const pressed = (index: number) => pad.buttons[index]?.pressed === true;
    const x = pad.axes[0] ?? 0;
    const y = pad.axes[1] ?? 0;
    const axisDeadZone = 0.45;

    if (pressed(12) || y < -axisDeadZone) this.gamepadDir = "up";
    else if (pressed(13) || y > axisDeadZone) this.gamepadDir = "down";
    else if (pressed(14) || x < -axisDeadZone) this.gamepadDir = "left";
    else if (pressed(15) || x > axisDeadZone) this.gamepadDir = "right";
    else this.gamepadDir = "none";

    const actionPressed = pressed(0) || pressed(9) || pressed(16);
    if (actionPressed && !this.gamepadActionHeld) {
      if (this.over) this.returnToCover();
      else if (!this.started) this.startGame();
    }
    this.gamepadActionHeld = actionPressed;
  }

  /* ---------- maze helpers ---------- */
  private at(tx: number, ty: number): string {
    if (ty < 0 || ty >= ROWS || tx < 0 || tx >= COLS) return "#";
    return this.map[ty][tx];
  }
  private walkableForPlayer(tx: number, ty: number): boolean {
    const t = this.at(tx, ty);
    return t !== "#" && t !== "-" && t !== "=";
  }
  private walkableForGhost(tx: number, ty: number): boolean {
    return this.at(tx, ty) !== "#";
  }
  private center(tx: number, ty: number) {
    return { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
  }
  private tileOf(x: number, y: number) {
    return { tx: Math.floor(x / TILE), ty: Math.floor(y / TILE) };
  }

  /* ---------- stage ---------- */
  private stageStats() {
    const count = Math.min(6, this.stage + 1);
    const speed = GHOST_BASE * Math.min(2.3, 1 + Math.max(0, this.stage - 4) * 0.08);
    return { count, speed };
  }

  private loadStage(): void {
    this.map = MAP.map((r) => r.split(""));
    this.dots.clear();
    this.powers = [];
    this.ghosts = [];

    let px = 1, py = 1;
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const t = this.map[y][x];
        const c = this.center(x, y);
        if (t === "P") { px = x; py = y; this.map[y][x] = " "; }
        else if (t === ".") this.dots.add(`${x},${y}`);
        else if (t === "o") this.powers.push({ x: c.x, y: c.y });
        else if (t === "E") { this.map[y][x] = " "; }
      }
    }
    const pc = this.center(px, py);
    this.player.x = pc.x; this.player.y = pc.y; this.player.dir = "none"; this.player.want = "none";

    const { count } = this.stageStats();
    const colors = Array(6).fill("#22aa55") as string[];
    const jailC = this.center(8, 10);
    for (let i = 0; i < count; i++) {
      const spawn = this.center(7 + (i % 3), 10);
      this.ghosts.push({
        x: spawn.x, y: spawn.y, dir: "none",
        color: colors[i % colors.length],
        state: "jailed",
        jailedTimer: 1 + 0.8 * i,
        flashTimer: 0,
        target: null,
      });
      void jailC;
    }
    this.fright = 0;
    this.readyTimer = this.started ? 1.2 : 0;
    this.over = false;
    this.updateHud();
    if (this.started) this.showOverlay("READY!");
  }

  public startGame(): void {
    if (this.started) return;
    this.unlockAudio();
    this.started = true;
    document.getElementById("game")?.classList.remove("multiplayerActive", "damageFlash");
    document.getElementById("game")?.classList.add("singleActive");
    document.getElementById("multiEffect")?.classList.remove("show");
    document.getElementById("hud")?.classList.remove("idle");
    this.startScreen.classList.add("hide");
    this.mobileControls.classList.add("show");
    this.readyTimer = 1.2;
    this.showOverlay("READY!");
  }

  private returnToCover(): void {
    this.started = false;
    this.stage = 1;
    this.score = 0;
    this.lives = 3;
    this.fright = 0;
    this.swipe = "none";
    this.gamepadDir = "none";
    this.loadStage();
    document.getElementById("game")?.classList.remove("singleActive", "damageFlash");
    document.getElementById("multiEffect")?.classList.remove("show", "result", "failure");
    document.getElementById("hud")?.classList.add("idle");
    this.startScreen.classList.remove("hide");
    this.mobileControls.classList.remove("show");
    this.hideOverlay();
  }

  private showOverlay(text: string): void {
    this.overlay.textContent = text;
    this.overlay.classList.add("show");
  }
  private hideOverlay(): void { this.overlay.classList.remove("show"); }

  private showSingleEffect(src: string, alt: string, result: boolean, duration = 0): void {
    const effect = document.getElementById("multiEffect");
    const image = document.getElementById("multiEffectImage") as HTMLImageElement | null;
    if (!effect || !image) return;
    image.src = src;
    image.alt = alt;
    effect.classList.toggle("result", result);
    effect.classList.remove("failure");
    effect.classList.add("show");
    if (duration > 0) window.setTimeout(() => effect.classList.remove("show"), duration);
  }

  private showSingleDamage(): void {
    const game = document.getElementById("game");
    game?.classList.remove("damageFlash");
    void game?.offsetWidth;
    game?.classList.add("damageFlash");
    window.setTimeout(() => game?.classList.remove("damageFlash"), 550);
    this.showSingleEffect("/hp-1.png", "CASH HP -1", false, 1200);
    this.showOverlay("CASH ♥ -1");
    this.readyTimer = 0.9;
  }

  /* ---------- game loop ---------- */
  private loop(now: number): void {
    this.ticks += 1;
    const dt = 1 / 60;
    this.pollGamepad();

    if (this.readyTimer > 0) {
      this.readyTimer -= dt;
      if (this.readyTimer <= 0) this.hideOverlay();
    } else if (this.started && !this.over) {
      this.updateTicks += 1;
      this.updatePlayer(dt);
      this.updateGhosts(dt);
      this.checkCollisions();
    }
    this.draw(now);
  }

  /* ---------- movement core (never sticks) ---------- */
  private trySetDirAtCenter(x: number, y: number, dir: Dir, forGhost: boolean): { x: number; y: number; changed: boolean } {
    const { tx, ty } = this.tileOf(x, y);
    const c = this.center(tx, ty);
    if (Math.abs(x - c.x) > 1 || Math.abs(y - c.y) > 1) return { x, y, changed: false };
    if (dir === "none") return { x: c.x, y: c.y, changed: false };
    const d = DIRS[dir];
    const ok = forGhost ? this.walkableForGhost(tx + d[0], ty + d[1]) : this.walkableForPlayer(tx + d[0], ty + d[1]);
    if (!ok) return { x: c.x, y: c.y, changed: false };
    return { x: c.x, y: c.y, changed: true };
  }

  private moveEntity(
    ent: { x: number; y: number; dir: Dir },
    speed: number, dt: number, forGhost: boolean
  ): void {
    if (ent.dir === "none") return;
    const delta = DIRS[ent.dir];
    const totalStep = speed * dt;
    const canWalk = (tileX: number, tileY: number) => forGhost ? this.walkableForGhost(tileX, tileY) : this.walkableForPlayer(tileX, tileY);

    let remaining = totalStep;
    while (remaining > 0) {
      const subStep = Math.min(remaining, 2);
      const tile = this.tileOf(ent.x, ent.y);
      const tileCenter = this.center(tile.tx, tile.ty);
      const centered = Math.abs(ent.x - tileCenter.x) <= 1 && Math.abs(ent.y - tileCenter.y) <= 1;

      if (centered) {
        ent.x = tileCenter.x;
        ent.y = tileCenter.y;
        if (!canWalk(tile.tx + delta[0], tile.ty + delta[1])) {
          ent.dir = "none";
          return;
        }
      }

      let nextX = ent.x + delta[0] * subStep;
      let nextY = ent.y + delta[1] * subStep;
      if (delta[0] === 0) {
        const centerX = tileCenter.x;
        nextX = centerX;
      } else {
        const centerY = tileCenter.y;
        nextY = centerY;
      }

      const nextTile = this.tileOf(nextX, nextY);
      if (!canWalk(nextTile.tx, nextTile.ty)) {
        ent.x = tileCenter.x;
        ent.y = tileCenter.y;
        ent.dir = "none";
        return;
      }

      ent.x = nextX;
      ent.y = nextY;
      remaining -= subStep;
    }
  }

  private updatePlayer(dt: number): void {
    const p = this.player;
    const want = this.inputDir();
    if (want !== "none") p.want = want;

    // apply queued turn at center
    const r = p.want === p.dir ? { x: p.x, y: p.y, changed: false } : this.trySetDirAtCenter(p.x, p.y, p.want, false);
    if (r.changed) { p.x = r.x; p.y = r.y; p.dir = p.want; }

    // if blocked ahead at center, stop
    if (p.dir !== "none") {
      const { tx, ty } = this.tileOf(p.x, p.y);
      const c = this.center(tx, ty);
      const centered = Math.abs(p.x - c.x) < 0.5 && Math.abs(p.y - c.y) < 0.5;
      if (centered) {
        const d = DIRS[p.dir];
        if (!this.walkableForPlayer(tx + d[0], ty + d[1])) p.dir = "none";
      }
    }

    const beforeX = p.x;
    const beforeY = p.y;
    this.moveEntity(p, PLAYER_SPEED, dt, false);
    this.playerMoveTotal += Math.hypot(p.x - beforeX, p.y - beforeY);

    if (this.fright > 0) this.fright = Math.max(0, this.fright - dt);
  }

  private updateGhosts(dt: number): void {
    const { speed } = this.stageStats();
    const pTile = this.tileOf(this.player.x, this.player.y);

    for (const g of this.ghosts) {
      if (g.flashTimer > 0) g.flashTimer = Math.max(0, g.flashTimer - dt);
      if (g.state === "jailed") {
        g.jailedTimer -= dt;
        if (g.jailedTimer <= 0) g.state = "exit";
        continue;
      }
      if (g.state === "exit") {
        const doorTileX = 8;
        const doorTileY = 8;
        const jailDoorC = this.center(doorTileX, doorTileY);
        const ghostTile = this.tileOf(g.x, g.y);
        const ghostCenter = this.center(ghostTile.tx, ghostTile.ty);
        if (Math.abs(g.x - jailDoorC.x) < 2 && Math.abs(g.y - jailDoorC.y) < 2) {
          g.state = "chase";
          g.x = jailDoorC.x; g.y = jailDoorC.y;
          g.dir = "up";
          continue;
        }
        if (Math.abs(g.x - ghostCenter.x) <= 1 && Math.abs(g.y - ghostCenter.y) <= 1) {
          g.x = ghostCenter.x;
          g.y = ghostCenter.y;
          g.dir = this.ghostChooseDir(ghostTile.tx, ghostTile.ty, g.dir, doorTileX, doorTileY, false);
        }
        this.moveEntity(g, speed, dt, true);
        continue;
      }

      const { tx, ty } = this.tileOf(g.x, g.y);
      const c = this.center(tx, ty);
      const centered = Math.abs(g.x - c.x) <= 1 && Math.abs(g.y - c.y) <= 1;
      if (centered) {
        g.x = c.x; g.y = c.y;
        g.dir = this.ghostChooseDir(tx, ty, g.dir, pTile.tx, pTile.ty, this.fright > 0);
      }
      const sp = this.fright > 0 ? speed * 0.65 : speed;
      const beforeX = g.x;
      const beforeY = g.y;
      this.moveEntity(g, sp, dt, true);
      this.ghostMoveTotal += Math.hypot(g.x - beforeX, g.y - beforeY);
    }
  }

  private ghostChooseDir(tx: number, ty: number, cur: Dir, ptx: number, pty: number, fright: boolean): Dir {
    const options: Exclude<Dir, "none">[] = ["up", "down", "left", "right"];
    let valid = options.filter((d) => {
      const delta = DIRS[d];
      return this.walkableForGhost(tx + delta[0], ty + delta[1]);
    });
    if (valid.length === 0) return "none";
    if (cur !== "none" && valid.length > 1) {
      const rev = OPPOSITE[cur as Exclude<Dir, "none">];
      const narrowed = valid.filter((d) => d !== rev);
      if (narrowed.length) valid = narrowed;
    }

    const distances = this.buildDistanceMap(ptx, pty);
    let bestDir = valid[0];
    let bestScore = fright ? -Infinity : Infinity;
    for (const direction of valid) {
      const delta = DIRS[direction];
      const nextTileX = tx + delta[0];
      const nextTileY = ty + delta[1];
      const distance = distances[nextTileY]?.[nextTileX] ?? Infinity;
      if (!Number.isFinite(distance)) continue;
      const score = distance + Math.random() * 0.01;
      if (fright ? score > bestScore : score < bestScore) {
        bestScore = score;
        bestDir = direction;
      }
    }
    return bestDir;
  }

  private buildDistanceMap(targetX: number, targetY: number): number[][] {
    const distances = Array.from({ length: ROWS }, () => Array(COLS).fill(Infinity) as number[]);
    if (!this.walkableForGhost(targetX, targetY)) return distances;
    const queue: { x: number; y: number }[] = [{ x: targetX, y: targetY }];
    distances[targetY][targetX] = 0;

    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];
      const nextDistance = distances[current.y][current.x] + 1;
      for (const direction of ["up", "down", "left", "right"] as const) {
        const delta = DIRS[direction];
        const nextX = current.x + delta[0];
        const nextY = current.y + delta[1];
        if (!this.walkableForGhost(nextX, nextY) || Number.isFinite(distances[nextY][nextX])) continue;
        distances[nextY][nextX] = nextDistance;
        queue.push({ x: nextX, y: nextY });
      }
    }
    return distances;
  }

  private checkCollisions(): void {
    const p = this.player;
    const pt = this.tileOf(p.x, p.y);
    const key = `${pt.tx},${pt.ty}`;
    if (this.dots.has(key)) {
      this.dots.delete(key);
      this.score += 10;
      this.playSound("dot");
      this.updateHud();
    }

    this.powers = this.powers.filter((pw) => {
      if (Math.abs(pw.x - p.x) < 14 && Math.abs(pw.y - p.y) < 14) {
        this.fright = FRIGHT_TIME;
        this.score += 50;
        for (const g of this.ghosts) if (g.state === "chase") g.state = "fright";
        this.playSound("power");
        this.updateHud();
        return false;
      }
      return true;
    });
    if (this.fright <= 0) {
      for (const g of this.ghosts) if (g.state === "fright") g.state = "chase";
    }

    for (const g of this.ghosts) {
      if (g.state === "jailed" || g.state === "exit") continue;
      const d = Math.hypot(g.x - p.x, g.y - p.y);
      if (d < 16) {
        if (this.fright > 0) {
          this.score += 200;
          g.state = "jailed";
          g.jailedTimer = JAIL_HOLD;
          g.flashTimer = JAIL_HOLD;
          const jc = this.center(8, 10);
          g.x = jc.x; g.y = jc.y; g.dir = "none";
          this.playSound("eat");
          this.updateHud();
        } else {
          this.lives -= 1;
          this.playSound(this.lives <= 0 ? "gameover" : "hit");
          this.updateHud();
          if (this.lives <= 0) {
            this.over = true;
            this.mobileControls.classList.remove("show");
            this.showSingleEffect("/O_win.png", "戈壁兄弟 WIN", true, 3000);
            this.showOverlay(`GAME OVER\nSCORE ${this.score}\nTap / Enter`);
          } else {
            this.loadStagePositionsOnly();
            this.showSingleDamage();
          }
          return;
        }
      }
    }

    if (this.dots.size === 0) {
      this.stage += 1;
      this.playSound("stage");
      this.loadStage();
    }
  }

  // Like loadStage but keeps dots eaten state (used on life lost)
  private loadStagePositionsOnly(): void {
    // keep dots/powers state; just reset player + ghost positions near spawn
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const t = this.map[y][x];
        if (t === "P") { this.map[y][x] = " "; }
      }
    }
    const px = 3, py = 19;
    const pc = this.center(px, py);
    this.player.x = pc.x; this.player.y = pc.y; this.player.dir = "none"; this.player.want = "none";
    this.fright = 0;
    for (let i = 0; i < this.ghosts.length; i++) {
      const g = this.ghosts[i];
      const spawn = this.center(7 + (i % 3), 10);
      g.x = spawn.x; g.y = spawn.y; g.dir = "none";
      g.state = "jailed";
      g.jailedTimer = 1 + 0.8 * i;
      g.flashTimer = 0;
    }
  }

  /* ---------- render ---------- */
  private draw(now: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);

    // maze walls with pixel neon outline
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const t = this.map[y][x];
        if (t === "#") {
          const px = x * TILE, py = y * TILE;
          ctx.fillStyle = "#001a66";
          ctx.fillRect(px, py, TILE, TILE);
          ctx.fillStyle = "#1f4bff";
          ctx.fillRect(px + 3, py + 3, TILE - 6, 2);
          ctx.fillRect(px + 3, py + TILE - 5, TILE - 6, 2);
          ctx.fillRect(px + 3, py + 3, 2, TILE - 6);
          ctx.fillRect(px + TILE - 5, py + 3, 2, TILE - 6);
        } else if (t === "=") {
          const px = x * TILE, py = y * TILE;
          ctx.fillStyle = "#ff4040";
          ctx.fillRect(px + 2, py + TILE / 2 - 2, TILE - 4, 4);
        } else if (t === "-") {
          const px = x * TILE, py = y * TILE;
          ctx.fillStyle = "#05081f";
          ctx.fillRect(px, py, TILE, TILE);
        }
      }
    }
    this.drawJailFrame();

    // dots
    ctx.fillStyle = "#ffd76b";
    for (const k of this.dots) {
      const [x, y] = k.split(",").map(Number);
      ctx.fillRect(x * TILE + 12, y * TILE + 12, 5, 5);
    }

    // power pellets (GOOD SHOW logo)
    const blink = Math.floor(now / 180) % 2 === 0;
    for (const p of this.powers) {
      this.drawGoodShowLogo(p.x, p.y, blink);
    }

    // player — round gold coin with $ glyph
    this.drawCoin(this.player.x, this.player.y, now, this.player.dir);

    // ghosts — pixel cactus with knife
    const frightOn = this.fright > 0;
    for (const g of this.ghosts) this.drawCactus(g, frightOn, now);

    if (this.fright > 0) {
      this.hudM.textContent = `FRIGHT ${this.fright.toFixed(1)}s`;
    } else {
      this.hudM.textContent = `STAGE ${this.stage}`;
    }
  }

  private drawJailFrame(): void {
    const ctx = this.ctx;
    const left = 6 * TILE;
    const top = 8 * TILE;
    const right = 11 * TILE;
    const bottom = 12 * TILE;
    const doorLeft = 8 * TILE;
    const doorRight = 9 * TILE;
    const wall = 10;

    ctx.save();
    ctx.fillStyle = "#001a66";
    ctx.fillRect(left - wall / 2, top - wall / 2, doorLeft - left, wall);
    ctx.fillRect(doorRight, top - wall / 2, right - doorRight + wall / 2, wall);
    ctx.fillRect(left - wall / 2, top - wall / 2, wall, bottom - top + wall);
    ctx.fillRect(right - wall / 2, top - wall / 2, wall, bottom - top + wall);
    ctx.fillRect(left - wall / 2, bottom - wall / 2, right - left + wall, wall);

    ctx.fillStyle = "#1f4bff";
    ctx.fillRect(left - 2, top - 2, doorLeft - left - 6, 3);
    ctx.fillRect(doorRight + 6, top - 2, right - doorRight - 4, 3);
    ctx.fillRect(left - 2, top - 2, 3, bottom - top + 4);
    ctx.fillRect(right - 1, top - 2, 3, bottom - top + 4);
    ctx.fillRect(left - 2, bottom - 1, right - left + 4, 3);

    ctx.fillStyle = "#4f78ff";
    ctx.fillRect(left + 4, top + 5, 4, bottom - top - 10);
    ctx.fillRect(right - 8, top + 5, 4, bottom - top - 10);
    ctx.fillRect(left + 7, bottom - 8, right - left - 14, 4);

    ctx.strokeStyle = "#ffb8d0";
    ctx.lineWidth = 6;
    ctx.lineCap = "square";
    ctx.beginPath();
    ctx.moveTo(doorLeft + 2, top); ctx.lineTo(doorRight - 2, top);
    ctx.stroke();
    ctx.restore();
  }

  private drawGoodShowLogo(cx: number, cy: number, bright: boolean): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.globalAlpha = bright ? 1 : 0.9;

    ctx.fillStyle = "#5400b8";
    ctx.beginPath(); ctx.arc(0, 0, 18, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#aaff00";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, 16, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "#5400b8";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.font = "900 9px ui-monospace, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.strokeText("GOOD", 0, -5);
    ctx.fillStyle = "#ffffff";
    ctx.fillText("GOOD", 0, -5);
    ctx.font = "900 10px ui-monospace, Menlo, monospace";
    ctx.strokeText("SHOW", 0, 6);
    ctx.fillStyle = "#aaff00";
    ctx.fillText("SHOW", 0, 6);

    ctx.strokeStyle = "#aaff00";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-17, -1); ctx.lineTo(-7, -5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(9, 2); ctx.lineTo(17, -2); ctx.stroke();

    ctx.restore();
  }

  private drawCoin(cx: number, cy: number, now: number, dir: Dir): void {
    const ctx = this.ctx;
    const frame = Math.floor(now / 120) % 2;
    ctx.save();
    ctx.translate(cx, cy);

    ctx.fillStyle = "#3d2c0a";
    ctx.beginPath(); ctx.arc(0, 0, 15, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#f7c948";
    ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#ffe58f";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, 8, Math.PI * 1.1, Math.PI * 1.7); ctx.stroke();

    ctx.font = "900 18px ui-monospace, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#ffe58f";
    ctx.strokeText("$", 0, 1);
    ctx.fillStyle = "#3d2c0a";
    ctx.fillText("$", 0, 1);

    // arms
    ctx.fillStyle = "#3d2c0a";
    const armY = dir === "up" ? -16 : dir === "down" ? 10 : -2;
    ctx.fillRect(-17, armY, 5, 4);
    ctx.fillRect(12, armY, 5, 4);

    // legs (running animation)
    ctx.fillStyle = "#3d2c0a";
    if (frame === 0) {
      ctx.fillRect(-11, 14, 4, 7);
      ctx.fillRect(7, 14, 4, 7);
    } else {
      ctx.fillRect(-8, 14, 4, 7);
      ctx.fillRect(4, 14, 4, 7);
    }
    ctx.restore();
  }

  private drawCactus(g: Ghost, frightOn: boolean, now: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(g.x, g.y);
    const bob = Math.floor(now / 160) % 2 === 0 ? 0 : 1;
    ctx.translate(0, bob);

    // shadow
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(-11, 13, 22, 4);

    const flashWhite = (frightOn || g.flashTimer > 0) && Math.floor(now / 120) % 2 === 0;
    const body = flashWhite ? "#ffffff" : "#22aa55";
    const detail = flashWhite ? "#d8d8d8" : "#0e4d24";

    // body (square pixel cactus)
    ctx.fillStyle = body;
    ctx.fillRect(-8, -14, 16, 26);
    ctx.fillRect(-12, -8, 4, 14);
    ctx.fillRect(8, -8, 4, 14);
    // sprout
    ctx.fillRect(-2, -19, 4, 5);
    ctx.fillRect(-6, -16, 2, 3);
    ctx.fillRect(4, -16, 2, 3);
    // highlight stripes
    ctx.fillStyle = detail;
    ctx.fillRect(-6, -12, 1, 22);
    ctx.fillRect(5, -12, 1, 22);

    // knife (right hand) — always drawn, flips color in fright
    ctx.fillStyle = flashWhite ? "#aaff00" : "#e8e8e8";
    ctx.fillRect(12, -10, 5, 8);           // handle-ish
    ctx.fillRect(17, -12, 8, 4);           // blade
    ctx.fillStyle = flashWhite ? "#5400b8" : "#20252b";
    ctx.fillRect(12, -12, 4, 2);           // handle end

    // eyes
    ctx.fillStyle = flashWhite ? "#5400b8" : "#001c0c";
    if (frightOn) {
      ctx.fillRect(-5, -8, 3, 3);
      ctx.fillRect(2, -8, 3, 3);
      ctx.fillRect(-2, -1, 4, 2); // wavy mouth (flat)
    } else {
      ctx.fillRect(-5, -9, 3, 3);
      ctx.fillRect(2, -9, 3, 3);
      ctx.fillRect(-2, -2, 4, 3);
    }

    ctx.restore();
  }

  private updateHud(): void {
    this.hudL.textContent = `SCORE ${this.score}`;
    this.hudM.textContent = `STAGE ${this.stage}`;
    this.hudR.textContent = "♥".repeat(Math.max(0, this.lives));
  }
}

class MultiplayerGame {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private running = true;
  private dots = new Set<string>();
  private coin = { x: 112, y: 624, dir: "none" as Dir, lives: 3 };
  private cacti: { id: string; x: number; y: number; dir: Dir; color: string; playerIndex: number; jailed: boolean }[] = [];
  private loopId = 0;
  private inputLoopId = 0;
  private renderLoopId = 0;
  private swipeStart: { x: number; y: number } | null = null;
  private currentDir: Dir = "none";
  private targetCoin: { x: number; y: number; dir: Dir; lives: number } | null = null;
  private targetCacti: typeof this.cacti = [];
  private goodShows: { x: number; y: number }[] = [];
  private fright = 0;
  private messageTimer = 0;
  private effectTimer = 0;
  private lastRemoteFrame = 0;
  private audioCtx: AudioContext | null = null;

  constructor(private room: RoomConnection, private players: RoomPlayer[]) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = W; this.canvas.height = H;
    this.ctx = this.canvas.getContext("2d")!;
    this.ctx.imageSmoothingEnabled = false;
    const game = document.getElementById("game")!;
    game.classList.add("multiplayerActive");
    game.prepend(this.canvas);
    document.getElementById("multiScreen")?.classList.add("hide");
    document.getElementById("startScreen")?.classList.add("hide");
    document.getElementById("mobileControls")?.classList.add("show");
    this.resetDots();
    this.bindInput();
    this.room.onPlayers((players) => this.removeDepartedCacti(players));
    this.room.onState((payload) => this.applyState(payload));
    this.room.onClosed(() => this.showConnectionFailure());
    document.getElementById("multiRestart")?.addEventListener("click", () => window.location.reload());
    this.start();
  }

  private unlockAudio(): void {
    if (!this.audioCtx) {
      const AudioCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtor) return;
      this.audioCtx = new AudioCtor();
    }
    if (this.audioCtx.state === "suspended") void this.audioCtx.resume();
  }

  private effectBeep(freq: number, duration: number, type: OscillatorType, gain: number, delay = 0): void {
    this.unlockAudio();
    const audio = this.audioCtx;
    if (!audio) return;
    const start = audio.currentTime + delay;
    const oscillator = audio.createOscillator();
    const volume = audio.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(freq, start);
    volume.gain.setValueAtTime(0.0001, start);
    volume.gain.exponentialRampToValueAtTime(gain, start + 0.01);
    volume.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(volume).connect(audio.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }

  private playMultiplayerSound(name: "damage" | "win"): void {
    if (name === "damage") {
      this.effectBeep(150, 0.16, "sawtooth", 0.08);
      this.effectBeep(90, 0.24, "sawtooth", 0.07, 0.12);
      return;
    }
    this.effectBeep(520, 0.08, "triangle", 0.06);
    this.effectBeep(700, 0.08, "triangle", 0.06, 0.08);
    this.effectBeep(1040, 0.16, "triangle", 0.07, 0.16);
  }

  private removeDepartedCacti(players: RoomPlayer[]): void {
    const connectedIds = new Set(players.filter((player) => player.role === "cactus").map((player) => player.id));
    this.cacti = this.cacti.filter((cactus) => connectedIds.has(cactus.id));
    this.targetCacti = this.targetCacti.filter((cactus) => connectedIds.has(cactus.id));
    this.draw();
  }

  private toDir(value: string): Dir {
    return value === "up" || value === "down" || value === "left" || value === "right" ? value : "none";
  }

  private resetDots(): void {
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (MAP[y][x] === ".") this.dots.add(`${x},${y}`);
  }

  private bindInput(): void {
    window.addEventListener("keydown", (event) => {
      const key = event.key.toLowerCase();
      const dir: Dir = key === "arrowup" || key === "w" ? "up" : key === "arrowdown" || key === "s" ? "down" : key === "arrowleft" || key === "a" ? "left" : key === "arrowright" || key === "d" ? "right" : "none";
      if (dir !== "none") { event.preventDefault(); this.setLocalDir(dir); }
    });
    for (const button of document.querySelectorAll<HTMLButtonElement>("#mobileControls [data-dir]")) {
      button.addEventListener("pointerdown", () => this.setLocalDir(this.toDir(button.dataset.dir ?? "none")));
    }
    this.canvas.addEventListener("pointerdown", (event) => {
      this.swipeStart = { x: event.clientX, y: event.clientY };
    });
    this.canvas.addEventListener("pointermove", (event) => {
      if (!this.swipeStart) return;
      const dx = event.clientX - this.swipeStart.x;
      const dy = event.clientY - this.swipeStart.y;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 16) return;
      this.setLocalDir(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up"));
      this.swipeStart = null;
    });
    this.canvas.addEventListener("pointerup", () => { this.swipeStart = null; });
    this.canvas.addEventListener("pointercancel", () => { this.swipeStart = null; });
  }

  private setLocalDir(dir: Dir): void {
    this.currentDir = dir;
    void this.room.sendInput(dir);
  }

  private start(): void {
    this.inputLoopId = window.setInterval(() => this.pollGamepad(), 50);
    this.loopId = window.setInterval(() => { void this.room.sendInput(this.currentDir); }, 50);
    const cactusPlayers = this.players.filter((player) => player.role === "cactus");
    this.cacti = cactusPlayers.map((player, index) => {
      const spawn = { x: (9 + index) * TILE + TILE / 2, y: 19 * TILE + TILE / 2 };
      return { id: player.id, x: spawn.x, y: spawn.y, dir: "none", color: player.color, playerIndex: player.playerIndex, jailed: true };
    });
    this.renderLoopId = window.requestAnimationFrame((time) => this.remoteFrame(time));
    this.draw();
  }

  private end(winner: "coin" | "cacti"): void {
    if (!this.running) return;
    this.running = false;
    window.clearInterval(this.loopId);
    window.clearInterval(this.inputLoopId);
    window.cancelAnimationFrame(this.renderLoopId);
    void this.room.sendState(this.snapshot(winner));
  }

  private showEffect(src: string, alt: string, duration = 0): void {
    if (!document.getElementById("game")?.classList.contains("multiplayerActive")) return;
    const effect = document.getElementById("multiEffect");
    const image = document.getElementById("multiEffectImage") as HTMLImageElement | null;
    if (!effect || !image) return;
    window.clearTimeout(this.effectTimer);
    image.src = src;
    image.alt = alt;
    effect.classList.add("show");
    if (duration > 0) this.effectTimer = window.setTimeout(() => effect.classList.remove("show"), duration);
  }

  private showConnectionFailure(): void {
    this.running = false;
    window.clearInterval(this.loopId);
    window.clearInterval(this.inputLoopId);
    window.cancelAnimationFrame(this.renderLoopId);
    const effect = document.getElementById("multiEffect");
    const image = document.getElementById("multiEffectImage") as HTMLImageElement | null;
    const message = document.getElementById("multiEffectMessage");
    if (!effect || !message) return;
    image?.removeAttribute("src");
    message.textContent = "Failed to connect";
    effect.classList.remove("show", "result");
    void effect.offsetWidth;
    effect.classList.add("show", "result", "failure");
  }

  private showDamage(): void {
    const game = document.getElementById("game");
    game?.classList.remove("damageFlash");
    void game?.offsetWidth;
    game?.classList.add("damageFlash");
    window.setTimeout(() => game?.classList.remove("damageFlash"), 550);
    this.playMultiplayerSound("damage");
    this.showEffect("/hp-1.png", "CASH 心心減一", 1200);
  }

  private snapshot(winner: "coin" | "cacti" | null) {
    return { coin: this.coin, cacti: this.cacti, dots: [...this.dots], goodShows: this.goodShows, fright: this.fright, message: null, winner };
  }

  private applyState(payload: GameStatePayload): void {
    const lostLife = payload.coin.lives < this.coin.lives;
    this.targetCoin = { ...payload.coin, dir: this.toDir(payload.coin.dir) };
    this.coin.lives = payload.coin.lives;
    this.targetCacti = payload.cacti.map((cactus) => ({ ...cactus, dir: this.toDir(cactus.dir) }));
    this.cacti = this.cacti.filter((cactus) => this.targetCacti.some((target) => target.id === cactus.id));
    for (const target of this.targetCacti) {
      if (!this.cacti.some((cactus) => cactus.id === target.id)) this.cacti.push({ ...target });
    }
    this.goodShows = payload.goodShows;
    this.fright = payload.fright;
    this.dots = new Set(payload.dots);
    if (lostLife) {
      this.showDamage();
    } else if (payload.message) {
      const overlay = document.getElementById("overlay");
      if (overlay) { overlay.textContent = payload.message; overlay.classList.add("show"); }
      window.clearTimeout(this.messageTimer);
      this.messageTimer = window.setTimeout(() => overlay?.classList.remove("show"), 1200);
    }
    this.drawHud();
    if (payload.winner) {
      this.playMultiplayerSound("win");
      this.showEffect(payload.winner === "coin" ? "/C_win.png" : "/O_win.png", payload.winner === "coin" ? "COIN WIN" : "戈壁兄弟 WIN");
      document.getElementById("multiEffect")?.classList.add("result");
      this.end(payload.winner);
    }
  }

  private remoteFrame(time: number): void {
    if (!this.running) return;
    const smoothing = 0.22;
    const predictionStep = Math.min(0.05, Math.max(0.001, (time - (this.lastRemoteFrame || time)) / 1000));
    this.lastRemoteFrame = time;
    if (this.targetCoin) {
      this.coin.x += (this.targetCoin.x - this.coin.x) * smoothing;
      this.coin.y += (this.targetCoin.y - this.coin.y) * smoothing;
      this.coin.dir = this.targetCoin.dir;
      this.coin.lives = this.targetCoin.lives;
      this.predict(this.coin, 138, predictionStep);
    }
    for (const cactus of this.cacti) {
      const target = this.targetCacti.find((candidate) => candidate.id === cactus.id);
      if (!target) continue;
      cactus.x += (target.x - cactus.x) * smoothing;
      cactus.y += (target.y - cactus.y) * smoothing;
      cactus.dir = target.dir;
      cactus.jailed = target.jailed;
      if (!cactus.jailed) this.predict(cactus, 92, predictionStep);
    }
    this.draw();
    this.renderLoopId = window.requestAnimationFrame((nextTime) => this.remoteFrame(nextTime));
    void time;
  }

  private predict(entity: { x: number; y: number; dir: Dir }, speed: number, dt: number): void {
    if (entity.dir === "none") return;
    const [dx, dy] = DIRS[entity.dir];
    const nextX = entity.x + dx * speed * dt;
    const nextY = entity.y + dy * speed * dt;
    const tile = this.tile(nextX, nextY);
    const tileValue = tile.x >= 0 && tile.x < COLS && tile.y >= 0 && tile.y < ROWS ? MAP[tile.y][tile.x] : "#";
    const footprintClear = (px: number, py: number) => {
      const points = [[px - 6, py - 8], [px + 6, py - 8], [px - 6, py + 8], [px + 6, py + 8]];
      return points.every(([pointX, pointY]) => {
        const pointTileX = Math.floor(pointX / TILE);
        const pointTileY = Math.floor(pointY / TILE);
        if (pointTileX < 0 || pointTileX >= COLS || pointTileY < 0 || pointTileY >= ROWS) return false;
        return !["#", "-", "="].includes(MAP[pointTileY][pointTileX]);
      });
    };
    if (tileValue === "#" || tileValue === "-" || tileValue === "=" || !footprintClear(nextX, nextY)) return;
    entity.x = nextX;
    entity.y = nextY;
  }

  private tile(x: number, y: number): { x: number; y: number } {
    return { x: Math.floor(x / TILE), y: Math.floor(y / TILE) };
  }

  private pollGamepad(): void {
    const pad = Array.from(navigator.getGamepads?.() ?? []).find((candidate): candidate is Gamepad => candidate !== null);
    if (!pad) return;
    const pressed = (index: number) => pad.buttons[index]?.pressed === true;
    const x = pad.axes[0] ?? 0;
    const y = pad.axes[1] ?? 0;
    if (pressed(12) || y < -0.45) this.setLocalDir("up");
    else if (pressed(13) || y > 0.45) this.setLocalDir("down");
    else if (pressed(14) || x < -0.45) this.setLocalDir("left");
    else if (pressed(15) || x > 0.45) this.setLocalDir("right");
  }

  private draw(): void {
    const ctx = this.ctx;
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      if (MAP[y][x] === "#") { ctx.fillStyle = "#001a66"; ctx.fillRect(x * TILE, y * TILE, TILE, TILE); ctx.strokeStyle = "#1f4bff"; ctx.strokeRect(x * TILE + 2, y * TILE + 2, TILE - 4, TILE - 4); }
      if (MAP[y][x] === "=") { ctx.fillStyle = "#ff4040"; ctx.fillRect(x * TILE + 2, y * TILE + TILE / 2 - 2, TILE - 4, 4); }
    }
    ctx.fillStyle = "#ffe58f";
    for (const dot of this.dots) { const [x, y] = dot.split(",").map(Number); ctx.fillRect(x * TILE + 13, y * TILE + 13, 5, 5); }
    for (const goodShow of this.goodShows) this.drawGoodShowLogo(goodShow.x, goodShow.y);
    this.drawCoin(this.coin.x, this.coin.y);
    for (const cactus of this.cacti) this.drawCactus(cactus.x, cactus.y, this.fright > 0 ? "#ffffff" : cactus.color, cactus.id === this.room.clientId);
    const hudL = document.getElementById("hudLeft"); const hudM = document.getElementById("hudMid");
    if (hudL) hudL.textContent = `DOTS ${this.dots.size}`;
    if (hudM) hudM.textContent = this.fright > 0 ? `GOOD SHOW ${Math.ceil(this.fright / 1000)}s` : `ROOM ${this.room.code}`;
    this.drawHud();
  }

  private drawHud(): void {
    const hudR = document.getElementById("hudRight");
    if (hudR) hudR.textContent = `♥`.repeat(Math.max(0, this.coin.lives));
  }

  private drawCoin(x: number, y: number): void {
    const ctx = this.ctx; const frame = Math.floor(performance.now() / 120) % 2; ctx.fillStyle = "#3d2c0a"; ctx.beginPath(); ctx.arc(x, y, 15, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = "#f7c948"; ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = "#ffe58f"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 8, Math.PI * 1.1, Math.PI * 1.7); ctx.stroke(); ctx.fillStyle = "#3d2c0a"; ctx.font = "900 18px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("$", x, y); ctx.fillRect(x - 17, y - 2, 5, 4); ctx.fillRect(x + 12, y - 2, 5, 4); ctx.fillRect(x - 11, y + 14, 4, 7); ctx.fillRect(x + (frame ? 4 : 7), y + 14, 4, 7);
  }

  private drawCactus(x: number, y: number, color: string, isLocalPlayer: boolean): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    if (isLocalPlayer) {
      ctx.fillStyle = "#39ff14";
      ctx.beginPath();
      ctx.moveTo(-7, -31);
      ctx.lineTo(7, -31);
      ctx.lineTo(0, -21);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "#071505";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.fillStyle = color;
    ctx.fillRect(-8, -14, 16, 26);
    ctx.fillRect(-12, -8, 4, 14);
    ctx.fillRect(8, -8, 4, 14);
    ctx.fillRect(-2, -19, 4, 5);
    ctx.fillRect(-6, -16, 2, 3);
    ctx.fillRect(4, -16, 2, 3);
    ctx.fillStyle = "#0e4d24";
    ctx.fillRect(-6, -12, 1, 22);
    ctx.fillRect(5, -12, 1, 22);
    ctx.fillStyle = "#20252b";
    ctx.fillRect(12, -10, 5, 8);
    ctx.fillStyle = "#c9d1d9";
    ctx.fillRect(17, -12, 8, 4);
    ctx.fillStyle = "#102010";
    ctx.fillRect(-5, -9, 3, 3);
    ctx.fillRect(2, -9, 3, 3);
    ctx.fillRect(-2, -2, 4, 3);
    ctx.restore();
  }

  private drawGoodShowLogo(x: number, y: number): void {
    const ctx = this.ctx; ctx.save(); ctx.translate(x, y); ctx.fillStyle = "#5400b8"; ctx.beginPath(); ctx.arc(0, 0, 18, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = "#aaff00"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 16, 0, Math.PI * 2); ctx.stroke(); ctx.font = "900 8px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#ffffff"; ctx.fillText("GOOD", 0, -5); ctx.fillStyle = "#aaff00"; ctx.fillText("SHOW", 0, 6); ctx.restore();
  }
}

// ---------- UI wiring: Menu + Lobby ----------
class Menu {
  private startButton = document.getElementById("startButton") as HTMLButtonElement;
  private btnSingle = document.getElementById("btnSingle") as HTMLButtonElement;
  private btnMulti = document.getElementById("btnMulti") as HTMLButtonElement;
  private modeScreen = document.getElementById("modeScreen") as HTMLElement;
  private lobbyScreen = document.getElementById("lobbyScreen") as HTMLElement;
  private multiScreen = document.getElementById("multiScreen") as HTMLElement;
  private btnOpenCreate = document.getElementById("btnOpenCreate") as HTMLButtonElement;
  private btnOpenJoin = document.getElementById("btnOpenJoin") as HTMLButtonElement;
  private btnJoin = document.getElementById("btnJoin") as HTMLButtonElement;
  private btnBackToMenu = document.getElementById("btnBackToMenu") as HTMLButtonElement;
  private btnBackFromCreate = document.getElementById("btnBackFromCreate") as HTMLButtonElement;
  private btnBackFromJoin = document.getElementById("btnBackFromJoin") as HTMLButtonElement;
  private btnStartMatch = document.getElementById("btnStartMatch") as HTMLButtonElement;
  private lobbyMenuWrap = document.getElementById("lobbyMenuWrap") as HTMLElement;
  private lobbyCreateWrap = document.getElementById("lobbyCreateWrap") as HTMLElement;
  private lobbyJoinWrap = document.getElementById("lobbyJoinWrap") as HTMLElement;
  private lobbyDetails = document.getElementById("lobbyDetails") as HTMLElement;
  private joinCodeInput = document.getElementById("joinCodeInput") as HTMLInputElement;
  private roomCodeEl = document.getElementById("roomCode") as HTMLElement;
  private playersList = document.getElementById("playersList") as HTMLElement;
  private lobbyMsg = document.getElementById("lobbyMsg") as HTMLElement;
  private multiRoomCode = document.getElementById("multiRoomCode") as HTMLElement;
  private matchStatus = document.getElementById("matchStatus") as HTMLElement;
  private matchPlayersList = document.getElementById("matchPlayersList") as HTMLElement;
  private room: RoomConnection | null = null;
  private game: Game | null = null;

  init(): void {
    this.showCover();
    this.startButton.addEventListener("click", () => this.showModeScreen());
    this.btnSingle.addEventListener("click", () => this.onSingle());
    this.btnMulti.addEventListener("click", () => this.showLobby());
    this.btnBackToMenu.addEventListener("click", () => this.showModeScreen());
    this.btnOpenCreate.addEventListener("click", () => this.showCreateRoom());
    this.btnOpenJoin.addEventListener("click", () => this.showJoinRoom());
    this.btnBackFromCreate.addEventListener("click", () => this.showLobbyMenu());
    this.btnBackFromJoin.addEventListener("click", () => this.showLobbyMenu());
    this.btnJoin.addEventListener("click", () => this.onJoin());
    this.btnStartMatch.addEventListener("click", () => this.onStartMatch());
  }

  private showCover(): void {
    this.modeScreen.classList.add("hide");
    this.lobbyScreen.classList.add("hide");
    this.multiScreen.classList.add("hide");
    document.getElementById("startScreen")?.classList.remove("hide");
    document.getElementById("hud")?.classList.add("idle");
    document.getElementById("game")?.classList.remove("multiplayerActive", "damageFlash");
    document.getElementById("multiEffect")?.classList.remove("show");
  }

  private showModeScreen(): void {
    void this.leaveRoom();
    this.modeScreen.classList.remove("hide");
    this.lobbyScreen.classList.add("hide");
    this.multiScreen.classList.add("hide");
    document.getElementById("startScreen")?.classList.add("hide");
    document.getElementById("hud")?.classList.add("idle");
  }

  private showLobby(): void {
    void this.leaveRoom();
    this.modeScreen.classList.add("hide");
    this.lobbyScreen.classList.remove("hide");
    this.multiScreen.classList.add("hide");
    document.getElementById("startScreen")?.classList.add("hide");
    document.getElementById("hud")?.classList.add("idle");
    this.showLobbyMenu();
  }

  private onSingle(): void {
    this.modeScreen.classList.add("hide");
    this.lobbyScreen.classList.add("hide");
    document.getElementById("startScreen")?.classList.add("hide");
    this.game ??= new Game();
    window.game = this.game;
    this.game.startGame();
  }

  private showLobbyMenu(): void {
    void this.leaveRoom();
    this.lobbyMenuWrap.hidden = false;
    this.lobbyCreateWrap.hidden = true;
    this.lobbyJoinWrap.hidden = true;
    this.lobbyDetails.hidden = true;
    this.roomCodeEl.textContent = "—";
    this.playersList.innerHTML = "";
    this.btnStartMatch.classList.add("hide");
    this.btnJoin.disabled = false;
    this.joinCodeInput.value = "";
  }

  private showCreateRoom(): void {
    this.lobbyMenuWrap.hidden = true;
    this.lobbyCreateWrap.hidden = false;
    this.lobbyJoinWrap.hidden = true;
    this.lobbyDetails.hidden = false;
    void this.onCreate();
  }

  private showJoinRoom(): void {
    this.lobbyMenuWrap.hidden = true;
    this.lobbyCreateWrap.hidden = true;
    this.lobbyJoinWrap.hidden = false;
    this.lobbyDetails.hidden = false;
    this.lobbyMsg.textContent = "請輸入 6 位數字房間密碼";
    this.playersList.innerHTML = "";
    this.joinCodeInput.focus();
  }

  private async onCreate(): Promise<void> {
    this.lobbyMsg.textContent = "建立房間中...";
    try {
      this.room = await createRoom();
      this.roomCodeEl.textContent = this.room.code;
      this.room.onPlayers((players) => this.renderPlayers(players));
      this.room.onMatchStart((payload) => this.showMatch(payload.code, payload.players));
      this.lobbyMsg.textContent = "房間已建立，等待戈壁兄弟加入";
    } catch (error) {
      this.lobbyMsg.textContent = error instanceof Error ? error.message : "建立房間失敗";
    }
  }

  private async onJoin(): Promise<void> {
    const code = this.joinCodeInput.value.trim();
    if (!/^[0-9]{6}$/.test(code)) {
      this.lobbyMsg.textContent = "請輸入 6 位數字密碼";
      return;
    }
    this.btnJoin.disabled = true;
    this.lobbyMsg.textContent = "連線房間中...";
    try {
      this.room = await joinRoom(code);
      this.roomCodeEl.textContent = code;
      this.room.onPlayers((players) => this.renderPlayers(players));
      this.room.onMatchStart((payload) => this.showMatch(payload.code, payload.players));
      this.lobbyMsg.textContent = "已加入房間，等待房主開始";
    } catch (error) {
      this.lobbyMsg.textContent = error instanceof Error ? error.message : "加入房間失敗";
      this.btnJoin.disabled = false;
      await this.leaveRoom();
    }
  }

  private async onStartMatch(): Promise<void> {
    if (!this.room || this.room.role !== "host") return;
    const players = this.room.getPlayers();
    if (players.length < 2) {
      this.lobbyMsg.textContent = "至少需要 2 人才可以開始";
      return;
    }
    this.lobbyMsg.textContent = "通知所有玩家開始...";
    await this.room.startMatch();
  }

  private showMatch(code: string, players: RoomPlayer[]): void {
    this.modeScreen.classList.add("hide");
    this.lobbyScreen.classList.add("hide");
    this.multiScreen.classList.remove("hide");
    document.getElementById("startScreen")?.classList.add("hide");
    document.getElementById("hud")?.classList.remove("idle");
    this.multiRoomCode.textContent = code;
    this.matchStatus.textContent = "MATCH STARTED";
    this.matchPlayersList.innerHTML = "";
    for (const player of players) {
      const row = document.createElement("div");
      row.className = "playerRow";
      row.innerHTML = `<span style="color:${player.color}">${player.label}</span><span class="tag">P${player.playerIndex}</span>`;
      this.matchPlayersList.appendChild(row);
    }
    new MultiplayerGame(this.room!, players);
  }

  private renderPlayers(players: RoomPlayer[]): void {
    this.playersList.innerHTML = "";
    for (const player of players) {
      const isLocalCactus = player.role === "cactus" && player.id === this.room?.clientId;
      const row = document.createElement("div");
      row.className = `playerRow${isLocalCactus ? " you" : ""}`;
      if (isLocalCactus) row.style.backgroundColor = player.color;
      row.innerHTML = `<span style="color:${isLocalCactus ? "#000000" : player.color}">${isLocalCactus ? "戈壁兄弟 YOU" : player.label}</span><span class="tag">P${player.playerIndex}</span>`;
      this.playersList.appendChild(row);
    }
    this.btnStartMatch.classList.toggle("hide", !this.room || this.room.role !== "host" || players.length < 2);
  }

  private async leaveRoom(): Promise<void> {
    if (!this.room) return;
    const room = this.room;
    this.room = null;
    await room.leave();
  }
}

const menu = new Menu();
menu.init();

