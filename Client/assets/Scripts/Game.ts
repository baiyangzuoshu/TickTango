import { _decorator, Component, Node, Color, UITransform, Vec3, Label, director, input, Input, EventKeyboard, KeyCode } from "cc";
import { InputPayload, PlayerState, Tick } from "./Types";
import { Net } from "./Net/NetManager";

const { ccclass, property } = _decorator;

// ----------------- 可调参数 -----------------
const STEP = 1 / 30;                   // 固定步（与服务器 TPS 一致）
const SPEED_1000 = 240 * 1000;         // 像素/秒 * 放大 1000
const WORLD_MIN_X = 50, WORLD_MAX_X = 1230;
// 渲染缩放：定点 -> 实像素
const FX = (x1000: number) => Math.round(x1000 / 1000);

// -------------------------------------------

@ccclass("Game")
export class Game extends Component {
  private net = new Net("ws://localhost:8080");

  private acc = 0;                // 累加器
  private simTick: Tick = 0;      // 已经模拟到的 tick
  private latestServerTick = 0;

  private playerId = 0;

  private nodes = new Map<number, Node>();    // playerId -> Node
  private states = new Map<number, PlayerState>(); // playerId -> 状态
  private tickBuffer = new Map<Tick, Record<number, InputPayload>>(); // 收到但未消费的输入包

  private currentAx = 0;          // 本地玩家当前输入（-1/0/1）

  private hud?: Node;
  private infoLabel?: Label;

  async onLoad() {
    // 简单 UI
    this.hud = this.node.getChildByName("HUD");
    this.infoLabel = this.hud.getComponent(Label);
    this.infoLabel.string = "Connecting...";
    console.log("Game onLoad");
    // 键盘输入
    input.on(Input.EventType.KEY_DOWN, this.onKey, this);
    input.on(Input.EventType.KEY_UP, this.onKey, this);

    // 连接服务器
    await this.net.connect();
    this.net.onWelcome(({ playerId, tick, inputLead, simDelay }) => {
      this.playerId = playerId;
      this.simTick = 0;
      this.latestServerTick = tick;
      if (this.infoLabel) this.infoLabel.string = `player=${playerId} tick=${tick} lead=${inputLead} delay=${simDelay}`;
      // 本地创建自己的实体
      this.ensurePlayerNode(playerId, true);
    });

    // 收 tick 包：缓存 + 尝试发送下一 tick 的输入
    this.net.onTick((t, bundle) => {
      this.latestServerTick = t;
      this.tickBuffer.set(t, bundle);
      // 针对 (t + inputLead) 发送一次我们的输入
      this.net.sendInputForUpcomingTick(t + this.net.inputLead, { ax: this.currentAx });
    });
  }

  private onKey(e: EventKeyboard) {
    if (e.keyCode === KeyCode.ARROW_LEFT || e.keyCode === KeyCode.KEY_A) {
      if (e.type === Input.EventType.KEY_DOWN) this.currentAx = -1;
      else this.currentAx = 0;
    }
    if (e.keyCode === KeyCode.ARROW_RIGHT || e.keyCode === KeyCode.KEY_D) {
      if (e.type === Input.EventType.KEY_DOWN) this.currentAx = 1;
      else this.currentAx = 0;
    }
  }

  update(dt: number) {
    this.acc += dt;

    // 只有在“落后服务器 SIM_DELAY tick”且有输入包可用时才推进
    while (this.acc >= STEP) {
      const targetTick = this.simTick + 1;

      // 确保我们不会追上服务器（保持 simDelay）
      const safeServerTick = this.latestServerTick - this.net.simDelay;
      if (targetTick > safeServerTick) break;

      const inputs = this.tickBuffer.get(targetTick);
      if (!inputs) break; // 等输入包

      this.stepOnce(targetTick, inputs);
      this.tickBuffer.delete(targetTick);
      this.simTick = targetTick;
      this.acc -= STEP;
    }

    // HUD
    if (this.infoLabel) {
      this.infoLabel.string = `You=${this.playerId}  sim=${this.simTick}  srv=${this.latestServerTick}  buf=${this.tickBuffer.size}  ax=${this.currentAx}`;
    }

    // 渲染
    for (const st of this.states.values()) {
      const n = this.nodes.get(st.id)!;
      n.setPosition(new Vec3(FX(st.x1000), n.position.y, 0));
    }
  }

  private stepOnce(tick: Tick, inputs: Record<number, InputPayload>) {
    // 新玩家（在此 tick 第一次出现）也会被创建
    for (const pidStr of Object.keys(inputs)) {
      const pid = Number(pidStr);
      this.ensurePlayerNode(pid, pid === this.playerId);
    }

    // 模拟：简单 1D 运动（整数/定点，固定步）
    for (const [pid, st] of this.states.entries()) {
      const input = inputs[pid] ?? { ax: 0 };
      const ax = Math.max(-1, Math.min(1, input.ax | 0));

      // v = a * step * SPEED
      st.vx1000 = ax * (SPEED_1000 * STEP);
      st.x1000 += st.vx1000;

      // 边界
      const x = FX(st.x1000);
      if (x < WORLD_MIN_X) st.x1000 = WORLD_MIN_X * 1000;
      if (x > WORLD_MAX_X) st.x1000 = WORLD_MAX_X * 1000;
    }
  }

  private ensurePlayerNode(playerId: number, mine: boolean) {
    if (this.states.has(playerId)) return;
    const st: PlayerState = { id: playerId, x1000: mine ? 300000 : 900000, vx1000: 0 };
    this.states.set(playerId, st);

    const n = new Node(`P${playerId}`);
    const tf = n.addComponent(UITransform);
    tf.setContentSize(50, 50);
    n.setPosition(new Vec3(mine ? 300 : 900, 200, 0));

    // 用 Label 显示 id
    const labelNode = new Node("id");
    const lbl = labelNode.addComponent(Label);
    lbl.string = `${playerId}`;
    labelNode.setPosition(new Vec3(0, 40, 0));
    n.addChild(labelNode);

    // 用纯色块可视化（无需贴图）
    const gfx = n.addComponent(Label); // 取巧：只为显示字符块
    gfx.string = mine ? "■" : "□";
    gfx.color = mine ? new Color(0, 255, 0) : new Color(255, 215, 0);

    this.node.addChild(n);
    this.nodes.set(playerId, n);
  }
}
