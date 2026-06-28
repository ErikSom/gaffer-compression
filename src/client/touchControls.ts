// A single spawn-anywhere virtual joystick. On the first touch it drops a
// joystick base under your finger; dragging from there yields a move vector
// (screen up = forward = -z). Releasing recenters and stops. Multi-touch beyond
// the first finger is ignored (single stick). Dormant on non-touch devices.
export class TouchControls {
	public active = false;
	private move = { x: 0, z: 0 };

	private touchId: number | null = null;
	private baseX = 0;
	private baseY = 0;
	private readonly radius = 55; // px of max knob travel

	private baseEl: HTMLDivElement;
	private knobEl: HTMLDivElement;

	constructor() {
		this.baseEl = document.createElement("div");
		this.baseEl.id = "joystick-base";
		this.knobEl = document.createElement("div");
		this.knobEl.id = "joystick-knob";
		this.baseEl.appendChild(this.knobEl);
		document.body.appendChild(this.baseEl);

		window.addEventListener("touchstart", this.onStart, { passive: false });
		window.addEventListener("touchmove", this.onMove, { passive: false });
		window.addEventListener("touchend", this.onEnd);
		window.addEventListener("touchcancel", this.onEnd);
	}

	getMove() { return this.move; }

	private onStart = (e: TouchEvent) => {
		if (this.touchId !== null) return; // already tracking a finger
		const t = e.changedTouches[0];
		this.touchId = t.identifier;
		this.baseX = t.clientX;
		this.baseY = t.clientY;
		this.baseEl.style.left = `${this.baseX}px`;
		this.baseEl.style.top = `${this.baseY}px`;
		this.setKnob(0, 0);
		this.baseEl.classList.add("active");
		this.active = true;
		e.preventDefault();
	};

	private onMove = (e: TouchEvent) => {
		if (this.touchId === null) return;
		const t = this.find(e.touches);
		if (!t) return;
		const dx = t.clientX - this.baseX;
		const dy = t.clientY - this.baseY;
		const len = Math.hypot(dx, dy);
		const clamped = Math.min(len, this.radius);
		const ux = len > 0 ? dx / len : 0;
		const uy = len > 0 ? dy / len : 0;
		const kx = ux * clamped;
		const ky = uy * clamped;
		this.setKnob(kx, ky);
		this.move.x = kx / this.radius;
		this.move.z = ky / this.radius; // screen down = +z (backward), up = -z (forward)
		e.preventDefault();
	};

	private onEnd = (e: TouchEvent) => {
		if (this.touchId === null) return;
		if (!this.find(e.changedTouches)) return; // our finger didn't lift
		this.touchId = null;
		this.active = false;
		this.move.x = 0;
		this.move.z = 0;
		this.baseEl.classList.remove("active");
	};

	private setKnob(kx: number, ky: number) {
		this.knobEl.style.transform = `translate(calc(-50% + ${kx}px), calc(-50% + ${ky}px))`;
	}

	private find(list: TouchList): Touch | null {
		for (let i = 0; i < list.length; i++) if (list[i].identifier === this.touchId) return list[i];
		return null;
	}
}
