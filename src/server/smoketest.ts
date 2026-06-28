import WebSocket from "ws";
import { decodePacket, decodeWelcome, encodeAck, MsgType, peekType } from "../shared/protocol.js";

async function run() {
	const ws = new WebSocket("ws://localhost:8787");
	ws.binaryType = "arraybuffer";

	let fullsSeen = 0;
	let deltasSeen = 0;
	let bytesDown = 0;
	let lastFrame = -1;
	const deadline = Date.now() + 5000;

	ws.on("open", () => { console.log("connected"); });
	ws.on("message", (data) => {
		const buf = data instanceof ArrayBuffer ? data : (data as Buffer).buffer.slice((data as Buffer).byteOffset, (data as Buffer).byteOffset + (data as Buffer).byteLength);
		bytesDown += buf.byteLength;

		const t = peekType(buf as ArrayBuffer);
		if (t === MsgType.Welcome) {
			const w = decodeWelcome(buf as ArrayBuffer);
			console.log("welcome", w);
			return;
		}

		const msg = decodePacket(buf as ArrayBuffer);
		if (!msg) return;

		if (msg.type === MsgType.FullSnapshot) {
			fullsSeen++;
			console.log(`[full] frame=${msg.frame} bytes=${buf.byteLength} objs=${msg.state.length} sample0=(${msg.state[0].position.x.toFixed(2)},${msg.state[0].position.y.toFixed(2)},${msg.state[0].position.z.toFixed(2)})`);
		} else if (msg.type === MsgType.DeltaSnapshot) {
			deltasSeen++;
			if (deltasSeen < 4 || deltasSeen % 10 === 0) console.log(`[delta] frame=${msg.frame} base=${msg.baseFrame} bytes=${buf.byteLength}`);
		}
		if (msg.type === MsgType.FullSnapshot || msg.type === MsgType.DeltaSnapshot) {
			lastFrame = msg.frame;
			ws.send(encodeAck(msg.frame));
		}
	});
	ws.on("error", (e) => { console.error("ws error", e.message); process.exit(1); });

	while (Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
	console.log(`\n=== summary ===\nfulls: ${fullsSeen}\ndeltas: ${deltasSeen}\ntotal down: ${(bytesDown / 1024).toFixed(1)} KB over ~5s\navg kbps: ${((bytesDown * 8) / 1024 / 5).toFixed(1)}\nlastFrame: ${lastFrame}`);
	ws.close();
	process.exit(0);
}
run();
