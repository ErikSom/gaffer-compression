// ---------------------------------------------------------------------------
// Single source of truth for scene scale. settings.maxPhysicsObjects derives
// from TOTAL_OBJECTS so the network bit-widths and the physics world can never
// drift out of sync.
//
// The scene is deliberately simple: one player-controlled ball + a big pile of
// boxes. The point is to watch thousands of bodies stay synced for almost no
// bytes until the ball disturbs them.
// ---------------------------------------------------------------------------

// "Many many": 4096 dynamic boxes sits right at the edge of a 60Hz single-
// threaded Rapier step in the worst case (everything colliding at once) and
// drops to ~3ms once bodies settle and sleep. Configurable — raise at your own
// peril, the server can't hold 60Hz much past this.
export const DYNAMIC_COUNT = 4096;

// Each connection claims a slot and gets its own colored ball.
export const MAX_PLAYERS = 8;
export const TOTAL_OBJECTS = DYNAMIC_COUNT + MAX_PLAYERS;

export const WORLD_HALF = 35;
export const FLOOR_Y = 0;

export const BOX_SIZE = 0.6;

// Several tall piles spread across the arena (PILE_GRID × PILE_GRID of them),
// each SPAWN_LAYERS high. The ball plows through a few at a time rather than the
// whole field at once — which also keeps the awake-body count (and physics cost)
// down compared to one giant pile.
export const SPAWN_LAYERS = 10;
export const PILE_GRID = 3;

// High box damping is the single biggest server-perf lever under heavy motion: a
// heavy fast ball flings the whole pile into motion at once, and Rapier's solver
// cost scales with the number of awake bodies. Strong damping makes scattered
// boxes shed energy and sleep quickly, roughly halving the awake count
// (≈3100→1900) and the step time (≈19ms→12ms, back under the 16.7ms budget).
// (Cutting solver iterations instead backfires — instability keeps boxes awake.)
export const BOX_LINEAR_DAMPING = 0.6;
export const BOX_ANGULAR_DAMPING = 0.8;

export const PLAYER_RADIUS = 2.5;
// Spawn the balls at the +z edge, clear of the pile field, facing into it.
export const PLAYER_SPAWN_RADIUS = 28;
export const PLAYER_BASE_INDEX = DYNAMIC_COUNT;

// Heavy wrecking-ball that carries serious momentum and moves fast. Terminal
// speed ≈ MOVE_FORCE / (mass · LINEAR_DAMPING); mass ≈ 327 at density 5, so the
// force/torque are scaled up to match (and to overcome the much higher inertia
// when rolling). The ball plows the boxes like bowling pins.
export const PLAYER_MOVE_FORCE = 2000;
export const PLAYER_ROLL_TORQUE = 4000;
export const PLAYER_DENSITY = 5.0;
export const PLAYER_LINEAR_DAMPING = 0.15;
export const PLAYER_ANGULAR_DAMPING = 0.3;
export const PLAYER_FRICTION = 1.2;
