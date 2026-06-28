import { defineConfig } from "vite";

export default defineConfig({
	root: "src/client",
	publicDir: false,
	server: {
		port: 5173,
		host: true, // bind 0.0.0.0 so phones on the same Wi-Fi can connect
		allowedHosts: [".ngrok.app", ".ngrok-free.app"],
		// Proxy the game WebSocket through Vite so a single origin (and a single
		// ngrok tunnel) covers both the page and the server. Over HTTPS this
		// becomes wss://<host>/ws automatically.
		proxy: {
			"/ws": { target: "ws://localhost:8787", ws: true, changeOrigin: true },
		},
	},
	build: {
		outDir: "../../dist/client",
		emptyOutDir: true,
	},
	optimizeDeps: {
		exclude: ["@dimforge/rapier3d-compat"],
	},
});
