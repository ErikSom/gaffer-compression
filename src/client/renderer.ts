import * as THREE from "three";
import {
	WORLD_HALF,
	DYNAMIC_COUNT,
	MAX_PLAYERS,
	BOX_SIZE,
	PLAYER_RADIUS,
	PLAYER_BASE_INDEX,
} from "../shared/sceneConfig.js";
import type { NetworkBodyState } from "../network/networkInterfaces.js";

export class Renderer {
	public scene = new THREE.Scene();
	public camera: THREE.PerspectiveCamera;
	public renderer: THREE.WebGLRenderer;
	public boxes: THREE.InstancedMesh;
	public playerMeshes: THREE.Mesh[] = [];
	private ownRing!: THREE.Mesh;
	private tmpMat = new THREE.Matrix4();
	private tmpPos = new THREE.Vector3();
	private tmpQuat = new THREE.Quaternion();
	private tmpScale = new THREE.Vector3(1, 1, 1);
	private ownedIndex = -1;
	// Last transform written per box, so we can skip the compose + instance-buffer
	// upload for boxes that didn't move this frame (settled boxes become free).
	private lastBoxPos = new Float32Array(DYNAMIC_COUNT * 3);
	private lastBoxRot = new Float32Array(DYNAMIC_COUNT * 4);

	constructor(canvasContainer: HTMLElement) {
		this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		this.renderer.setSize(window.innerWidth, window.innerHeight);
		this.renderer.outputColorSpace = THREE.SRGBColorSpace;
		canvasContainer.appendChild(this.renderer.domElement);

		this.scene.background = new THREE.Color(0x12141c);
		this.scene.fog = new THREE.Fog(0x12141c, 120, 400);

		this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 600);
		this.camera.position.set(28, 22, 45);
		this.camera.lookAt(0, 3, 0);

		const hemi = new THREE.HemisphereLight(0xb0c4ff, 0x2a2a38, 1.1);
		this.scene.add(hemi);
		const sun = new THREE.DirectionalLight(0xffe8c8, 1.4);
		sun.position.set(30, 50, 20);
		this.scene.add(sun);
		const rim = new THREE.DirectionalLight(0x6aa0ff, 0.45);
		rim.position.set(-20, 10, -30);
		this.scene.add(rim);

		const floorGeo = new THREE.PlaneGeometry(WORLD_HALF * 2, WORLD_HALF * 2);
		const floorMat = new THREE.MeshStandardMaterial({ color: 0x2a2f40, roughness: 0.85, metalness: 0.1 });
		const floor = new THREE.Mesh(floorGeo, floorMat);
		floor.rotation.x = -Math.PI / 2;
		this.scene.add(floor);

		const grid = new THREE.GridHelper(WORLD_HALF * 2, 40, 0x6080d0, 0x404a70);
		(grid.material as THREE.Material).transparent = true;
		(grid.material as THREE.Material).opacity = 0.8;
		grid.position.y = 0.01;
		this.scene.add(grid);

		const wallLineMat = new THREE.LineBasicMaterial({ color: 0x4a5580, transparent: true, opacity: 0.4 });
		const wallOutline = new THREE.BufferGeometry();
		const H = WORLD_HALF, TOP = 15;
		const corners = [
			[-H, 0, -H], [H, 0, -H], [H, 0, H], [-H, 0, H], [-H, 0, -H],
			[-H, TOP, -H], [H, TOP, -H], [H, 0, -H], [H, TOP, -H],
			[H, TOP, H], [H, 0, H], [H, TOP, H],
			[-H, TOP, H], [-H, 0, H], [-H, TOP, H], [-H, TOP, -H],
		];
		wallOutline.setAttribute("position", new THREE.Float32BufferAttribute(corners.flat(), 3));
		this.scene.add(new THREE.Line(wallOutline, wallLineMat));

		const boxGeo = new THREE.BoxGeometry(BOX_SIZE, BOX_SIZE, BOX_SIZE);
		const boxMat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.25, vertexColors: false });
		this.boxes = new THREE.InstancedMesh(boxGeo, boxMat, DYNAMIC_COUNT);
		this.boxes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		// InstancedMesh caches its bounding sphere on first render — which happens
		// before the first snapshot, when every instance is still at its off-screen
		// default (0,-1000,0). That stale sphere would frustum-cull the entire pile
		// forever once the boxes move to their real positions. One draw call for
		// 4096 boxes is cheap, so just never cull it.
		this.boxes.frustumCulled = false;
		const tmpColor = new THREE.Color();
		for (let i = 0; i < DYNAMIC_COUNT; i++) {
			const hue = (i * 0.0137) % 1;
			tmpColor.setHSL(hue, 0.65, 0.55);
			this.boxes.setColorAt(i, tmpColor);
		}
		this.scene.add(this.boxes);

		this.boxes.instanceColor!.needsUpdate = true;

		const ballGeo = new THREE.SphereGeometry(PLAYER_RADIUS, 24, 16);
		this.playerMeshes = [];
		for (let i = 0; i < MAX_PLAYERS; i++) {
			// Evenly spaced hue per slot — deterministic, so every client sees the
			// same colour for a given player.
			const col = new THREE.Color().setHSL(i / MAX_PLAYERS, 0.85, 0.58);
			const mat = new THREE.MeshStandardMaterial({
				color: col,
				roughness: 0.3,
				metalness: 0.2,
				emissive: col,
				emissiveIntensity: 0.5,
			});
			const mesh = new THREE.Mesh(ballGeo, mat);
			mesh.position.set(0, -1000, 0);
			this.scene.add(mesh);
			this.playerMeshes.push(mesh);
		}

		// Ring marker that sits around the locally-owned ball so you can pick
		// yourself out of the crowd.
		this.ownRing = new THREE.Mesh(
			new THREE.TorusGeometry(PLAYER_RADIUS * 1.35, 0.18, 10, 40),
			new THREE.MeshBasicMaterial({ color: 0xffffff })
		);
		this.ownRing.rotation.x = -Math.PI / 2;
		this.ownRing.visible = false;
		this.scene.add(this.ownRing);

		window.addEventListener("resize", () => this.onResize());
	}

	setOwnedPlayerIndex(globalIndex: number) {
		this.ownedIndex = globalIndex;
	}

	onResize() {
		this.camera.aspect = window.innerWidth / window.innerHeight;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(window.innerWidth, window.innerHeight);
	}

	applyState(state: NetworkBodyState[]) {
		const lp = this.lastBoxPos;
		const lr = this.lastBoxRot;
		let anyChanged = false;
		for (let i = 0; i < DYNAMIC_COUNT; i++) {
			const p = state[i].position;
			const q = state[i].rotation;
			const pi = i * 3, ri = i * 4;
			// Interpolation produces an identical float for an unmoved box, so an
			// exact compare reliably skips settled boxes — no compose, no upload.
			if (
				p.x === lp[pi] && p.y === lp[pi + 1] && p.z === lp[pi + 2] &&
				q.x === lr[ri] && q.y === lr[ri + 1] && q.z === lr[ri + 2] && q.w === lr[ri + 3]
			) continue;

			lp[pi] = p.x; lp[pi + 1] = p.y; lp[pi + 2] = p.z;
			lr[ri] = q.x; lr[ri + 1] = q.y; lr[ri + 2] = q.z; lr[ri + 3] = q.w;

			this.tmpPos.copy(p);
			this.tmpQuat.copy(q);
			this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
			this.boxes.setMatrixAt(i, this.tmpMat);
			anyChanged = true;
		}
		if (anyChanged) this.boxes.instanceMatrix.needsUpdate = true;

		for (let i = 0; i < MAX_PLAYERS; i++) {
			const s = state[PLAYER_BASE_INDEX + i];
			const m = this.playerMeshes[i];
			m.position.copy(s.position);
			m.quaternion.copy(s.rotation);
			m.visible = s.position.y > -500;
		}

		// Keep the "you" ring on the owned ball (flat, near its base).
		const me = this.ownedIndex >= 0 ? state[this.ownedIndex] : null;
		if (me && me.position.y > -500) {
			this.ownRing.position.set(me.position.x, me.position.y - PLAYER_RADIUS + 0.15, me.position.z);
			this.ownRing.visible = true;
		} else {
			this.ownRing.visible = false;
		}

		this.updateCamera(state);
	}

	private camTargetPos = new THREE.Vector3();
	private camTargetLook = new THREE.Vector3();
	private orbitT = 0.5;
	public mode: "chase" | "orbit" = "chase";

	toggleMode() {
		this.mode = this.mode === "orbit" ? "chase" : "orbit";
	}

	private updateCamera(state: NetworkBodyState[]) {
		const haveOwned = this.ownedIndex >= 0 && state[this.ownedIndex] && state[this.ownedIndex].position.y > -500;

		if (this.mode === "chase" && haveOwned) {
			const p = state[this.ownedIndex].position;
			this.camTargetPos.set(p.x, p.y + 12, p.z + 18);
			this.camTargetLook.set(p.x, p.y, p.z - 10);
			this.camera.position.lerp(this.camTargetPos, 0.12);
			this.camera.lookAt(this.camTargetLook);
			return;
		}

		this.orbitT += 0.0015;
		const r = 44;
		const camX = Math.cos(this.orbitT) * r;
		const camZ = Math.sin(this.orbitT) * r;
		this.camTargetPos.set(camX, 22, camZ);
		this.camera.position.lerp(this.camTargetPos, 0.04);
		this.camera.lookAt(0, 3, 0);
	}

	render() {
		this.renderer.render(this.scene, this.camera);
	}
}
