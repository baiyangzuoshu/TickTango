import { WebSocketServer } from "ws";

const TPS = 30; // 服务器 tick 率
const TICK_MS = 1000 / TPS;
const INPUT_LEAD = 2; // 建议输入超前 2 tick
const SIM_DELAY = 2; // 客户端建议延迟 2 tick 消化

const wss = new WebSocketServer({ port: 8080 });
console.log("[server] ws://localhost:8080");

let tick = 0;
let nextPlayerId = 1;
let nextTickAt = Date.now() + TICK_MS;

// 玩家表：playerId -> { ws, lastInput:{ax} }
const players = new Map();

// 待执行输入：tick -> Map<playerId, {ax}>
const pendingInputs = new Map();

wss.on("connection", (ws) => {
  const playerId = nextPlayerId++;
  players.set(playerId, { ws, lastInput: { ax: 0 } });

  // 欢迎包：告知 tps、当前 tick、推荐缓冲
  ws.send(
    JSON.stringify({
      type: "welcome",
      playerId,
      tps: TPS,
      tick,
      inputLead: INPUT_LEAD,
      simDelay: SIM_DELAY,
    })
  );

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "input") {
      const t = msg.tick | 0;
      // 兜底域校验：ax ∈ {-1,0,1}
      const ax = Math.max(-1, Math.min(1, msg.input?.ax | 0));

      if (!pendingInputs.has(t)) pendingInputs.set(t, new Map());

      pendingInputs.get(t).set(playerId, { ax });

      const p = players.get(playerId);

      if (p) p.lastInput = { ax };

      return;
    }

    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", time: msg.time, tick }));
      return;
    }
  });

  ws.on("close", () => {
    players.delete(playerId);
  });
});

function broadcast(obj) {
  const text = JSON.stringify(obj);
  for (const { ws } of players.values()) {
    try {
      ws.send(text);
    } catch {}
  }
}

function tickLoop() {
  const now = Date.now();

  if (now >= nextTickAt) {
    tick++;

    // 聚合本 tick 的每个玩家输入（无则沿用 lastInput，默认 0）
    const bundle = {};
    for (const [pid, p] of players.entries()) {
      const inpMap = pendingInputs.get(tick);
      const got = inpMap?.get(pid);
      const input = got ?? p.lastInput ?? { ax: 0 };
      bundle[pid] = input;
      p.lastInput = input;
    }
    pendingInputs.delete(tick);

    // 广播：本 tick 的输入集
    broadcast({ type: "tick", tick, inputs: bundle });

    // 漂移修正（不丢 tick）
    while (now >= nextTickAt) nextTickAt += TICK_MS;
  }

  setTimeout(tickLoop, Math.max(0, nextTickAt - Date.now() - 1));
}

tickLoop();
