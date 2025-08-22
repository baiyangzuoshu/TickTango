import { WebSocketServer } from "ws";
import crypto from "crypto";

const wss = new WebSocketServer({ port: 8080 });

const TICK_RATE = 20;
const TICK_MS = 1000 / TICK_RATE;

class Room {
  constructor(id) {
    this.id = id;
    this.players = new Map();
    this.tick = 0;
    this.inputDelay = 3;
    this.seed = crypto.randomBytes(4).readUInt32BE(0);
    this.buffer = new Map();
    this.timer = null;
  }
  addPlayer(ws) {
    const pid = this.players.size + 1;
    this.players.set(ws, { id: pid });
    ws.send(
      JSON.stringify({
        type: "start",
        roomId: this.id,
        playerId: pid,
        tickRate: TICK_RATE,
        inputDelay: this.inputDelay,
        seed: this.seed,
      })
    );
    if (this.players.size === 2 && !this.timer) this.start();
  }
  start() {
    this.timer = setInterval(() => {
      this.tick++;
      const cmds = [];
      for (const [ws, { id: pid }] of this.players) {
        const byTick = this.buffer.get(this.tick) || new Map();
        const list = byTick.get(pid) || [];
        if (list.length === 0) cmds.push({ pid, cmd: { kind: "noop" } });
        else list.forEach((cmd) => cmds.push({ pid, cmd }));
      }
      const frame = { type: "frame", roomId: this.id, tick: this.tick, cmds };
      const text = JSON.stringify(frame);
      for (const ws of this.players.keys()) {
        if (ws.readyState === ws.OPEN) ws.send(text);
      }
      this.buffer.delete(this.tick - 10);
    }, TICK_MS);
  }
  pushInput(pid, tick, cmd) {
    if (tick < this.tick) return;
    if (!this.buffer.has(tick)) this.buffer.set(tick, new Map());
    const byTick = this.buffer.get(tick);
    if (!byTick.has(pid)) byTick.set(pid, []);
    byTick.get(pid).push(cmd);
  }
  close() {
    if (this.timer) clearInterval(this.timer);
  }
}

const room = new Room("r1");

wss.on("connection", (ws) => {
  room.addPlayer(ws);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "input") {
      const player = room.players.get(ws);
      if (!player) return;
      room.pushInput(player.id, msg.tick, msg.cmd);
    } else if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", t: msg.t }));
    }
  });

  ws.on("close", () => {
    room.players.delete(ws);
    if (room.players.size === 0) room.close();
  });
});

console.log("ws://localhost:8080 ready");
