// ESM 版本
import WebSocket, { WebSocketServer } from "ws";

const TICK_MS = 50; // 20 FPS
let tick = 0; // 服务器权威帧号

const wss = new WebSocketServer({ port: 8080 });
console.log("WS server on ws://localhost:8080");

const inputsPerTick = new Map(); // tick -> [{pid, input}]
let nextPlayerId = 1;

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

wss.on("connection", (ws) => {
  const pid = nextPlayerId++;
  ws.send(JSON.stringify({ type: "hello", pid })); // 分配玩家 id

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    //console.log("ws message", msg);
    if (msg.type === "input" && typeof msg.clientTick === "number") {
      const list = inputsPerTick.get(msg.clientTick) || [];
      list.push({ pid, input: msg.input });
      inputsPerTick.set(msg.clientTick, list);
    }
  });
});

setInterval(() => {
  tick++;
  const bundle = inputsPerTick.get(tick) || [];
  inputsPerTick.delete(tick);
  broadcast({ type: "tick", tick, inputs: bundle });
}, TICK_MS);
