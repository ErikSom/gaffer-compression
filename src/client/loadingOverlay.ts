// Full-screen overlay shown until the first authoritative snapshot renders. The
// game server is a free-tier dyno that sleeps when idle, so a cold start can take
// up to ~a minute — after a few seconds of waiting we say so, rather than leaving
// the user staring at a bare "Connecting…".
const WAKE_HINT_DELAY_MS = 4000;
const WAKE_MESSAGE =
	"The demo server runs on a free tier and may be waking from sleep. First load can take up to a minute…";

export class LoadingOverlay {
	private el = document.getElementById("loading")!;
	private title = document.getElementById("loading-title")!;
	private sub = document.getElementById("loading-sub")!;
	private hintTimer: ReturnType<typeof setTimeout> | null = null;

	show(title = "Connecting…") {
		this.title.textContent = title;
		this.sub.textContent = "";
		this.el.classList.remove("hidden");
		this.armHint();
	}

	// Re-show after a drop. Call only once we'd actually connected, so the initial
	// cold-start retries keep the calmer "Connecting…" copy.
	reconnecting() {
		this.show("Connection lost — reconnecting…");
	}

	hide() {
		this.clearHint();
		this.el.classList.add("hidden");
	}

	private armHint() {
		this.clearHint();
		this.hintTimer = setTimeout(() => {
			this.sub.textContent = WAKE_MESSAGE;
		}, WAKE_HINT_DELAY_MS);
	}

	private clearHint() {
		if (this.hintTimer) {
			clearTimeout(this.hintTimer);
			this.hintTimer = null;
		}
	}
}
