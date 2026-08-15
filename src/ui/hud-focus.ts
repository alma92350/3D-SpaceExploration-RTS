// The HUD's keyboard ring (P6-T03, PRD N-05: "keyboard-navigable UI").
//
// ================================================================================================
// WHY THERE IS A RING AT ALL, WHEN THE HUD IS MADE OF <button>
// ================================================================================================
//
// The positional row is a real control and it is not navigation: Z/C/V/B/N fire the **first five**
// buttons on screen (`input/intents.ts`, `HudModel.actions`). That was enough when the drawer was
// one section; it is now up to nine deep — jump, colonies, lanes, campaign, relief and whichever of
// diplomacy / gate / records / news / system is open — and five letters cannot address forty
// buttons. N-05 asks for a keyboard-navigable UI, not for five hotkeys.
//
// A browser already gives `<button>` a tab order for free, so the honest question is why this file
// exists rather than a stylesheet. Three reasons, and each is a defect the free version has:
//
//   1. **The shell owns the keyboard.** `Game.onKeyDown` listens on `window`, so with a HUD button
//      focused, Space would both activate the button (the browser's own doing) and jump the camera
//      to the last alert (`translateKey`). One keystroke, two commands, and the dangerous half is
//      the one that presses whatever button the player happens to be on — including Surrender. A
//      ring that owns Space *while it holds focus* is what resolves that, and only while it does:
//      with nothing focused, Space is still the alert key it has been since Phase 3.
//   2. **The HUD rebuilds its buttons.** `HudView` replaces whole rows of nodes when the button SET
//      changes (a section opening, a unit finishing, a research queue emptying). The focused node
//      goes with them, focus falls back to the body, and a keyboard player is silently returned to
//      the start of a forty-button list — mid-interaction, without being told. `sync` is the answer:
//      it re-anchors on the ACTION the player was on, by id, not on the slot it happened to occupy.
//   3. **It has to be provable.** The row's definition of done is "proven by driving a real `Game`
//      in jsdom", and jsdom implements no sequential focus navigation at all: a dispatched Tab event
//      moves nothing. A ring the app owns is one a test can drive; the browser's is not.
//
// ================================================================================================
// THE KEYS, ON A BOARD WITH NOTHING LEFT
// ================================================================================================
//
// `input/intents.ts` has spent every letter and says so at length. This costs none:
//
//   Tab / Shift+Tab   next / previous control, wrapping. The one key every interface on the
//                     machine already means this with, and unbound by this game.
//   Enter             activate the focused control. Free — `translateKey` returns nothing for it.
//   Space             activate, **but only while the ring holds focus**, because Space is the
//                     alert key otherwise (see reason 1 above). Consumed with `preventDefault`, so
//                     a browser's own button activation cannot fire it a second time.
//   Escape            not consumed. It releases the ring AND falls through to the shell, so one
//                     press still backs out of a build mode or a screen — a player who had to press
//                     Escape twice would rightly report the first press as broken.
//
// The arrow keys are deliberately NOT taken: they pan the camera, and a player stepping through the
// drawer still has to be able to look at the thing they are about to act on.
//
// ================================================================================================
// WHAT THIS FILE MAY NOT DO
// ================================================================================================
//
// It moves focus and it clicks buttons. It issues no intent, reads no snapshot and knows nothing
// about what any control does — a press goes through the button's own click handler, which is the
// same path a mouse takes into `Game.runCommand`. That is the rule `HudCommand` set for the
// positional row and it holds here for the same reason: a control the keyboard reaches by a
// different route is a control that can drift out of step with the one the mouse reaches.
//
// `sync` runs inside the render path, so its common case allocates nothing (ADR-0006): two property
// reads when the ring is idle, and a node scan only on the frame a rebuild actually destroyed the
// focused button.

/**
 * What the ring needs to know about a control: its identity.
 *
 * Structural rather than an import of `HudAction`, so this module depends on nothing in the HUD —
 * it is handed the same ordered list the positional keys index into (`Game.actions`), which is the
 * DOM order of the buttons by construction: the world row first, then each drawer section in turn.
 */
export interface FocusableAction {
  readonly id: string;
}

/** The class the focused control wears. The stylesheet paints it; see `src/a11y.css`. */
export const FOCUS_CLASS = "hud-focus";

export class HudFocus {
  /** The node the ring is holding, or null when it holds nothing. */
  private node: HTMLElement | null = null;
  /** The action id that node was showing, so a rebuild can put the player back on the same control. */
  private id: string | null = null;
  /** Where it sat in the row — the fallback when the action itself is gone (a queue emptied). */
  private slot = 0;
  /** The last ordered action list, as the shell drew it. */
  private actions: readonly FocusableAction[] = [];

  constructor(private readonly root: HTMLElement) {}

  /**
   * Handle one key. Returns true when the ring consumed it, in which case the shell must not also
   * act on it — that early return is the whole of the integration on the key side.
   */
  handleKey(event: KeyboardEvent): boolean {
    // Modified keys belong to the browser and to the control groups (Ctrl+digit). The ring claims
    // Shift only, and only on Tab.
    if (event.ctrlKey || event.altKey || event.metaKey) return false;

    if (event.key === "Tab") {
      this.move(event.shiftKey ? -1 : 1);
      // Without this the browser advances its own focus as well and the ring skips every other
      // control — the classic managed-focus bug, and invisible in jsdom, which tabs nowhere.
      event.preventDefault();
      return true;
    }

    if (!this.holdsFocus()) {
      // Nothing focused: every key means what it has always meant. This is the line that keeps
      // Space on "focus last alert" for a player who never touched Tab.
      return false;
    }

    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      this.activate();
      event.preventDefault();
      return true;
    }

    if (event.key === "Escape") {
      // Released but NOT consumed: Escape still backs out one level in the shell. Blurring first
      // means the next Tab starts from the top rather than from a control the player has left.
      this.release();
      return false;
    }

    return false;
  }

  /**
   * Tell the ring what the HUD is showing, once per frame, after it has been rendered.
   *
   * Cheap by design — the common case is two property reads. The scan happens only when the node
   * the ring was holding has been rebuilt away, which is the case this method exists for.
   */
  sync(actions: readonly FocusableAction[]): void {
    this.actions = actions;
    const node = this.node;
    if (!node) return;
    if (node.isConnected) {
      // Still in the document. If the player has moved focus somewhere else — clicked the world,
      // pressed Escape — the ring lets go rather than clinging, because the alternative is a HUD
      // that steals focus back on the next rebuild.
      if (this.activeElement() !== node) this.forget();
      return;
    }
    this.restore();
  }

  /** The control the ring is on, for a test to assert against. Null when it holds nothing. */
  get focused(): HTMLElement | null {
    return this.node;
  }

  /** Press the focused control, by the same route a mouse click takes. */
  private activate(): void {
    const node = this.node;
    if (node && node.isConnected) node.click();
  }

  private move(delta: number): void {
    const buttons = this.buttons();
    if (buttons.length === 0) {
      this.release();
      return;
    }
    // Where the ring is is whatever the DOM says is focused, not what this object last did. That is
    // what lets a mouse click, or a browser's own tab into the page, become the ring's position —
    // the player carries on from the control they can see, rather than from a remembered one.
    const at = buttons.indexOf(this.activeElement() as HTMLButtonElement);
    const next = at < 0
      ? (delta > 0 ? 0 : buttons.length - 1)
      : (at + delta + buttons.length) % buttons.length;
    this.take(buttons, next);
  }

  /** Put the player back on the control they were on, after `HudView` rebuilt the row. */
  private restore(): void {
    const buttons = this.buttons();
    if (buttons.length === 0) {
      this.forget();
      return;
    }
    // By ACTION, not by slot: a section opening above pushes every button down, and a ring that
    // restored by index would leave the player focused on a different control while the interface
    // showed nothing to say so — and the next Enter would press it.
    let index = this.id === null ? -1 : this.actions.findIndex((a) => a.id === this.id);
    // The action itself is gone (a research job finished, a board closed). The slot is the honest
    // fallback: the row the player was reading has changed under them, so keep their place in it.
    if (index < 0 || index >= buttons.length) index = Math.min(this.slot, buttons.length - 1);
    this.take(buttons, index);
  }

  private take(buttons: readonly HTMLButtonElement[], index: number): void {
    const node = buttons[index];
    if (!node) return;
    if (this.node && this.node !== node) this.node.classList.remove(FOCUS_CLASS);
    this.node = node;
    this.slot = index;
    this.id = this.actions[index]?.id ?? null;
    // The class rather than `:focus` alone: focus moved by script does not reliably match
    // `:focus-visible`, and a keyboard ring nobody can see is the same as no ring. It is also the
    // hook a test can assert on, since no stylesheet is loaded in jsdom.
    node.classList.add(FOCUS_CLASS);
    node.focus();
    // The drawer scrolls (`.hud-economy` is `overflow-y: auto`), so the ninth section's buttons can
    // sit below the fold. Guarded: jsdom has no layout and older engines have no smooth behaviour.
    try {
      node.scrollIntoView?.({ block: "nearest" });
    } catch {
      // Layout is not available. Focus has still moved, which is the part that matters.
    }
  }

  /** Drop the ring's claim and blur, so the interface stops showing a focus the player has left. */
  private release(): void {
    const node = this.node;
    this.forget();
    if (node && node.isConnected) node.blur();
  }

  private forget(): void {
    if (this.node) this.node.classList.remove(FOCUS_CLASS);
    this.node = null;
    this.id = null;
  }

  private holdsFocus(): boolean {
    const node = this.node;
    return node !== null && node.isConnected && this.activeElement() === node;
  }

  private activeElement(): Element | null {
    return this.root.ownerDocument.activeElement;
  }

  /**
   * Every control the HUD is showing, in the order it is drawn.
   *
   * Read from the DOM at the moment it is needed rather than cached, because the row it describes
   * is rebuilt without telling anyone. Allocates — which is why nothing calls this per frame.
   */
  private buttons(): HTMLButtonElement[] {
    return [...this.root.querySelectorAll<HTMLButtonElement>("button")];
  }
}
