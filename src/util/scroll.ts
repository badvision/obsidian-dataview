/** Utilities for preserving the user's scroll position across async Dataview re-renders. */

import type { Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { App, MarkdownView } from "obsidian";

/** A captured scroll position, together with the element that owns the scroll. */
export type CapturedScroll = {
    el: HTMLElement;
    top: number;
};

/**
 * Finds the nearest ancestor of `container` that is actually scrolled, and records its position.
 * The scroll owner is the leaf view's scrollable content (`.view-content`), not the Dataview
 * container itself. Returns null when the view was not scrolled (nothing to restore).
 */
export function captureViewScroll(container: HTMLElement): CapturedScroll | null {
    let owner: HTMLElement | null = container.parentElement;
    while (owner != null && owner.scrollTop <= 0) owner = owner.parentElement;

    // Defensive fallback: if the walk finds nothing, try the leaf view's content element directly.
    if (owner == null) {
        let fallback = container.closest(".view-content") as HTMLElement | null;
        owner = fallback != null && fallback.scrollTop > 0 ? fallback : null;
    }

    return owner == null || owner.scrollTop <= 0 ? null : { el: owner, top: owner.scrollTop };
}

/** A guard holding a container's height while an async re-render clears and rebuilds it. */
export type HeightGuard = {
    /** The container's height when the guard was applied. */
    height: number;
    /** Releases this guard; the min-height is cleared only when the last guard on the element releases. */
    release(): void;
};

/** Per-element guard refcounts, so overlapping refreshes don't clear the guard early. */
const guardCounts = new WeakMap<HTMLElement, number>();
/** The min-height style value in force before the first guard was applied to each element. */
const guardPrevious = new WeakMap<HTMLElement, string>();

/**
 * Holds the container's height while an async re-render runs. Sets `min-height` synchronously,
 * so it must be called BEFORE the renderer clears the container's content: with the height
 * held, the browser cannot clamp the leaf view's scroll position while the content is
 * collapsed. Refcounted per element; a no-op guard when the container has no height.
 */
export function beginHeightPreserve(container: HTMLElement): HeightGuard {
    let height = container.offsetHeight;
    if (height <= 0) {
        return { height, release: () => {} };
    }

    let count = (guardCounts.get(container) ?? 0) + 1;
    guardCounts.set(container, count);
    if (count === 1) {
        guardPrevious.set(container, container.style.minHeight);
        container.style.minHeight = height + "px";
    }

    return {
        height,
        release: () => {
            let remaining = (guardCounts.get(container) ?? 1) - 1;
            if (remaining > 0) {
                guardCounts.set(container, remaining);
                return;
            }
            guardCounts.delete(container);
            container.style.minHeight = guardPrevious.get(container) ?? "";
            guardPrevious.delete(container);
        },
    };
}

/**
 * Writes a captured scroll position immediately. Skips the write when both container heights
 * are given and they differ by at least 4px: with the height guard in place, the content is
 * already anchored at the user's scroll position, and a stale pixel write would jump the view
 * by the height delta. No-op when there is nothing to restore.
 *
 * `heightAfter` must be measured at write time (post-release, post-layout); see `restoreViewScroll`.
 */
export function restoreViewScrollNow(
    captured: CapturedScroll | null,
    heightBefore?: number,
    heightAfter?: number
): void {
    if (captured == null || captured.top === 0) return;
    if (heightBefore != null && heightAfter != null && Math.abs(heightAfter - heightBefore) >= 4) return;
    captured.el.scrollTop = captured.top;
}

/**
 * Restores a captured scroll position. The write is deferred with `requestAnimationFrame` so it
 * happens after the re-rendered content is laid out; if the content shrank, the browser clamps
 * to the new maximum. No-op when there is nothing to restore.
 *
 * Pass the CONTAINER (not a pre-read height): the post-rebuild height is measured at WRITE TIME,
 * inside the rAF, i.e. after the height guard has been released and the new content has been
 * committed and laid out. Reading it at promise resolution (.then() microtask) races the content
 * insert and mis-fires the delta-skip (the 77px read; #2208, commit 3).
 * See `restoreViewScrollNow`.
 */
export function restoreViewScroll(
    captured: CapturedScroll | null,
    heightBefore?: number,
    container?: HTMLElement
): void {
    requestAnimationFrame(() =>
        restoreViewScrollNow(captured, heightBefore, container ? container.offsetHeight : undefined)
    );
}

/**
 * Resolves the EditorView that owns the given scroll element. Called with the SCROLL OWNER
 * (`.cm-scroller` in Live Preview), never the block container: in @codemirror/view 6.19.0
 * `findFromDOM` looks at DESCENDANTS only (`.cm-content` query), and a Dataview block
 * container nested inside the editor has none — field-verified NULL on all four probes
 * (#2208, design Part 2.1.1). The scroller's direct child IS `.cm-content`, so the owner
 * resolves.
 *
 * Acceptance invariant for every candidate: `view.scrollDOM === owner` — the view must own
 * the exact scroller we restore (multi-pane/pop-out safe). Returns null when not inside a CM
 * editor (reading view → owner is `.view-content`) or when no route resolves.
 *
 * Stage 1 — `EditorView.findFromDOM(owner)`: the descendant-based lookup resolves from the
 * scroller. A throwsafe: a CM build that fails inside the lookup degrades to stage 2.
 * Stage 2 — Obsidian API (no CM module-identity assumptions): scan markdown leaves, match by
 * `mdv.containerEl.contains(owner)`, take the already-typed `mdv.editor.cm`
 * (`obsidian-ex.d.ts` augmentation; used by `main.ts` today).
 */
export function findEditorView(owner: HTMLElement, app: App): EditorView | null {
    let view: EditorView | null = null;
    try {
        view = EditorView.findFromDOM(owner);
    } catch {
        view = null;
    }
    if (view != null && view.scrollDOM === owner) return view;

    for (let leaf of app.workspace.getLeavesOfType("markdown")) {
        let mdv = leaf.view;
        if (mdv instanceof MarkdownView && mdv.containerEl.contains(owner)) {
            let cm = mdv.editor.cm;
            if (cm != null && cm.scrollDOM === owner) return cm;
        }
    }
    return null;
}

/**
 * A captured scroll anchor (#2208, commit 4). `view` is null in reading view / non-LP /
 * unresolved acquisition → the legacy raw-pixel path (commit 2/3 behavior).
 */
export type ScrollAnchor = {
    /** The scroll element: LP → view.scrollDOM (`.cm-scroller`); reading → `.view-content`. */
    owner: HTMLElement;
    /** owner.scrollTop at capture (raw fallback write + re-assert target basis). */
    top: number;
    /** From findEditorView(owner, app); null → legacy pixel path. */
    view: EditorView | null;
    /** Doc position to hold at anchorViewportY (-1 on the legacy path). */
    anchorPos: number;
    /** The anchor's offset inside the owner's viewport at capture. */
    anchorViewportY: number;
    /** Doc-identity guard for the re-assert window (view.state.doc at capture). */
    docAtCapture: Text | null;
};

/**
 * Captures the scroll anchor for a container about to be re-rendered. The viewport top is the
 * PRIMARY anchor (field case, #2208: the caret is usually OUT of the viewport — the user
 * scrolled away to read); when the caret IS visible it refines the anchor to the caret
 * itself, which also neutralizes CM's keep-caret-visible overwrite (after restore the caret
 * is visible, so the one-shot is a no-op). Synchronously, before the height guard + render.
 */
export function captureScrollAnchor(container: HTMLElement, app: App): ScrollAnchor | null {
    let legacy = captureViewScroll(container);
    if (legacy == null) return null;
    const { el: owner, top } = legacy;
    const view = findEditorView(owner, app);
    if (view == null) {
        return { owner, top, view: null, anchorPos: -1, anchorViewportY: 0, docAtCapture: null };
    }
    try {
        const sRect = owner.getBoundingClientRect();
        const head = view.state.selection.main.head;
        const rect = view.coordsAtPos(head);
        if (rect != null && rect.top - sRect.top >= -4 && rect.top - sRect.top <= owner.clientHeight + 4) {
            // REFINEMENT — caret visible: anchor ON the caret at its exact captured offset.
            return {
                owner,
                top,
                view,
                anchorPos: head,
                anchorViewportY: rect.top - sRect.top,
                docAtCapture: view.state.doc,
            };
        }
        // PRIMARY (field-verified, #2208 round 2) — caret out of viewport: anchor the doc
        // position at the viewport top, mirroring CM's own scrollAnchorAt(scrollTop + 8).
        const anchorPos = view.posAtCoords({ x: sRect.left + 10, y: sRect.top + 8 }, false);
        return { owner, top, view, anchorPos, anchorViewportY: 8, docAtCapture: view.state.doc };
    } catch {
        // View died mid-capture (state access throws) → legacy pixel path.
        return { owner, top, view: null, anchorPos: -1, anchorViewportY: 0, docAtCapture: null };
    }
}

/** The restore decision for one re-render, made at write time (T1, after the guard release). */
export type RestorePlan =
    | { kind: "none" }
    | { kind: "cm"; pos: number; yMargin: number }
    | { kind: "pixel"; top: number };

export function planScrollRestore(anchor: ScrollAnchor | null, heightBefore: number, heightAfter: number): RestorePlan {
    if (anchor == null || anchor.top === 0) return { kind: "none" };
    if (anchor.view != null) {
        // User typed during the refresh window → doc changed → don't yank the view.
        if (anchor.view.state.doc !== anchor.docAtCapture) return { kind: "none" };
        return { kind: "cm", pos: anchor.anchorPos, yMargin: anchor.anchorViewportY };
    }
    if (heightBefore != null && heightAfter != null && Math.abs(heightAfter - heightBefore) >= 4)
        return { kind: "none" }; // commit-2 4px heuristic, no-view (reading view) only
    return { kind: "pixel", top: anchor.top };
}

/**
 * ISOLATED ANY-CAST SEAM (documented; the ONLY untyped CM surface in the codebase).
 * The reduced @codemirror/view 6.19.0 typings declare only the STATIC
 * `EditorView.scrollIntoView` effect factory; the INSTANCE method
 * `view.scrollIntoView(pos, options)` (core CM6 since 6.0, present in every Obsidian runtime
 * build) is omitted from the trimmed d.ts. We cast here, in this one function, with a runtime
 * capability check; if the method is somehow absent we return undefined and the caller falls
 * back to the raw pixel write (commit-3 behavior).
 *
 * Fully-typed alternative (used only if the seam is rejected in review — it dispatches a
 * transaction, running the plugin update pipeline, which we avoid for a pure scroll):
 *   view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start", yMargin }) });
 */
type ScrollIntoViewFn = (
    pos: number,
    options?: { y?: "nearest" | "start" | "end" | "center"; yMargin?: number }
) => boolean;
const cmScrollIntoView = (view: EditorView, pos: number, yMargin: number): boolean | undefined => {
    const fn = (view as unknown as { scrollIntoView?: ScrollIntoViewFn }).scrollIntoView;
    return typeof fn === "function" ? fn.call(view, pos, { y: "start", yMargin }) : undefined;
};

/**
 * Applies a plan, then returns the ACTUAL owner scrollTop achieved (line-block quantization
 * makes the achieved value the correct re-assert target). Returns null when nothing was
 * written.
 */
export function applyRestorePlan(anchor: ScrollAnchor, plan: RestorePlan): number | null {
    if (plan.kind === "none") return null;
    if (plan.kind === "cm" && anchor.view != null && cmScrollIntoView(anchor.view, plan.pos, plan.yMargin) != null) {
        // CM-OWNED restore: verified in the 6.19.0 dist (scrollRectIntoView), y:"start" +
        // yMargin places the anchor exactly yMargin below the viewport top, from LIVE geometry.
        return anchor.owner.scrollTop;
    }
    anchor.owner.scrollTop = anchor.top; // raw fallback (no view / missing seam): commit-3 write
    return anchor.owner.scrollTop; // browser clamps to the new max
}

/** Re-assert window: 2 s from the primary write, 3 re-asserts max, 4 px tolerance. */
const REASSERT_WINDOW_MS = 2000;
const REASSERT_QUIET_MS = 150;
const REASSERT_MAX = 3;
const REASSERT_TOLERANCE_PX = 4;

/** Per-container in-flight window, so a newer refresh can supersede it. */
const pendingRestores = new WeakMap<HTMLElement, () => void>();

/**
 * Restores after the rebuild settles, then defends the position against late programmatic
 * overwrites (CM/Obsidian keep-caret-visible on the re-render update; field: +59ms, #2208).
 *
 * T1 = double rAF after render/compute resolves: release the guard (commit-3 order: BEFORE
 * the height read), plan, apply the primary restore. target := owner.scrollTop measured
 * immediately after the write.
 * Window (2 s, from T1):
 *   PRIMARY trigger — 'scroll' event on the owner:
 *     - e.isTrusted === true  → USER scrolled → CANCEL the window (never fight the user).
 *     - e.isTrusted === false → programmatic write: if |owner.scrollTop - target| > 4,
 *       re-apply the plan (recomputed: view/doc re-checked), target := new owner.scrollTop,
 *       count++. > 3 re-asserts → give up (bounded, no thrash).
 *   SECONDARY trigger — MutationObserver on the container (childList|subtree|characterData),
 *     150 ms mutation-quiet, within the 2 s cap: if off-target beyond 4 px, re-apply. Kept
 *     for post-growth CM re-measures (late async cell markdown); round 2 showed it alone
 *     would not have fired.
 * Cancel (any): trusted scroll, container detached, view unusable (state access throws), doc
 * changed (user typed), a newer refresh supersedes (per-container token), 2 s expiry.
 * Returns cancel(), used by the supersede path.
 */
export function scheduleSettledRestore(
    anchor: ScrollAnchor | null,
    guard: HeightGuard,
    container: HTMLElement
): () => void {
    // A newer refresh on the same container supersedes the in-flight window.
    let superseded = pendingRestores.get(container);
    pendingRestores.delete(container);
    if (superseded != null) superseded();

    let cancelled = false;
    let guardReleased = false;
    let count = 0;
    let target: number | null = null;
    let onScroll: ((e: Event) => void) | null = null;
    let observer: MutationObserver | null = null;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;

    // The guard is held until T1 (commit-3 order: released before the write) — or released
    // early when a newer refresh supersedes this window before T1: the superseding window's
    // guard (refcounted per element) is already applied, so min-height stays held.
    const releaseGuard = (): void => {
        if (!guardReleased) {
            guardReleased = true;
            guard.release();
        }
    };

    const cancel = (): void => {
        if (cancelled) return;
        cancelled = true;
        releaseGuard();
        if (anchor != null && onScroll != null) anchor.owner.removeEventListener("scroll", onScroll);
        if (observer != null) observer.disconnect();
        if (quietTimer != null) clearTimeout(quietTimer);
        if (expiryTimer != null) clearTimeout(expiryTimer);
        if (pendingRestores.get(container) === cancel) pendingRestores.delete(container);
    };
    pendingRestores.set(container, cancel);

    const reapply = (): void => {
        if (anchor == null || target == null) return;
        // Recompute from live state; the doc-identity check doubles as the window's
        // user-typed cancel (CM's own edit-scroll behavior takes over).
        if (anchor.view != null) {
            try {
                if (anchor.view.state.doc !== anchor.docAtCapture) {
                    cancel();
                    return;
                }
            } catch {
                cancel(); // view unusable
                return;
            }
        }
        let written = applyRestorePlan(anchor, planScrollRestore(anchor, guard.height, container.offsetHeight));
        if (written == null) {
            cancel();
            return;
        }
        target = written; // re-measured after the write (line-block quantization)
        count++;
    };

    const offTarget = (): boolean =>
        anchor != null && target != null && Math.abs(anchor.owner.scrollTop - target) > REASSERT_TOLERANCE_PX;

    const openWindow = (): void => {
        if (anchor == null) return;
        onScroll = (e: Event): void => {
            if (cancelled) return;
            if (e.isTrusted) {
                cancel(); // user scrolled: never fight the user
                return;
            }
            if (container.isConnected === false) {
                cancel();
                return;
            }
            if (offTarget() && count < REASSERT_MAX) reapply();
        };
        anchor.owner.addEventListener("scroll", onScroll);
        expiryTimer = setTimeout(cancel, REASSERT_WINDOW_MS);

        // Secondary trigger: 150 ms mutation-quiet re-check (late async cell content).
        let quiet = (): void => {
            quietTimer = null;
            if (cancelled || container.isConnected === false) {
                cancel();
                return;
            }
            if (offTarget() && count < REASSERT_MAX) reapply();
        };
        observer = new MutationObserver(() => {
            if (cancelled) return;
            if (container.isConnected === false) {
                cancel();
                return;
            }
            if (quietTimer == null) quietTimer = setTimeout(quiet, REASSERT_QUIET_MS);
        });
        observer.observe(container, { childList: true, subtree: true, characterData: true });
    };

    const t1 = (): void => {
        if (cancelled) return; // superseded before T1 (the guard was released at supersede)
        releaseGuard(); // commit-3 order: release BEFORE the height read, i.e. before the write
        if (anchor == null || container.isConnected === false) {
            cancel();
            return;
        }
        let written = applyRestorePlan(anchor, planScrollRestore(anchor, guard.height, container.offsetHeight));
        if (written == null) {
            cancel();
            return;
        }
        target = written;
        openWindow();
    };

    requestAnimationFrame(() => requestAnimationFrame(t1));
    return cancel;
}
