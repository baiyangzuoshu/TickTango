import {
  _decorator,
  Component,
  Node,
  Vec3,
  input,
  Input,
  EventKeyboard,
  KeyCode,
  instantiate,
  Label,
} from "cc";
const { ccclass, property } = _decorator;

@ccclass("TickInput")
export class TickInput extends Component {
  @property(Node) boxTemplate: Node | null = null;

  private ws!: WebSocket;
  private pid = -1;
  private myInput = { x: 0, y: 0 }; // 我的最新输入
  private players = new Map<number, Node>(); // pid -> Node
  private STEP_PIXELS = 8; // 每个 tick 移动的像素

  onLoad() {
    this.ws = new WebSocket("ws://localhost:8080");
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.type === "hello") {
        this.pid = msg.pid;
        this.ensurePlayer(this.pid);
      } else if (msg.type === "tick" && msg.inputs) {
        const inputTable = msg.inputs as Record<
          string,
          { x: number; y: number }
        >;
        for (const [pidStr, dir] of Object.entries(inputTable)) {
          const pid = Number(pidStr);
          this.ensurePlayer(pid);
          const node = this.players.get(pid)!;
          const p = node.position;
          node.setPosition(
            new Vec3(
              p.x + this.STEP_PIXELS * dir.x,
              p.y + this.STEP_PIXELS * dir.y,
              p.z
            )
          );
        }
      }
    };

    input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    input.on(Input.EventType.KEY_UP, this.onKeyUp, this);
  }

  private ensurePlayer(pid: number) {
    if (this.players.has(pid) || !this.boxTemplate) return;
    const n = instantiate(this.boxTemplate);
    n.setParent(this.node);
    // 简单错位放置
    const i = this.players.size;
    n.setPosition(new Vec3(-200 + i * 60, 0, 0));
    this.players.set(pid, n);
    n.getComponent(Label).string = pid.toString();
  }

  private sendInput() {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify({ type: "input", input: this.myInput }));
    }
  }

  private onKeyDown(e: EventKeyboard) {
    if (e.keyCode === KeyCode.KEY_W) this.myInput.y = 1;
    else if (e.keyCode === KeyCode.KEY_S) this.myInput.y = -1;
    else if (e.keyCode === KeyCode.KEY_A) this.myInput.x = -1;
    else if (e.keyCode === KeyCode.KEY_D) this.myInput.x = 1;
    this.sendInput();
  }
  private onKeyUp(e: EventKeyboard) {
    if (e.keyCode === KeyCode.KEY_W || e.keyCode === KeyCode.KEY_S)
      this.myInput.y = 0;
    if (e.keyCode === KeyCode.KEY_A || e.keyCode === KeyCode.KEY_D)
      this.myInput.x = 0;
    this.sendInput();
  }
}
