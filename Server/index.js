import { WebSocketServer } from "ws";

const PORT = 8080;
const TICK_MS = 100; // 10Hz（想更跟手可改 50）
const wss = new WebSocketServer({ port: PORT });
console.log(`WS on ws://localhost:${PORT}`);

let nextPid = 1;
let tick = 0;
const latestInputs = new Map(); // pid:number -> {x:number,y:number}

setInterval(() => {
  tick++;
  const snapshot = Object.fromEntries(latestInputs);
  const payload = JSON.stringify({ type: "tick", tick, inputs: snapshot });
  for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
}, TICK_MS);

wss.on("connection", (ws) => {
  const pid = nextPid++;
  latestInputs.set(pid, { x: 0, y: 0 });
  ws.send(JSON.stringify({ type: "hello", pid }));

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === "input" && msg.input) {
      const x = Math.max(-1, Math.min(1, msg.input.x | 0));
      const y = Math.max(-1, Math.min(1, msg.input.y | 0));
      latestInputs.set(pid, { x, y });
    }
  });

  ws.on("close", () => latestInputs.delete(pid));
});
