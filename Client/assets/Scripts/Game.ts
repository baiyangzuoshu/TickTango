import { _decorator, Component, Node, Vec3 } from "cc";
const { ccclass, property } = _decorator;

@ccclass("TickMove")
export class TickMove extends Component {
  @property(Node) box: Node | null = null;

  onLoad() {
    const ws = new WebSocket("ws://localhost:8080");
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.type === "tick" && this.box) {
        const p = this.box.position;
        this.box.setPosition(new Vec3(p.x + 5, p.y, p.z)); // 每个tick挪5像素
      }
    };
  }
}
