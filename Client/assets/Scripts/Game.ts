import {
  _decorator,
  Component,
  input,
  Input,
  EventKeyboard,
  KeyCode,
} from "cc";
const { ccclass } = _decorator;

@ccclass("FrameSync")
export class FrameSync extends Component {
  private ws!: WebSocket;
  private pid: number = -1;

  private LOGIC_DT = 0.05; // 50ms 固定逻辑步
  private acc = 0; // 累积器
  private localTick = 0; // 本地逻辑帧号（追随服务器）
  private pendingInputs: Map<number, any[]> = new Map(); // tick -> inputs[]
  private myInputThisFrame: any = { x: 0, y: 0 };

  onLoad() {
    this.connect();
    input.on(Input.EventType.KEY_DOWN, this.onKey, this);
    input.on(Input.EventType.KEY_UP, this.onKeyUp, this);
  }

  private connect() {
    this.ws = new WebSocket("ws://localhost:8080");
    this.ws.onopen = () => console.log("ws open");
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      //console.log("ws message", msg);
      if (msg.type === "hello") {
        this.pid = msg.pid;
      } else if (msg.type === "tick") {
        // 收到服务器帧：把该帧输入缓存，等本地推进到同一帧时回放
        this.pendingInputs.set(msg.tick, msg.inputs || []);
      }
    };
  }

  update(dt: number) {
    this.acc += dt;
    while (this.acc >= this.LOGIC_DT) {
      this.acc -= this.LOGIC_DT;
      this.stepLogic();
    }
  }

  private stepLogic() {
    this.localTick++;

    // 1) 把本帧自己的输入发给服务器（只发输入，不发位置）
    const data = JSON.stringify({
      type: "input",
      clientTick: this.localTick,
      input: { pid: this.pid, ...this.myInputThisFrame },
    });
    this.ws?.readyState === this.ws?.OPEN && this.ws.send(data);
    //console.log("send input", data);

    // 2) 回放“服务器同帧输入”
    const serverInputs = this.pendingInputs.get(this.localTick) || [];
    // 注意：包括自己与他人的输入。你应基于这些输入推进你的“确定性”逻辑。
    // 这里先示意：根据输入修改共享状态（你可以维护 players: Map<pid, {x,y}>）
    for (const e of serverInputs) {
      // applyInput(e.pid, e.input); // TODO: 你的小练习：实现它
      if (e.pid === this.pid) {
        // 自己的输入，不处理
      } else {
        // 他人的输入，更新他人位置
      }
      console.log("pid=", e.pid, e.input);
    }
    this.pendingInputs.delete(this.localTick);
  }

  private onKey(e: EventKeyboard) {
    console.log("onKey", e.keyCode);
    if (e.keyCode === KeyCode.KEY_W) this.myInputThisFrame.y = 1;
    else if (e.keyCode === KeyCode.KEY_S) this.myInputThisFrame.y = -1;
    else if (e.keyCode === KeyCode.KEY_A) this.myInputThisFrame.x = -1;
    else if (e.keyCode === KeyCode.KEY_D) this.myInputThisFrame.x = 1;
  }

  private onKeyUp(e: EventKeyboard) {
    if ([KeyCode.KEY_W, KeyCode.KEY_S].includes(e.keyCode))
      this.myInputThisFrame.y = 0;
    if ([KeyCode.KEY_A, KeyCode.KEY_D].includes(e.keyCode))
      this.myInputThisFrame.x = 0;
  }
}
