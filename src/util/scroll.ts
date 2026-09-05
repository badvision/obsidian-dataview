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
 * The optional container heights (before/after the re-render) let the pixel write be skipped
 * when the content's height changed meaningfully; see `restoreViewScrollNow`.
 */
export function restoreViewScroll(captured: CapturedScroll | null, heightBefore?: number, heightAfter?: number): void {
    requestAnimationFrame(() => restoreViewScrollNow(captured, heightBefore, heightAfter));
}
