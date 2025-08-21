export type Tick = number;

// 离散输入：-1(左) / 0(停) / 1(右)
export interface InputPayload {
  ax: number;
}

export interface TickInputs {
  tick: Tick;
  inputs: Record<number, InputPayload>; // playerId -> input
}

export interface PlayerState {
  id: number;
  // 用“定点整数”避免漂移：位置以 1000 倍保存
  x1000: number;
  vx1000: number;
}
