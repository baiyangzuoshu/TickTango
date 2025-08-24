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
type InputTable = Record<string, { x: number; y: number }>;

@ccclass("FixedStepPlayback")
export class FixedStepPlayback extends Component {
  @property(Node) boxTemplate: Node | null = null;

  private ws!: WebSocket;
  private pid = -1;
  private myInput = { x: 0, y: 0 };

  // --- 固定逻辑步 & 轻缓冲 ---
  private readonly LOGIC_DT = 0.1; // 100ms/步（和服务器 TICK_MS 对齐）
  private acc = 0;
  private localTick = 0; // 我已经播放到的逻辑帧
  private serverTickLatest = 0; // 服务器最新帧
  private readonly PLAYBACK_DELAY = 2; // 延后2帧播放（避免抖动）

  private inputsByTick!: { [tick: number]: InputTable }; // 字典而非 Map
  // --- 场景对象 ---
  private players = new Map<number, Node>(); // pid -> Node
  private readonly STEP_PIXELS = 8; // 每步移动像素
  private synced = false; // 是否已对齐过首帧

  onLoad() {
    // 连接 WS
    this.inputsByTick = Object.create(null); // 干净字典

    this.ws = new WebSocket("ws://localhost:8080");
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.type === "hello") {
        this.pid = msg.pid;
        this.ensurePlayer(this.pid);
      } else if (msg.type === "tick") {
        const t = Number(msg.tick);
        this.serverTickLatest = t;
        this.inputsByTick[t] = (msg.inputs as InputTable) || {};

        if (!this.synced) {
          this.localTick = t - this.PLAYBACK_DELAY + 1; // 例如 delay=2，server=75 → local=73
          if (this.localTick < 0) this.localTick = 0;
          this.synced = true;
          this.acc = 0; // 可选：清累积，防止一下子连播太多
          console.log("Synced at server tick", t, "localTick=", this.localTick);
        }
      }
    };

    // 键盘输入（只发输入，不发状态）
    input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    input.on(Input.EventType.KEY_UP, this.onKeyUp, this);
  }

  update(dt: number) {
    if (!this.synced) return; // 还没拿到首帧就先不播
    this.acc += dt;
    while (this.acc >= this.LOGIC_DT) {
      this.acc -= this.LOGIC_DT;

      const next = this.localTick + 1; // 绝对下一帧
      const ready =
        next + this.PLAYBACK_DELAY <= this.serverTickLatest &&
        this.inputsByTick[next];
      if (!ready) {
        console.log(
          "Not ready",
          next,
          this.serverTickLatest,
          this.inputsByTick
        );
        break;
      }

      this.localTick = next;
      this.playOneTick(this.localTick);
      delete this.inputsByTick[this.localTick]; // 播完即删
    }
  }

  private playOneTick(tick: number) {
    const t = Number(tick);
    const table = this.inputsByTick[t] || {}; // 不会再因 .get() 报错
    console.log("playOneTick", tick, table, this.inputsByTick);
    for (const [pidStr, dir] of Object.entries(table)) {
      const pid = Number(pidStr);
      this.ensurePlayer(pid);
      const n = this.players.get(pid)!;
      const p = n.position;
      n.setPosition(
        new Vec3(
          p.x + this.STEP_PIXELS * (dir.x || 0),
          p.y + this.STEP_PIXELS * (dir.y || 0),
          p.z
        )
      );
    }
  }

  private ensurePlayer(pid: number) {
    if (this.players.has(pid) || !this.boxTemplate) return;
    const n = instantiate(this.boxTemplate);
    n.setParent(this.node);
    n.active = true;
    const i = this.players.size;
    n.setPosition(new Vec3(-200 + i * 60, 0, 0));
    this.players.set(pid, n);
    if (this.pid === pid) {
      n.getComponent(Label).string = "我" + pid;
    } else {
      n.getComponent(Label).string = pid.toString();
    }
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
