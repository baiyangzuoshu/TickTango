import { Tick, InputPayload } from "../Types";

type TickListener = (t: Tick, bundle: Record<number, InputPayload>) => void;
type WelcomeListener = (data: {
  playerId: number;
  tps: number;
  tick: number;
  inputLead: number;
  simDelay: number;
}) => void;

export class Net {
  private ws?: WebSocket;
  private url: string;
  public playerId = 0;
  public serverTick = 0;
  public tps = 30;
  public inputLead = 2;
  public simDelay = 2;

  private onTickCb?: TickListener;
  private onWelcomeCb?: WelcomeListener;

  private lastSentTick = -1;

  constructor(url = "ws://localhost:8080") {
    this.url = url;
  }

  connect() {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.onopen = () => resolve();

      ws.onmessage = (ev) => {
        let msg: any;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }

        if (msg.type === "welcome") {
          this.playerId = msg.playerId;
          this.tps = msg.tps;
          this.serverTick = msg.tick | 0;
          this.inputLead = msg.inputLead | 0;
          this.simDelay = msg.simDelay | 0;
          this.onWelcomeCb?.({
            playerId: this.playerId,
            tps: this.tps,
            tick: this.serverTick,
            inputLead: this.inputLead,
            simDelay: this.simDelay,
          });
        }

        if (msg.type === "tick") {
          const t = msg.tick | 0;
          this.serverTick = t;
          this.onTickCb?.(t, msg.inputs ?? {});
        }
      };

      ws.onerror = (e) => reject(e);
      ws.onclose = () => {};
    });
  }

  onWelcome(cb: WelcomeListener) {
    this.onWelcomeCb = cb;
  }
  onTick(cb: TickListener) {
    this.onTickCb = cb;
  }

  // 在收到服务器 tick T 时，发送我们对 (T + inputLead) 的输入（每 tick 仅一次）
  sendInputForUpcomingTick(upcomingTick: Tick, input: InputPayload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (upcomingTick <= this.lastSentTick) return;
    this.lastSentTick = upcomingTick;
    this.ws.send(JSON.stringify({ type: "input", tick: upcomingTick, input }));
  }
}
