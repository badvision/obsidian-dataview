/** Utilities for preserving the user's scroll position across async Dataview re-renders. */

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

/**
 * Restores a captured scroll position. The write is deferred with `requestAnimationFrame` so it
 * happens after the re-rendered content is laid out; if the content shrank, the browser clamps
 * to the new maximum. No-op when there is nothing to restore.
 */
export function restoreViewScroll(captured: CapturedScroll | null): void {
    if (captured == null || captured.top === 0) return;
    requestAnimationFrame(() => {
        captured.el.scrollTop = captured.top;
    });
}
