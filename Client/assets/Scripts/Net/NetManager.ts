// Net.ts
const WS_URL = "ws://localhost:8080";

export type Cmd = { kind: "select"; x: number; y: number } | { kind: "noop" };

export class Net {
  private ws: WebSocket;
  onStart?: (p: {
    roomId: string;
    playerId: number;
    tickRate: number;
    inputDelay: number;
    seed: number;
  }) => void;
  onFrame?: (p: { tick: number; cmds: { pid: number; cmd: Cmd }[] }) => void;

  connect() {
    this.ws = new WebSocket(WS_URL);
    this.ws.onopen = () =>
      this.ws.send(JSON.stringify({ type: "join", name: "player" }));
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "start") this.onStart?.(msg);
      else if (msg.type === "frame") this.onFrame?.(msg);
    };
  }

  sendInput(roomId: string, tick: number, cmd: Cmd) {
    this.ws?.readyState === this.ws.OPEN &&
      this.ws.send(JSON.stringify({ type: "input", roomId, tick, cmd }));
  }
}
