import { WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: 8080 });
console.log("WS on ws://localhost:8080");

let tick = 0;
setInterval(() => {
  tick++;
  const msg = JSON.stringify({ type: "tick", tick });
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}, 200); // 每200ms发一个tick（5Hz）
