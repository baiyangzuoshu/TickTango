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
  game,
  Game,
} from "cc";
const { ccclass, property } = _decorator;

type InputVec = { x: number; y: number };
type InputTable = Record<string, InputVec>; // pid(string) -> {x,y}
type StateTable = Record<string, { x: number; y: number }>;

type GameEvent =
  | { kind: "damage"; tick: number; target: string; amount: number; id: string }
  | { kind: "pickup"; tick: number; pid: string; itemId: string; id: string };

type Item = { id: string; x: number; y: number; r: number; alive: boolean };

@ccclass("FrameSyncClient")
export class FrameSyncClient extends Component {
  @property(Node) boxTemplate: Node | null = null;
  @property(Node) itemTemplate: Node | null = null; // 可选：用于显示宝物

  // --- WS & 自身 ---
  private ws!: WebSocket;
  private pid = -1;
  private myInput: InputVec = { x: 0, y: 0 };

  // --- 固定步 & 同步 ---
  private readonly LOGIC_DT = 0.1; // 与服务器 100ms 对齐（可改 0.05）
  private readonly PLAYBACK_DELAY = 1; // 小延迟 + 预测（0~1 推荐）
  private acc = 0;
  private localTick = 0; // 我已播放到的绝对帧
  private serverTickLatest = 0; // 服务器最新绝对帧
  private synced = false;

  // --- 追帧参数（桌面/编辑器预设） ---
  private readonly MAX_CATCHUP_PER_UPDATE = 150; // 每个 update 最多快进多少帧
  private readonly HARD_RESYNC_THRESHOLD = 1200; // 超过则硬重同步（≈2分钟 @10Hz）
  private readonly DYNAMIC_BUDGET = true; // backlog 越大预算越高

  // --- 数据缓存（字典，避免 Map 序列化问题） ---
  private inputsByTick!: { [tick: number]: InputTable }; // 服务器权威输入
  private usedInputsByTick: { [tick: number]: InputTable } = {}; // 我当时用于模拟的输入（预测/权威）
  private predictedTicks = new Set<number>();

  // --- 状态（纯数据） + 场景节点 ---
  private currentState: StateTable = {}; // 正在使用的状态（玩家位置 + hp/score等扩展键）
  private stateByTick: { [tick: number]: StateTable } = {}; // 每帧后的状态快照（回滚/追帧基线）
  private players = new Map<number, Node>(); // pid:number -> Node
  private readonly STEP_PIXELS = 8; // 每帧移动像素

  // --- 事件系统（掉血 & 捡宝物） ---
  private eventsByTick: { [tick: number]: GameEvent[] } = Object.create(null);
  private fxMuteDuringCatchup = true; // 追帧时压缩/静默表现

  // 毒圈（示例）
  private dangerZones = [
    { x: -220, y: 0, r: 60, damage: 5 }, // 每帧 -5 HP（10Hz≈每秒 -50）
  ];

  // 宝物（确定性：固定初始配置）
  private readonly initialItemsSeed: Item[] = [
    { id: "gem1", x: -80, y: 60, r: 28, alive: true },
    { id: "gem2", x: 0, y: 0, r: 28, alive: true },
    { id: "gem3", x: 120, y: -40, r: 28, alive: true },
  ];
  private items: Item[] = []; // 当前帧的宝物状态
  private itemsByTick: { [tick: number]: Item[] } = Object.create(null); // 每帧的宝物状态快照
  private itemNodes = new Map<string, Node>(); // 可选：用于显示宝物

  onLoad() {
    this.inputsByTick = Object.create(null);
    this.items = this.cloneItems(this.initialItemsSeed); // 初始化宝物

    // （可选）创建宝物节点
    if (this.itemTemplate) {
      for (const it of this.items) {
        const n = instantiate(this.itemTemplate);
        n.setParent(this.node);
        n.setPosition(new Vec3(it.x, it.y, 0));
        this.itemNodes.set(it.id, n);
      }
    }

    // 连接服务器
    this.ws = new WebSocket("ws://localhost:8080");
    this.ws.onopen = () => console.log("WS open");
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.type === "hello") {
        this.pid = msg.pid;
        this.ensurePlayer(this.pid); // 创建自己
        if (!this.currentState[String(this.pid)]) {
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
          this.itemsByTick[this.localTick] = this.cloneItems(this.items);
          console.log(
            `Synced: server t=${t}, localTick=${this.localTick}, delay=${this.PLAYBACK_DELAY}`
          );
        }

        // 3) 若该帧曾预测且与权威不同 → 回滚（输入差异才需要回滚）
        if (this.predictedTicks.has(t)) {
          const predicted = this.usedInputsByTick[t] || {};
          if (!this.sameInputTable(predicted, table)) {
            this.rollbackFrom(t);
          } else {
            this.predictedTicks.delete(t);
          }
        }
      }
    };

    // 键盘监听
    input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    input.on(Input.EventType.KEY_UP, this.onKeyUp, this);

    // 前后台监听：恢复时先做防爆保护
    game.on(Game.EVENT_HIDE, this.onPause, this);
    game.on(Game.EVENT_SHOW, this.onResume, this);
  }

  onDestroy() {
    input.off(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    input.off(Input.EventType.KEY_UP, this.onKeyUp, this);
    game.off(Game.EVENT_HIDE, this.onPause, this);
    game.off(Game.EVENT_SHOW, this.onResume, this);
    try {
      this.ws?.close();
    } catch {}
  }

  private onPause() {
    this.acc = 0;
  }
  private onResume() {
    this.acc = 0;
    const backlog =
      this.serverTickLatest - this.PLAYBACK_DELAY - this.localTick;
    if (backlog > this.HARD_RESYNC_THRESHOLD) this.hardResync("resume");
  }

  // ==== 固定步推进 + 追帧 ====
  update(dt: number) {
    if (!this.synced) return;

    this.acc += dt;

    // A) 常规推进（按固定步）
    while (this.acc >= this.LOGIC_DT) {
      this.acc -= this.LOGIC_DT;
      this.stepNext();
    }

    // B) 快进追帧：尽快消化积压，但每帧有预算上限
    let backlog = this.serverTickLatest - this.PLAYBACK_DELAY - this.localTick;

    if (backlog > this.HARD_RESYNC_THRESHOLD) {
      this.hardResync("backlog");
      backlog = this.serverTickLatest - this.PLAYBACK_DELAY - this.localTick;
    }

    let budget = this.MAX_CATCHUP_PER_UPDATE;
    if (this.DYNAMIC_BUDGET) {
      budget = Math.min(300, Math.max(budget, 30 + Math.floor(backlog * 0.25)));
    }

    while (budget > 0 && backlog > 0) {
      this.stepNext();
      budget--;
      backlog--;
    }

    // —— 渲染 + 事件表现（追帧时只播最后一帧 / 压缩）——
    const catchingUp =
      this.serverTickLatest - this.PLAYBACK_DELAY - this.localTick > 0;
    this.renderFromState();
    if (!catchingUp || !this.fxMuteDuringCatchup) {
      this.playFxForTick(this.localTick, /*compressed=*/ catchingUp);
    }

    // 清理老快照，保留最近 2000 帧（回滚/追帧需要）
    const keep = this.localTick - 2000;
    for (const k of Object.keys(this.inputsByTick))
      if (+k < keep) delete this.inputsByTick[+k];
    for (const k of Object.keys(this.usedInputsByTick))
      if (+k < keep) delete this.usedInputsByTick[+k];
    for (const k of Object.keys(this.stateByTick))
      if (+k < keep) delete this.stateByTick[+k];
    for (const k of Object.keys(this.eventsByTick))
      if (+k < keep) delete this.eventsByTick[+k];
    for (const k of Object.keys(this.itemsByTick))
      if (+k < keep) delete this.itemsByTick[+k];
  }

  // 把“取权威/预测并推进”的逻辑抽出来，常规/追帧都复用
  private stepNext() {
    const next = this.localTick + 1;
    let table: InputTable;

    const hasAuth = !!this.inputsByTick[next];
    const serverOK = next + this.PLAYBACK_DELAY <= this.serverTickLatest;

    if (hasAuth && serverOK) {
      table = this.inputsByTick[next];
    } else {
      table = this.predictTableFor(next);
      this.predictedTicks.add(next);
    }

    this.usedInputsByTick[next] = this.cloneInputTable(table);
    this.stepOneTick(next, table);
    this.localTick = next;
  }

  // ==== 预测表 ====
  private predictTableFor(_tick: number): InputTable {
    const table: InputTable = Object.create(null);
    // 默认给所有已见玩家输入 0
    for (const pid of Object.keys(this.currentState)) {
      table[pid] = { x: 0, y: 0 };
    }
    // 自己用当前按键覆盖（local echo）
    if (this.pid >= 0) {
      table[String(this.pid)] = {
        x: this.myInput.x | 0,
        y: this.myInput.y | 0,
      };
    }
    return table;
  }

  // ==== 推进一帧（纯数据 + 事件 + 宝物） ====
  private stepOneTick(tick: number, table: InputTable) {
    const nextState = this.cloneState(this.currentState);
    const step = this.STEP_PIXELS;

    // 确保所有出现过的 pid 都有一个初始位置
    for (const pid of Object.keys(table)) {
      if (!nextState[pid]) {
        const idx = this.players.size; // 简单排队摆放
        nextState[pid] = this.defaultSpawn(idx);
      }
    }

    // A) 位置更新
    for (const [pid, dir] of Object.entries(table)) {
      const p = nextState[pid];
      if (!p) continue;
      p.x += step * (dir.x || 0);
      p.y += step * (dir.y || 0);
    }

    // === 事件列表（本帧产出） ===
    const evs: GameEvent[] = [];

    // B) 毒圈掉血（确定性）
    for (const [pid, pos] of Object.entries(nextState)) {
      if (pid.startsWith("hp:") || pid.startsWith("score:")) continue; // 跳过扩展键
      for (const dz of this.dangerZones) {
        const dx = pos.x - dz.x,
          dy = pos.y - dz.y;
        if (dx * dx + dy * dy <= dz.r * dz.r) {
          const id = `dmg:${tick}:${pid}:${dz.x},${dz.y}`; // 唯一ID
          evs.push({
            kind: "damage",
            tick,
            target: pid,
            amount: dz.damage | 0,
            id,
          });

          const hpKey = `hp:${pid}`;
          const cur = (nextState as any)[hpKey] ?? 100; // 默认 100 HP
          (nextState as any)[hpKey] = Math.max(0, cur - (dz.damage | 0));
          break; // 命中一个圈就够；想叠加多个圈可去掉
        }
      }
    }

    // C) 捡宝物（确定性：同帧重叠 → pid 最小者拾取）
    for (const item of this.items) {
      if (!item.alive) continue;
      const contenders: string[] = [];

      for (const [pid, pos] of Object.entries(nextState)) {
        if (pid.startsWith("hp:") || pid.startsWith("score:")) continue;
        const dx = pos.x - item.x,
          dy = pos.y - item.y;
        if (dx * dx + dy * dy <= item.r * item.r) {
          contenders.push(pid);
        }
      }

      if (contenders.length) {
        contenders.sort((a, b) => Number(a) - Number(b)); // 决定性平手规则
        const winner = contenders[0];

        // 更新宝物状态（被捡走）
        item.alive = false;

        // 产出事件
        const id = `pickup:${tick}:${winner}:${item.id}`;
        evs.push({ kind: "pickup", tick, pid: winner, itemId: item.id, id });

        // 写入分数（示例：+1）
        const scKey = `score:${winner}`;
        (nextState as any)[scKey] = ((nextState as any)[scKey] ?? 0) + 1;
      }
    }

    // 存事件、状态快照、宝物快照（用于回滚/追帧）
    this.eventsByTick[tick] = evs;
    this.currentState = nextState;
    this.stateByTick[tick] = this.cloneState(this.currentState);
    this.itemsByTick[tick] = this.cloneItems(this.items);
  }

  // ==== 回滚（状态 + 宝物一起还原并重算） ====
  private rollbackFrom(tStart: number) {
    const baseTick = tStart - 1;

    const baseState = this.stateByTick[baseTick]
      ? this.cloneState(this.stateByTick[baseTick])
      : this.cloneState(this.initialState());
    this.currentState = baseState;

    // 还原宝物到基线帧
    if (this.itemsByTick[baseTick]) {
      this.items = this.cloneItems(this.itemsByTick[baseTick]);
    } else {
      this.items = this.cloneItems(this.initialItemsSeed);
    }

    // 从 tStart 重算到当前帧
    for (let t = tStart; t <= this.localTick; t++) {
      const authoritative = this.inputsByTick[t];
      const used = authoritative
        ? authoritative
        : this.usedInputsByTick[t] || this.predictTableFor(t);
      this.usedInputsByTick[t] = this.cloneInputTable(used);
      this.stepOneTick(t, used); // 内部会重建 events/state/items 的快照
    }

    this.renderFromState();
    this.predictedTicks.delete(tStart);
    console.log(`ROLLBACK: from ${tStart} → recomputed to ${this.localTick}`);
  }

  // ==== 硬重同步（跳到最新，丢弃早期帧） ====
  private hardResync(reason: string) {
    const target = Math.max(0, this.serverTickLatest - this.PLAYBACK_DELAY + 1);
    this.localTick = target;

    // 选择最近的状态/宝物快照作为基线（没有就用当前/初始）
    let nearest = 0;
    for (const k of Object.keys(this.stateByTick)) {
      const t = +k;
      if (t <= this.localTick && t > nearest) nearest = t;
    }
    if (nearest > 0) {
      this.currentState = this.cloneState(this.stateByTick[nearest]);
      this.items = this.cloneItems(
        this.itemsByTick[nearest] || this.initialItemsSeed
      );
    } else {
      this.items = this.cloneItems(this.initialItemsSeed);
    }

    // 清理过期缓存
    for (const k of Object.keys(this.inputsByTick))
      if (+k < this.localTick) delete this.inputsByTick[+k];
    for (const k of Object.keys(this.usedInputsByTick))
      if (+k < this.localTick) delete this.usedInputsByTick[+k];
    for (const k of Object.keys(this.stateByTick))
      if (+k < this.localTick) delete this.stateByTick[+k];
    for (const k of Object.keys(this.eventsByTick))
      if (+k < this.localTick) delete this.eventsByTick[+k];
    for (const k of Object.keys(this.itemsByTick))
      if (+k < this.localTick) delete this.itemsByTick[+k];

    this.predictedTicks.clear();
    this.acc = 0;
    console.warn(`HARD RESYNC -> localTick=${this.localTick} (${reason})`);
  }

  // ==== 渲染 ====
  private renderFromState() {
    // 玩家
    for (const [pidStr, pos] of Object.entries(this.currentState)) {
      if (pidStr.startsWith("hp:") || pidStr.startsWith("score:")) continue; // 不把扩展键当节点
      const pid = Number(pidStr);
      this.ensurePlayer(pid);
      const n = this.players.get(pid)!;
      n.setPosition(new Vec3(pos.x, pos.y, 0));
    }

    // 宝物（可选模板存在则显示/隐藏）
    if (this.itemTemplate) {
      for (const it of this.items) {
        let n = this.itemNodes.get(it.id);
        if (!n) {
          n = instantiate(this.itemTemplate);
          n.setParent(this.node);
          this.itemNodes.set(it.id, n);
        }
        n.setPosition(new Vec3(it.x, it.y, 0));
        n.active = it.alive;
      }
    }
  }

  // 事件表现（这里先用 log；真正项目里替换成飘字/特效即可）
  private playFxForTick(tick: number, compressed: boolean) {
    const evs = this.eventsByTick[tick] || [];
    if (compressed) {
      // 压缩：只保留每个目标“最后一次 damage”，以及每个 item 的“最后一次 pickup”
      const lastDmgByTarget = new Map<string, GameEvent>();
      const lastPickupByItem = new Map<string, GameEvent>();
      for (const e of evs) {
        if (e.kind === "damage") lastDmgByTarget.set(e.target, e);
        else if (e.kind === "pickup") lastPickupByItem.set(e.itemId, e);
      }
      for (const e of lastDmgByTarget.values()) {
        const hp = (this.currentState[`hp:${e.target}`] as any) ?? 100;
        console.log(`[FX] dmg x${e.amount} to ${e.target} @${tick} → HP=${hp}`);
      }
      for (const e of lastPickupByItem.values()) {
        const sc = (this.currentState[`score:${e.pid}`] as any) ?? 0;
        console.log(
          `[FX] pickup ${e.itemId} by ${e.pid} @${tick} → SCORE=${sc}`
        );
      }
    } else {
      for (const e of evs)
        if (e.kind === "damage") {
          const hp = (this.currentState[`hp:${e.target}`] as any) ?? 100;
          console.log(
            `[FX] dmg ${e.amount} to ${e.target} @${tick} → HP=${hp}`
          );
        } else if (e.kind === "pickup") {
          const sc = (this.currentState[`score:${e.pid}`] as any) ?? 0;
          console.log(
            `[FX] pickup ${e.itemId} by ${e.pid} @${tick} → SCORE=${sc}`
          );
        }
    }
  }

  // ==== 工具 ====
  private ensurePlayer(pid: number) {
    if (!this.boxTemplate) return;
    if (this.players.has(pid)) return;

    const n = instantiate(this.boxTemplate);
    n.setParent(this.node);
    const idx = this.players.size;
    const spawn = this.defaultSpawn(idx);
    n.setPosition(new Vec3(spawn.x, spawn.y, 0));
    this.players.set(pid, n);

    if (!this.currentState[String(pid)]) {
      this.currentState[String(pid)] = { x: spawn.x, y: spawn.y };
    }
  }

  private defaultSpawn(i: number): { x: number; y: number } {
    return { x: -220 + (i % 8) * 60, y: Math.floor(i / 8) * 60 };
  }

  private cloneState(s: StateTable): StateTable {
    return JSON.parse(JSON.stringify(s));
  }
  private cloneInputTable(t: InputTable): InputTable {
    return JSON.parse(JSON.stringify(t || {}));
  }
  private cloneItems(items: Item[]): Item[] {
    return JSON.parse(JSON.stringify(items || []));
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
