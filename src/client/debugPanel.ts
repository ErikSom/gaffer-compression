import { BANDWIDTH_STEPS, NetSimParams } from "./netSimulator.js";

export interface DebugPanelParams {
	latencyMs: number;
	jitterMs: number;
	lossPct: number;
	bandwidthStep: number;
}

const PRESETS: Record<string, DebugPanelParams> = {
	lan: { latencyMs: 0, jitterMs: 0, lossPct: 0, bandwidthStep: BANDWIDTH_STEPS.length - 1 },
	broadband: { latencyMs: 30, jitterMs: 5, lossPct: 0, bandwidthStep: 8 },
	"3g": { latencyMs: 150, jitterMs: 40, lossPct: 2, bandwidthStep: 4 },
	sat: { latencyMs: 600, jitterMs: 60, lossPct: 1, bandwidthStep: 5 },
	cursed: { latencyMs: 250, jitterMs: 100, lossPct: 10, bandwidthStep: 2 },
};

export class DebugPanel {
	private root: HTMLElement;
	private params: DebugPanelParams = { latencyMs: 0, jitterMs: 0, lossPct: 0, bandwidthStep: BANDWIDTH_STEPS.length - 1 };
	private statsEl: HTMLElement;
	public onChange: ((p: NetSimParams) => void) | null = null;
	public onSetHz: ((hz: number) => void) | null = null;
	public onReset: (() => void) | null = null;
	private visible = false;

	constructor() {
		this.root = document.getElementById("debug")!;
		this.statsEl = document.getElementById("netstats")!;
		this.bindSlider("s-lat", "v-lat", (v) => { this.params.latencyMs = v; this.emit(); }, (v) => `${v}ms`);
		this.bindSlider("s-jit", "v-jit", (v) => { this.params.jitterMs = v; this.emit(); }, (v) => `±${v}ms`);
		this.bindSlider("s-loss", "v-loss", (v) => { this.params.lossPct = v; this.emit(); }, (v) => `${v}%`);
		this.bindSlider("s-bw", "v-bw", (v) => { this.params.bandwidthStep = v; this.emit(); }, (v) => BANDWIDTH_STEPS[Math.min(v, BANDWIDTH_STEPS.length - 1)].label);

		(document.getElementById("s-bw") as HTMLInputElement).max = String(BANDWIDTH_STEPS.length - 1);

		for (const btn of Array.from(this.root.querySelectorAll<HTMLButtonElement>(".preset:not(#hz-buttons) button"))) {
			btn.addEventListener("click", () => {
				const k = btn.dataset.preset!;
				const p = PRESETS[k];
				if (!p) return;
				this.setParams(p);
				this.highlightPreset(k);
			});
		}

		for (const btn of Array.from(this.root.querySelectorAll<HTMLButtonElement>("#hz-buttons button"))) {
			btn.addEventListener("click", () => {
				const hz = Number(btn.dataset.hz);
				this.onSetHz?.(hz);
				this.setActiveHz(hz); // optimistic; server Config confirms
			});
		}

		document.getElementById("reset-boxes")?.addEventListener("click", () => this.onReset?.());

		window.addEventListener("keydown", (e) => {
			if (e.key === "F1") { e.preventDefault(); this.toggle(); }
		});

		this.setParams(this.params);
		this.highlightPreset("lan");
	}

	private bindSlider(sliderId: string, valueId: string, onValue: (v: number) => void, format: (v: number) => string) {
		const s = document.getElementById(sliderId) as HTMLInputElement;
		const v = document.getElementById(valueId)!;
		const update = () => {
			const n = Number(s.value);
			v.textContent = format(n);
			onValue(n);
		};
		s.addEventListener("input", update);
		update();
	}

	private setParams(p: DebugPanelParams) {
		this.params = { ...p };
		(document.getElementById("s-lat") as HTMLInputElement).value = String(p.latencyMs);
		(document.getElementById("s-jit") as HTMLInputElement).value = String(p.jitterMs);
		(document.getElementById("s-loss") as HTMLInputElement).value = String(p.lossPct);
		(document.getElementById("s-bw") as HTMLInputElement).value = String(p.bandwidthStep);
		document.getElementById("v-lat")!.textContent = `${p.latencyMs}ms`;
		document.getElementById("v-jit")!.textContent = `±${p.jitterMs}ms`;
		document.getElementById("v-loss")!.textContent = `${p.lossPct}%`;
		document.getElementById("v-bw")!.textContent = BANDWIDTH_STEPS[Math.min(p.bandwidthStep, BANDWIDTH_STEPS.length - 1)].label;
		this.emit();
	}

	private highlightPreset(k: string) {
		for (const btn of Array.from(this.root.querySelectorAll<HTMLButtonElement>(".preset:not(#hz-buttons) button"))) {
			btn.classList.toggle("active", btn.dataset.preset === k);
		}
	}

	setActiveHz(hz: number) {
		for (const btn of Array.from(this.root.querySelectorAll<HTMLButtonElement>("#hz-buttons button"))) {
			btn.classList.toggle("active", Number(btn.dataset.hz) === hz);
		}
	}

	private emit() {
		const kbps = BANDWIDTH_STEPS[Math.min(this.params.bandwidthStep, BANDWIDTH_STEPS.length - 1)].kbps;
		this.onChange?.({
			latencyMs: this.params.latencyMs,
			jitterMs: this.params.jitterMs,
			lossPct: this.params.lossPct,
			bandwidthKbps: kbps,
		});
	}

	toggle() {
		this.visible = !this.visible;
		this.root.classList.toggle("visible", this.visible);
	}

	updateStats(lines: string[]) {
		this.statsEl.innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
	}
}
