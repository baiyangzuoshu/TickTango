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

type InputVec = { x: number; y: number };
type InputTable = Record<string, InputVec>; // pid(string) -> {x,y}
type StateTable = Record<string, { x: number; y: number }>;

@ccclass("FrameSyncClient")
export class FrameSyncClient extends Component {
  @property(Node) boxTemplate: Node | null = null;

  // --- WS & 自身 ---
  private ws!: WebSocket;
  private pid = -1;
  private myInput: InputVec = { x: 0, y: 0 };

  // --- 固定步 & 同步 ---
  private readonly LOGIC_DT = 0.1; // 与服务器 100ms 对齐
  private readonly PLAYBACK_DELAY = 1; // 小延迟 + 预测
  private acc = 0;
  private localTick = 0; // 我已播放到的绝对帧
  private serverTickLatest = 0; // 服务器最新绝对帧
  private synced = false;

  // --- 数据缓存（用字典，避免 Map 序列化问题） ---
  private inputsByTick!: { [tick: number]: InputTable }; // 权威输入（服务器来的）
  private usedInputsByTick: { [tick: number]: InputTable } = {}; // 我当时用于模拟的输入（可能是预测）
  private predictedTicks = new Set<number>();

  // --- 状态（纯数据） + 场景节点 ---
  private currentState: StateTable = {}; // 正在使用的状态
  private stateByTick: { [tick: number]: StateTable } = {}; // 每帧后的状态快照（回滚用）
  private players = new Map<number, Node>(); // pid:number -> Node
  private readonly STEP_PIXELS = 8; // 每帧移动像素

  onLoad() {
    this.inputsByTick = Object.create(null);

    // 连接服务器
    this.ws = new WebSocket("ws://localhost:8080");
    this.ws.onopen = () => console.log("WS open");
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.type === "hello") {
        this.pid = msg.pid;
        this.ensurePlayer(this.pid); // 创建自己
        if (!this.currentState[String(this.pid)]) {
          // 给自己一个初始位置
          this.currentState[String(this.pid)] = this.defaultSpawn(
            this.players.size - 1
          );
        }
      } else if (msg.type === "tick") {
        const t = Number(msg.tick);
        this.serverTickLatest = t;
        const table: InputTable = msg.inputs || {};

        // 1) 存权威输入
        this.inputsByTick[t] = table;

        // 2) 首包对齐：localTick = t - delay + 1（避免 off-by-one）
        if (!this.synced) {
          this.localTick = t - this.PLAYBACK_DELAY + 1;
          if (this.localTick < 0) this.localTick = 0;
          this.synced = true;
          this.acc = 0;
          this.stateByTick[this.localTick] = this.cloneState(this.currentState);
          console.log(
            `Synced: server t=${t}, localTick=${this.localTick}, delay=${this.PLAYBACK_DELAY}`
          );
        }

        // 3) 若该帧是预测过的，且预测与权威不同 → 回滚
        if (this.predictedTicks.has(t)) {
          const predicted = this.usedInputsByTick[t] || {};
          if (!this.sameInputTable(predicted, table)) {
            this.rollbackFrom(t);
          } else {
            this.predictedTicks.delete(t); // 预测命中，可清理标记
          }
        }
      }
    };

    // 键盘监听
    input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    input.on(Input.EventType.KEY_UP, this.onKeyUp, this);
  }

  onDestroy() {
    input.off(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    input.off(Input.EventType.KEY_UP, this.onKeyUp, this);
    try {
      this.ws?.close();
    } catch {}
  }

  // ==== 固定步推进 ====
  update(dt: number) {
    if (!this.synced) return;

    this.acc += dt;
    while (this.acc >= this.LOGIC_DT) {
      this.acc -= this.LOGIC_DT;

      const next = this.localTick + 1;

      // 优先用权威（且服务器已领先到足够帧）
      let table: InputTable | null = null;
      const hasAuthoritative = !!this.inputsByTick[next];
      const serverAhead = next + this.PLAYBACK_DELAY <= this.serverTickLatest;

      if (hasAuthoritative && serverAhead) {
        table = this.inputsByTick[next];
      } else {
        // 轻预测：别人用上一次输入；自己用当前按键
        table = this.predictTableFor(next);
        this.predictedTicks.add(next);
      }

      // 记录我“实际使用”的输入表，并推进一帧
      this.usedInputsByTick[next] = this.cloneInputTable(table);
      this.stepOneTick(next, table);

      this.localTick = next;
    }

    // 渲染：把 currentState 映射到节点
    this.renderFromState();

    // 可选：简单清理较早缓存，避免长期增长
    const pruneBefore = this.localTick - 60; // 保留最近 60 帧
    for (const k of Object.keys(this.inputsByTick))
      if (+k < pruneBefore) delete this.inputsByTick[+k];
    for (const k of Object.keys(this.usedInputsByTick))
      if (+k < pruneBefore) delete this.usedInputsByTick[+k];
    for (const k of Object.keys(this.stateByTick))
      if (+k < pruneBefore) delete this.stateByTick[+k];
  }

  // ==== 预测表 ====
  private predictTableFor(_tick: number): InputTable {
    const table: InputTable = Object.create(null);

    // 已知玩家沿用上一次（= 最近权威帧）的输入；如果未知，默认 0
    for (const pid of Object.keys(this.currentState)) {
      table[pid] = { x: 0, y: 0 };
    }
    // 自己用“当前按键”覆盖，保证本地即时手感
    if (this.pid >= 0) {
      table[String(this.pid)] = {
        x: this.myInput.x | 0,
        y: this.myInput.y | 0,
      };
    }
    return table;
  }

  // ==== 推进一帧（纯数据） ====
  private stepOneTick(tick: number, table: InputTable) {
    const nextState = this.cloneState(this.currentState);
    const step = this.STEP_PIXELS;

    // 确保所有出现过的 pid 都有一个初始位置
    for (const pid of Object.keys(table)) {
      if (!nextState[pid]) {
        const idx = this.players.size; // 放到一个新位置
        nextState[pid] = this.defaultSpawn(idx);
      }
    }

    for (const [pid, dir] of Object.entries(table)) {
      const p = nextState[pid];
      if (!p) continue;
      p.x += step * (dir.x || 0);
      p.y += step * (dir.y || 0);
    }

    this.currentState = nextState;
    this.stateByTick[tick] = this.cloneState(this.currentState);
  }

  // ==== 回滚 ====
  private rollbackFrom(tStart: number) {
    const baseTick = tStart - 1;
    const baseState = this.stateByTick[baseTick]
      ? this.cloneState(this.stateByTick[baseTick])
      : this.cloneState(this.initialState());

    this.currentState = baseState;

    // 用“权威输入”替换这一帧，并从 tStart 重算到 localTick
    for (let t = tStart; t <= this.localTick; t++) {
      const authoritative = this.inputsByTick[t];
      const used = authoritative
        ? authoritative
        : this.usedInputsByTick[t] || this.predictTableFor(t);
      this.usedInputsByTick[t] = this.cloneInputTable(used);
      this.stepOneTick(t, used);
    }

    this.renderFromState();
    this.predictedTicks.delete(tStart);
    console.log(`ROLLBACK: from ${tStart} → recomputed to ${this.localTick}`);
  }

  // ==== 渲染 ====
  private renderFromState() {
    for (const [pidStr, pos] of Object.entries(this.currentState)) {
      const pid = Number(pidStr);
      this.ensurePlayer(pid);
      const n = this.players.get(pid)!;
      n.setPosition(new Vec3(pos.x, pos.y, 0));
    }
  }

  // ==== 工具 ====
  private ensurePlayer(pid: number) {
    if (!this.boxTemplate) return;
    if (this.players.has(pid)) return;

    const n = instantiate(this.boxTemplate);
    n.setParent(this.node);
    n.active = true;
    const idx = this.players.size;
    const spawn = this.defaultSpawn(idx);
    n.setPosition(new Vec3(spawn.x, spawn.y, 0));
    this.players.set(pid, n);
    if (pid === this.pid) {
      n.getComponent(Label).string = `我` + pid;
    } else {
      n.getComponent(Label).string = `玩家` + pid;
    }

    // 若状态里还没有这个玩家，补一份
    if (!this.currentState[String(pid)]) {
      this.currentState[String(pid)] = { x: spawn.x, y: spawn.y };
    }
  }

  private defaultSpawn(i: number): { x: number; y: number } {
    return { x: -220 + i * 60, y: 0 };
    // 你也可以做个网格散点：return { x: -220 + (i%8)*60, y: Math.floor(i/8)*60 };
  }

  private cloneState(s: StateTable): StateTable {
    return JSON.parse(JSON.stringify(s));
  }
  private cloneInputTable(t: InputTable): InputTable {
    return JSON.parse(JSON.stringify(t || {}));
  }
  private initialState(): StateTable {
    return {};
  }

  private sameInputTable(a: InputTable, b: InputTable): boolean {
    const ka = Object.keys(a),
      kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      const va = a[k] || { x: 0, y: 0 },
        vb = b[k] || { x: 0, y: 0 };
      if ((va.x | 0) !== (vb.x | 0) || (va.y | 0) !== (vb.y | 0)) return false;
    }
    return true;
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
