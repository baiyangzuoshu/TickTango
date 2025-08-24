import { WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: 8080 });
console.log("WS on ws://localhost:8080");

let nextPid = 1;
const inputs = new Map(); // pid -> {x,y}

setInterval(() => {
  // 每100ms发一次：把“当前所有玩家的输入方向”广播出去
  const payload = JSON.stringify({
    type: "tick",
    inputs: Object.fromEntries(inputs), // { "1": {x:0,y:1}, "2": {...} }
  });
  for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
}, 100); // 10Hz，平滑一些

wss.on("connection", (ws) => {
  const pid = nextPid++;
  inputs.set(pid, { x: 0, y: 0 });
  ws.send(JSON.stringify({ type: "hello", pid }));

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === "input" && msg.input) {
      // 只保存“该玩家的最新输入方向”（-1/0/1）
      const x = Math.max(-1, Math.min(1, msg.input.x | 0));
      const y = Math.max(-1, Math.min(1, msg.input.y | 0));
      inputs.set(pid, { x, y });
    }
  });

  ws.on("close", () => inputs.delete(pid));
});
