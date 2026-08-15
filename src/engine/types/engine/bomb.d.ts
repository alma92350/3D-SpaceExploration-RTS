/**
 * The Helium Bomb (P3-T10).
 *
 * Two radii, and both matter: everything at or inside `BOMB_CORE_RADIUS` takes the flat peak hit,
 * and damage then falls off with the square of distance out to zero at `BOMB_BLAST_RADIUS`. The
 * engine's own `bombDetonated` event carries **both** numbers to the VFX layer, which is the engine
 * saying that one ring is not enough to describe the blast.
 *
 * `bombDamageAt` is the curve itself. Never re-derive it above the bridge: a tooltip that recomputes
 * the falloff agrees with the engine exactly until the day the exponent moves.
 */

/** Damage reaches zero here. Tied to `POWER_TIERS[0].max`, so it can never drift from the grid UI. */
export declare const BOMB_BLAST_RADIUS: number;
/** Ground zero: 1.5x the bomb's own radius. Everything at or inside takes `BOMB_MAX_DAMAGE`. */
export declare const BOMB_CORE_RADIUS: number;
/** How close a live enemy gets before an armed bomb lights its own fuse. Equal to the core radius. */
export declare const BOMB_DETECT_RANGE: number;
/** Peak HP loss, past the toughest building in the game. */
export declare const BOMB_MAX_DAMAGE: number;
/** Sim seconds a lit fuse burns before the blast. The window the warning exists to buy. */
export declare const BOMB_FUSE_DELAY: number;

/** HP lost at `dist` from ground zero. Flat to the core radius, then inverse-square to zero. */
export declare function bombDamageAt(dist: number): number;

/**
 * Light `bomb`'s fuse: `BOMB_FUSE_DELAY` sim-seconds from now, `updateBombFuse` detonates it.
 *
 * Idempotent — re-triggering an already-lit fuse does NOT restart the clock — and it pushes the
 * `bombFused` event exactly once, on the tick it actually lights.
 */
export declare function lightFuse(state: State, bomb: Unit): void;

/** Detonate now, unconditionally. The one place the blast happens, so no two triggers can disagree. */
export declare function detonateBomb(state: State, bomb: Unit): void;
