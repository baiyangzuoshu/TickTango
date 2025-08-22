// Lockstep.ts

import { _decorator, Component, director } from "cc";
import { Cmd, Net } from "./Net/NetManager";

type RNG = () => number;
function mulberry32(seed: number): RNG {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const { ccclass, property } = _decorator;

@ccclass("Game")
export class Game extends Component {
  net = new Net();
  roomId = "r1";
  playerId = 0;
  tickRate = 20;
  inputDelay = 3;
  curTick = 0;
  frameQueue: Map<number, { pid: number; cmd: Cmd }[]> = new Map();
  acc = 0;
  TICK_MS = 50;

  rng: RNG;
  // ==== 连连看状态（示例：仅演示，真实请接你现有 BlockManager/BFS）====
  board: number[][] = [];
  selected: Record<number, { x: number; y: number } | null> = {}; // pid -> pos
  score: Record<number, number> = {};

  init() {
    this.net.onStart = ({ roomId, playerId, tickRate, inputDelay, seed }) => {
      this.roomId = roomId;
      this.playerId = playerId;
      this.tickRate = tickRate;
      this.inputDelay = inputDelay;
      this.TICK_MS = Math.round(1000 / tickRate);
      this.rng = mulberry32(seed);
      this.makeBoard(seed); // 用 seed 生成同一张图
      this.startLoop();
    };
    this.net.onFrame = ({ tick, cmds }) => {
      this.frameQueue.set(tick, cmds);
    };
    this.net.connect();
  }

  // 生成可玩棋盘（这里演示随机；你可以直接调用你的 BlockManager.generatePlayableGrid）
  makeBoard(seed: number) {
    const w = 10,
      h = 8,
      types = 12;
    this.board = Array.from({ length: h }, () =>
      Array.from({ length: w }, () => 1 + Math.floor(this.rng() * types))
    );
    this.score = {};
    this.selected = {};
  }

  startLoop() {
    director.getScheduler().scheduleUpdate(
      {
        update: (dt: number) => {
          this.acc += dt * 1000;
          while (this.acc >= this.TICK_MS) {
            this.step();
            this.acc -= this.TICK_MS;
          }
        },
      },
      0,
      false
    );
  }

  step() {
    const nextTick = this.curTick + 1;
    const frame = this.frameQueue.get(nextTick);
    if (!frame) return; // 还没收到该帧
    // 按稳定顺序执行（pid 从小到大）
    frame
      .sort((a, b) => a.pid - b.pid)
      .forEach(({ pid, cmd }) => this.applyCmd(pid, cmd));
    this.curTick = nextTick;
    this.frameQueue.delete(nextTick);
  }

  // === 本地发输入：把当前操作派给未来帧（curTick + inputDelay + 1）===
  sendSelect(x: number, y: number) {
    const targetTick = this.curTick + this.inputDelay + 1;
    this.net.sendInput(this.roomId, targetTick, { kind: "select", x, y });
  }

  // === 执行帧命令（简化版）===
  applyCmd(pid: number, cmd: Cmd) {
    if (cmd.kind === "noop") return;
    const { x, y } = cmd;
    if (!this.selected[pid]) {
      this.selected[pid] = { x, y };
      return;
    }
    const a = this.selected[pid];
    const b = { x, y };
    if (this.canMatch(a, b)) {
      this.removePair(a, b);
      this.score[pid] = (this.score[pid] || 0) + 1;
      this.selected[pid] = null;
    } else {
      this.selected[pid] = { x, y }; // 重新选择
    }
  }

  // === 连连看规则（演示）===
  sameType(a: { x: number; y: number }, b: { x: number; y: number }) {
    return (
      this.board[a.y][a.x] > 0 && this.board[a.y][a.x] === this.board[b.y][b.x]
    );
  }
  // 真实工程里请换成你已有的 BFS 判断（<=2 次转折、带边界）
  canMatch(a: { x: number; y: number }, b: { x: number; y: number }) {
    if (!this.sameType(a, b)) return false;
    // TODO: 调用你已有的 canConnectPath(board, a, b)
    // 这里先返回 true 以便跑通流程
    return true;
  }
  removePair(a: { x: number; y: number }, b: { x: number; y: number }) {
    this.board[a.y][a.x] = 0;
    this.board[b.y][b.x] = 0;
  }
}
