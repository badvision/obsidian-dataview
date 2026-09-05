/**
 * Tests for the CM-owned anchor restore + scroll-event re-assert (obsidian-dataview#2208,
 * commit 4).
 *
 * jsdom has no live CodeMirror: `@codemirror/view` is mocked down to its static surface
 * (`findFromDOM`), and the EditorView is a fake carrying just the surface the restore code
 * touches (design Part 2.4). The scroll-event decision is driven with fake `{ isTrusted }`
 * payloads: `new Event("scroll").isTrusted` is always false in jsdom, and the platform
 * distinction (trusted = user, untrusted = programmatic) is exactly what the window keys on.
 */
import { App, MarkdownView } from "obsidian";
import { EditorView } from "@codemirror/view";
import {
    applyRestorePlan,
    beginHeightPreserve,
    captureScrollAnchor,
    findEditorView,
    planScrollRestore,
    scheduleSettledRestore,
    ScrollAnchor,
} from "util/scroll";

jest.mock("@codemirror/view", () => ({
    EditorView: { findFromDOM: jest.fn() },
}));

/** A fake EditorView: only the surface the restore code touches. */
type FakeView = {
    state: { selection: { main: { head: number } }; doc: unknown };
    coordsAtPos: jest.Mock;
    posAtCoords: jest.Mock;
    scrollIntoView: jest.Mock;
    scrollDOM: HTMLElement;
    contentDOM: HTMLElement;
};

function makeView(owner: HTMLElement, doc: unknown): FakeView {
    return {
        state: { selection: { main: { head: 123 } }, doc },
        // Caret not rendered (out of viewport) by default: the field case.
        coordsAtPos: jest.fn().mockReturnValue(null),
        posAtCoords: jest.fn().mockReturnValue(77),
        scrollIntoView: jest.fn().mockReturnValue(true),
        scrollDOM: owner,
        contentDOM: owner,
    };
}

function makeMdView(container: HTMLElement, cm: unknown): MarkdownView {
    return new (MarkdownView as unknown as new (c: HTMLElement, e: { cm?: unknown }) => MarkdownView)(container, {
        cm,
    });
}

function makeApp(leafViews: { view: MarkdownView }[]): App {
    return { workspace: { getLeavesOfType: () => leafViews } } as unknown as App;
}

/** Wraps the fake view in the real ScrollAnchor field type (the seam the restore code uses). */
function asView(v: FakeView | null): ScrollAnchor["view"] {
    return v as unknown as ScrollAnchor["view"];
}

/** Wraps the fake doc in the real ScrollAnchor field type. */
function asDoc(d: unknown): ScrollAnchor["docAtCapture"] {
    return d as unknown as ScrollAnchor["docAtCapture"];
}

function makeRect(top: number, left: number): DOMRect {
    return {
        top,
        left,
        bottom: top + 12,
        right: left + 10,
        width: 10,
        height: 12,
        x: left,
        y: top,
        toJSON: () => ({}),
    } as DOMRect;
}

describe("findEditorView", () => {
    let owner: HTMLElement;

    beforeEach(() => {
        owner = document.createElement("div");
        document.body.appendChild(owner);
        (EditorView.findFromDOM as jest.Mock).mockReset();
    });

    afterEach(() => {
        document.body.innerHTML = "";
    });

    test("stage 1: findFromDOM(owner) hit with scrollDOM === owner", () => {
        let view = makeView(owner, {});
        (EditorView.findFromDOM as jest.Mock).mockReturnValue(view);

        expect(findEditorView(owner, makeApp([]))).toBe(view);
    });

    test("stage 1 mismatch (scrollDOM !== owner) falls through to the leaf scan", () => {
        let other = document.createElement("div");
        document.body.appendChild(other);
        let foreign = makeView(other, {});
        let ours = makeView(owner, {});
        (EditorView.findFromDOM as jest.Mock).mockReturnValue(foreign);

        expect(findEditorView(owner, makeApp([{ view: makeMdView(owner, ours) }]))).toBe(ours);
    });

    test("stage 2: leaf scan hit (containerEl contains owner, editor.cm matches scrollDOM)", () => {
        (EditorView.findFromDOM as jest.Mock).mockReturnValue(null);
        let view = makeView(owner, {});

        expect(findEditorView(owner, makeApp([{ view: makeMdView(owner, view) }]))).toBe(view);
    });

    test("stage 2 miss: no leaf's container contains the owner -> null", () => {
        (EditorView.findFromDOM as jest.Mock).mockReturnValue(null);
        let other = document.createElement("div");
        document.body.appendChild(other);
        let view = makeView(owner, {});
        expect(findEditorView(owner, makeApp([{ view: makeMdView(other, view) }]))).toBeNull();
    });

    test("findFromDOM throwing fails safe to stage 2", () => {
        (EditorView.findFromDOM as jest.Mock).mockImplementation(() => {
            throw new Error("missing CM");
        });
        let view = makeView(owner, {});

        expect(findEditorView(owner, makeApp([{ view: makeMdView(owner, view) }]))).toBe(view);
    });

    test("reading view: no markdown leaf contains the owner -> null", () => {
        (EditorView.findFromDOM as jest.Mock).mockReturnValue(null);
        let other = document.createElement("div");
        document.body.appendChild(other);
        let otherView = makeView(other, {});
        expect(findEditorView(owner, makeApp([{ view: makeMdView(other, otherView) }]))).toBeNull();
    });
});

describe("captureScrollAnchor", () => {
    let owner: HTMLElement;
    let container: HTMLElement;
    let doc: unknown;

    beforeEach(() => {
        owner = document.createElement("div");
        container = document.createElement("div");
        owner.appendChild(container);
        document.body.appendChild(owner);
        owner.scrollTop = 500;
        doc = {};
        (EditorView.findFromDOM as jest.Mock).mockReset();
        jest.spyOn(owner, "getBoundingClientRect").mockReturnValue({
            top: 100,
            left: 40,
            bottom: 1196,
            right: 740,
            width: 700,
            height: 1096,
            x: 40,
            y: 100,
            toJSON: () => ({}),
        } as DOMRect);
    });

    afterEach(() => {
        document.body.innerHTML = "";
        (EditorView.findFromDOM as jest.Mock).mockReset();
    });

    test("caret out of viewport -> viewport-top anchor (PRIMARY): posAtCoords at top+8, yMargin 8", () => {
        let view = makeView(owner, doc); // coordsAtPos -> null: caret not rendered
        (EditorView.findFromDOM as jest.Mock).mockReturnValue(view);

        let anchor = captureScrollAnchor(container, makeApp([]));

        expect(view.posAtCoords).toHaveBeenCalledWith({ x: 50, y: 108 }, false);
        expect(anchor).toEqual({
            owner,
            top: 500,
            view: asView(view),
            anchorPos: 77,
            anchorViewportY: 8,
            docAtCapture: asDoc(doc),
        });
    });

    test("caret visible -> caret anchor (refinement): anchorPos = head, yMargin = caret offset", () => {
        Object.defineProperty(owner, "clientHeight", { value: 1096, configurable: true });
        let view = makeView(owner, doc);
        view.coordsAtPos.mockReturnValue(makeRect(130, 60)); // caret 30px below the scroller top
        (EditorView.findFromDOM as jest.Mock).mockReturnValue(view);

        let anchor = captureScrollAnchor(container, makeApp([]));

        expect(anchor).toEqual({
            owner,
            top: 500,
            view: asView(view),
            anchorPos: 123,
            anchorViewportY: 30,
            docAtCapture: asDoc(doc),
        });
    });

    test("caret below the viewport -> refinement gate fails, viewport-top anchor wins", () => {
        Object.defineProperty(owner, "clientHeight", { value: 1096, configurable: true });
        let view = makeView(owner, doc);
        view.coordsAtPos.mockReturnValue(makeRect(1300, 60)); // 1200px below top > clientHeight + 4
        (EditorView.findFromDOM as jest.Mock).mockReturnValue(view);

        let anchor = captureScrollAnchor(container, makeApp([]));

        expect(view.posAtCoords).toHaveBeenCalledWith({ x: 50, y: 108 }, false);
        expect(anchor).toEqual({
            owner,
            top: 500,
            view: asView(view),
            anchorPos: 77,
            anchorViewportY: 8,
            docAtCapture: asDoc(doc),
        });
    });

    test("no view (reading view / unresolved) -> legacy pixel fields", () => {
        (EditorView.findFromDOM as jest.Mock).mockReturnValue(null);
        let other = document.createElement("div");
        let app = makeApp([{ view: makeMdView(other, makeView(other, {})) }]);

        expect(captureScrollAnchor(container, app)).toEqual({
            owner,
            top: 500,
            view: null,
            anchorPos: -1,
            anchorViewportY: 0,
            docAtCapture: null,
        });
    });

    test("state access throws mid-capture -> legacy pixel fields", () => {
        let view = makeView(owner, doc);
        Object.defineProperty(view.state, "selection", {
            get: () => {
                throw new Error("view died");
            },
        });
        (EditorView.findFromDOM as jest.Mock).mockReturnValue(view);

        expect(captureScrollAnchor(container, makeApp([]))).toEqual({
            owner,
            top: 500,
            view: null,
            anchorPos: -1,
            anchorViewportY: 0,
            docAtCapture: null,
        });
    });

    test("returns null when the view was not scrolled", () => {
        owner.scrollTop = 0;
        let view = makeView(owner, doc);
        (EditorView.findFromDOM as jest.Mock).mockReturnValue(view);

        expect(captureScrollAnchor(container, makeApp([]))).toBeNull();
    });
});

describe("planScrollRestore", () => {
    let owner: HTMLElement;
    let doc: unknown;
    let view: FakeView;

    beforeEach(() => {
        owner = document.createElement("div");
        document.body.appendChild(owner);
        doc = {};
        view = makeView(owner, doc);
    });

    afterEach(() => {
        document.body.innerHTML = "";
    });

    test("cm plan when the view's doc is unchanged", () => {
        let anchor: ScrollAnchor = {
            owner,
            top: 500,
            view: asView(view),
            anchorPos: 77,
            anchorViewportY: 8,
            docAtCapture: asDoc(doc),
        };
        expect(planScrollRestore(anchor, 1019, 1019)).toEqual({ kind: "cm", pos: 77, yMargin: 8 });
    });

    test("none when the doc changed during the refresh (user typed)", () => {
        view.state.doc = {};
        let anchor: ScrollAnchor = {
            owner,
            top: 500,
            view: asView(view),
            anchorPos: 77,
            anchorViewportY: 8,
            docAtCapture: asDoc(doc),
        };
        expect(planScrollRestore(anchor, 1019, 1019)).toEqual({ kind: "none" });
    });

    test("none when the no-view height delta is at least 4px", () => {
        let anchor: ScrollAnchor = {
            owner,
            top: 500,
            view: null,
            anchorPos: -1,
            anchorViewportY: 0,
            docAtCapture: null,
        };
        expect(planScrollRestore(anchor, 1019, 1030)).toEqual({ kind: "none" });
    });

    test("pixel plan when the no-view height delta is under 4px", () => {
        let anchor: ScrollAnchor = {
            owner,
            top: 500,
            view: null,
            anchorPos: -1,
            anchorViewportY: 0,
            docAtCapture: null,
        };
        expect(planScrollRestore(anchor, 1019, 1019)).toEqual({ kind: "pixel", top: 500 });
    });

    test("none for a top-0 capture, and for a null anchor", () => {
        let zero: ScrollAnchor = {
            owner,
            top: 0,
            view: asView(view),
            anchorPos: 77,
            anchorViewportY: 8,
            docAtCapture: asDoc(doc),
        };
        expect(planScrollRestore(zero, 100, 100)).toEqual({ kind: "none" });
        expect(planScrollRestore(null, 100, 100)).toEqual({ kind: "none" });
    });
});

describe("applyRestorePlan", () => {
    let owner: HTMLElement;
    let doc: unknown;
    let view: FakeView;

    beforeEach(() => {
        owner = document.createElement("div");
        document.body.appendChild(owner);
        doc = {};
        view = makeView(owner, doc);
    });

    afterEach(() => {
        document.body.innerHTML = "";
    });

    test("cm plan: scrollIntoView(pos, {y:'start', yMargin}) exactly once; returns post-write scrollTop", () => {
        let anchor: ScrollAnchor = {
            owner,
            top: 500,
            view: asView(view),
            anchorPos: 77,
            anchorViewportY: 8,
            docAtCapture: asDoc(doc),
        };
        owner.scrollTop = 999;

        let written = applyRestorePlan(anchor, { kind: "cm", pos: 77, yMargin: 8 });

        expect(view.scrollIntoView).toHaveBeenCalledTimes(1);
        expect(view.scrollIntoView).toHaveBeenCalledWith(77, { y: "start", yMargin: 8 });
        expect(written).toBe(999);
    });

    test("missing instance method (the seam) -> raw pixel fallback to the captured top", () => {
        let broken = { ...view, scrollIntoView: undefined } as unknown as FakeView;
        let anchor: ScrollAnchor = {
            owner,
            top: 500,
            view: asView(broken),
            anchorPos: 77,
            anchorViewportY: 8,
            docAtCapture: asDoc(doc),
        };
        owner.scrollTop = 0;

        let written = applyRestorePlan(anchor, { kind: "cm", pos: 77, yMargin: 8 });

        expect(owner.scrollTop).toBe(500); // commit-3 behavior
        expect(written).toBe(500);
    });

    test("pixel plan: writes the captured top and returns the achieved value", () => {
        let anchor: ScrollAnchor = {
            owner,
            top: 500,
            view: null,
            anchorPos: -1,
            anchorViewportY: 0,
            docAtCapture: null,
        };
        owner.scrollTop = 0;

        let written = applyRestorePlan(anchor, { kind: "pixel", top: 500 });

        expect(owner.scrollTop).toBe(500);
        expect(written).toBe(500);
    });

    test("none plan: no writes", () => {
        let anchor: ScrollAnchor = {
            owner,
            top: 500,
            view: asView(view),
            anchorPos: 77,
            anchorViewportY: 8,
            docAtCapture: asDoc(doc),
        };
        owner.scrollTop = 12;

        let written = applyRestorePlan(anchor, { kind: "none" });

        expect(owner.scrollTop).toBe(12);
        expect(written).toBeNull();
    });
});

describe("scheduleSettledRestore", () => {
    let owner: HTMLElement;
    let container: HTMLElement;
    let doc: unknown;
    let view: FakeView;
    let anchor: ScrollAnchor;
    let addSpy: jest.SpyInstance;

    /** The scroll listener the (last opened) window attached to the owner. */
    function latestScrollHandler(): (e: Event) => void {
        let calls = addSpy.mock.calls.filter(c => c[0] === "scroll");
        expect(calls.length).toBeGreaterThan(0);
        return calls[calls.length - 1][1] as (e: Event) => void;
    }

    /** Drives the scroll-event decision with a fake platform event payload. */
    function fire(handler: (e: Event) => void, isTrusted: boolean): void {
        handler({ isTrusted } as unknown as Event);
    }

    /** Advances to T1 (the double rAF after scheduling). */
    function toT1(): void {
        jest.advanceTimersByTime(64);
    }

    beforeEach(() => {
        jest.useFakeTimers();
        owner = document.createElement("div");
        container = document.createElement("div");
        owner.appendChild(container);
        document.body.appendChild(owner);
        owner.scrollTop = 500;
        doc = {};
        view = makeView(owner, doc);
        view.scrollIntoView.mockImplementation(() => {
            owner.scrollTop = 77; // the CM-owned write lands here
            return true;
        });
        (EditorView.findFromDOM as jest.Mock).mockReturnValue(view);
        anchor = { owner, top: 500, view: asView(view), anchorPos: 77, anchorViewportY: 8, docAtCapture: asDoc(doc) };
        addSpy = jest.spyOn(owner, "addEventListener");
    });

    afterEach(() => {
        jest.useRealTimers();
        document.body.innerHTML = "";
        (EditorView.findFromDOM as jest.Mock).mockReset();
    });

    test("T1: cm write via scrollIntoView, guard released before the write, window opens", () => {
        Object.defineProperty(container, "offsetHeight", { value: 240, configurable: true });
        let guard = beginHeightPreserve(container);
        expect(container.style.minHeight).toBe("240px");

        scheduleSettledRestore(anchor, guard, container);
        expect(view.scrollIntoView).not.toHaveBeenCalled(); // not before T1

        toT1();

        expect(container.style.minHeight).toBe(""); // guard released at T1, before the height read/write
        expect(view.scrollIntoView).toHaveBeenCalledTimes(1);
        expect(view.scrollIntoView).toHaveBeenCalledWith(77, { y: "start", yMargin: 8 });
        expect(owner.scrollTop).toBe(77);
        expect(latestScrollHandler()).toBeDefined(); // the re-assert window is watching the owner
    });

    test("untrusted off-target scroll -> re-assert once, target re-measured after the write", () => {
        scheduleSettledRestore(anchor, beginHeightPreserve(container), container);
        toT1();
        expect(owner.scrollTop).toBe(77);

        owner.scrollTop = 1418; // the +59ms-class keep-caret-visible overwrite
        fire(latestScrollHandler(), false);

        expect(view.scrollIntoView).toHaveBeenCalledTimes(2);
        expect(owner.scrollTop).toBe(77); // re-measured target after the re-assert write
    });

    test("untrusted on-target scroll (<= 4px) -> no re-assert", () => {
        scheduleSettledRestore(anchor, beginHeightPreserve(container), container);
        toT1();

        owner.scrollTop = 80; // within tolerance
        fire(latestScrollHandler(), false);

        expect(view.scrollIntoView).toHaveBeenCalledTimes(1);
    });

    test("trusted scroll -> window cancelled (never fight the user)", () => {
        scheduleSettledRestore(anchor, beginHeightPreserve(container), container);
        toT1();

        fire(latestScrollHandler(), true);
        owner.scrollTop = 999;
        fire(latestScrollHandler(), false); // the window is closed: no re-assert

        expect(view.scrollIntoView).toHaveBeenCalledTimes(1);
    });

    test("cap: at most 3 re-asserts, the 4th off-target event is ignored", () => {
        scheduleSettledRestore(anchor, beginHeightPreserve(container), container);
        toT1();

        for (let i = 0; i < 3; i++) {
            owner.scrollTop = 999;
            fire(latestScrollHandler(), false);
            expect(owner.scrollTop).toBe(77);
        }
        expect(view.scrollIntoView).toHaveBeenCalledTimes(4); // 1 primary + 3 re-asserts

        owner.scrollTop = 999;
        fire(latestScrollHandler(), false);
        expect(view.scrollIntoView).toHaveBeenCalledTimes(4); // cap: no 5th write
        expect(owner.scrollTop).toBe(999);
    });

    test("2s expiry closes the window", () => {
        scheduleSettledRestore(anchor, beginHeightPreserve(container), container);
        toT1();

        jest.advanceTimersByTime(2000);
        owner.scrollTop = 999;
        fire(latestScrollHandler(), false);

        expect(view.scrollIntoView).toHaveBeenCalledTimes(1);
    });

    test("doc change during the window -> cancel (user typed)", () => {
        scheduleSettledRestore(anchor, beginHeightPreserve(container), container);
        toT1();

        view.state.doc = {}; // a user edit replaced the doc
        owner.scrollTop = 999;
        fire(latestScrollHandler(), false);
        expect(view.scrollIntoView).toHaveBeenCalledTimes(1); // the re-check cancelled the window

        owner.scrollTop = 999;
        fire(latestScrollHandler(), false);
        expect(view.scrollIntoView).toHaveBeenCalledTimes(1);
    });

    test("supersede: a newer schedule on the same container cancels the earlier window", () => {
        scheduleSettledRestore(anchor, beginHeightPreserve(container), container);
        toT1();
        expect(view.scrollIntoView).toHaveBeenCalledTimes(1);
        let firstHandler = latestScrollHandler();

        let view2 = makeView(owner, doc);
        view2.scrollIntoView.mockImplementation(() => {
            owner.scrollTop = 55;
            return true;
        });
        let anchor2: ScrollAnchor = {
            owner,
            top: 600,
            view: asView(view2),
            anchorPos: 88,
            anchorViewportY: 3,
            docAtCapture: asDoc(doc),
        };
        scheduleSettledRestore(anchor2, beginHeightPreserve(container), container);
        toT1();
        expect(view2.scrollIntoView).toHaveBeenCalledTimes(1);

        // The first window is dead: its handler must no longer re-assert.
        owner.scrollTop = 999;
        fire(firstHandler, false);
        expect(view.scrollIntoView).toHaveBeenCalledTimes(1);
    });

    test("container detach -> cancel", () => {
        scheduleSettledRestore(anchor, beginHeightPreserve(container), container);
        toT1();

        container.remove();
        owner.scrollTop = 999;
        fire(latestScrollHandler(), false);

        expect(view.scrollIntoView).toHaveBeenCalledTimes(1);
    });

    test("no capture (null anchor): guard released at T1, no window", () => {
        Object.defineProperty(container, "offsetHeight", { value: 240, configurable: true });
        let guard = beginHeightPreserve(container);
        let cancel = scheduleSettledRestore(null, guard, container);

        toT1();

        expect(container.style.minHeight).toBe("");
        expect(addSpy.mock.calls.filter(c => c[0] === "scroll").length).toBe(0);
        expect(typeof cancel).toBe("function");
    });

    test("degraded mode (no view): raw pixel write at T1 + raw re-assert", () => {
        let pixelAnchor: ScrollAnchor = {
            owner,
            top: 500,
            view: null,
            anchorPos: -1,
            anchorViewportY: 0,
            docAtCapture: null,
        };

        scheduleSettledRestore(pixelAnchor, beginHeightPreserve(container), container);
        toT1();
        expect(owner.scrollTop).toBe(500); // raw pixel write (commit-3 behavior)

        owner.scrollTop = 999; // a late programmatic overwrite
        fire(latestScrollHandler(), false);
        expect(owner.scrollTop).toBe(500); // raw re-assert
    });
});
