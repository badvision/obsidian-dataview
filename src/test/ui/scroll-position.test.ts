/** Tests for preserving user scroll position across Dataview re-renders (obsidian-dataview#2208). */
import { App, Vault } from "obsidian";
import { h } from "preact";
import { DEFAULT_SETTINGS } from "settings";
import { ReactRenderer, useIndexBackedState } from "ui/markdown";
import { FullIndex } from "data-index";
import { DataviewRefreshableRenderer } from "ui/refreshable-view";
import { DataviewJSRenderer } from "ui/views/js-view";
import { DataviewApi } from "api/plugin-api";
import { asyncEvalInContext } from "api/inline-api";
import { captureViewScroll, restoreViewScroll, CapturedScroll } from "util/scroll";

jest.mock("api/inline-api", () => ({
    asyncEvalInContext: jest.fn(),
    DataviewInlineApi: class {},
}));

// Jest's jsdom environment resolves preact's "browser" export condition to the ESM build,
// which the CJS runtime cannot parse. Pin the CJS builds (relative paths bypass package exports).
jest.mock("preact", () => require("../../../node_modules/preact/dist/preact.js"));
jest.mock("preact/hooks", () => require("../../../node_modules/preact/hooks/dist/hooks.js"));
jest.mock("preact/compat", () => require("../../../node_modules/preact/compat/dist/compat.js"));

/** Resolves on the next animation frame, so rAF-deferred writes have been applied. */
function nextFrame(): Promise<void> {
    return new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

describe("captureViewScroll", () => {
    let outer: HTMLElement;
    let mid: HTMLElement;
    let leaf: HTMLElement;

    beforeEach(() => {
        outer = document.createElement("div");
        mid = document.createElement("div");
        leaf = document.createElement("div");
        outer.appendChild(mid);
        mid.appendChild(leaf);
        document.body.appendChild(outer);
    });

    afterEach(() => {
        document.body.innerHTML = "";
    });

    test("finds the nearest scrolled ancestor", () => {
        mid.scrollTop = 500;
        outer.scrollTop = 100;

        let captured = captureViewScroll(leaf);
        expect(captured).toEqual({ el: mid, top: 500 });
    });

    test("returns null when no ancestor is scrolled", () => {
        expect(captureViewScroll(leaf)).toBeNull();
    });

    test("falls back to the .view-content element when the walk finds nothing", () => {
        // The container itself is the view content (e.g. the inline render container);
        // closest() includes the element itself, so the fallback recovers it.
        leaf.className = "view-content";
        leaf.scrollTop = 42;

        let captured = captureViewScroll(leaf);
        expect(captured).toEqual({ el: leaf, top: 42 });
    });
});

describe("restoreViewScroll", () => {
    let owner: HTMLElement;

    beforeEach(() => {
        owner = document.createElement("div");
        document.body.appendChild(owner);
    });

    afterEach(() => {
        document.body.innerHTML = "";
    });

    test("restores the captured top after a requestAnimationFrame", async () => {
        owner.scrollTop = 0;
        let captured: CapturedScroll = { el: owner, top: 250 };

        restoreViewScroll(captured);
        expect(owner.scrollTop).toBe(0); // not yet: the write is rAF-deferred

        await nextFrame();
        expect(owner.scrollTop).toBe(250);
    });

    test("is a no-op for a null capture", async () => {
        restoreViewScroll(null);
        await nextFrame();
        expect(owner.scrollTop).toBe(0);
    });

    test("is a no-op when the captured top is zero", async () => {
        owner.scrollTop = 99; // stale value; a top-0 capture must not clobber anything
        restoreViewScroll({ el: owner, top: 0 });
        await nextFrame();
        expect(owner.scrollTop).toBe(99);
    });

    test("restores two independent views to their own owners", async () => {
        let ownerB = document.createElement("div");
        let leafA = document.createElement("div");
        let leafB = document.createElement("div");
        owner.appendChild(leafA);
        ownerB.appendChild(leafB);
        document.body.appendChild(ownerB);

        owner.scrollTop = 100;
        ownerB.scrollTop = 200;
        let capturedA = captureViewScroll(leafA);
        let capturedB = captureViewScroll(leafB);
        expect(capturedA).toEqual({ el: owner, top: 100 });
        expect(capturedB).toEqual({ el: ownerB, top: 200 });

        owner.scrollTop = 0;
        ownerB.scrollTop = 0;
        restoreViewScroll(capturedA);
        restoreViewScroll(capturedB);
        await nextFrame();

        expect(owner.scrollTop).toBe(100);
        expect(ownerB.scrollTop).toBe(200);
    });
});

describe("DataviewRefreshableRenderer scroll preservation", () => {
    function setup() {
        let viewContent = document.createElement("div");
        viewContent.className = "view-content";
        document.body.appendChild(viewContent);
        let container = document.createElement("div");
        viewContent.appendChild(container);
        let workspace = new Vault();
        let app = { workspace } as unknown as App;
        let index = { revision: 1 } as FullIndex;
        return { viewContent, container, workspace, app, index, settings: DEFAULT_SETTINGS };
    }

    afterEach(() => {
        document.body.innerHTML = "";
        jest.restoreAllMocks();
    });

    test("preserves the view scroll position across an async re-render", async () => {
        let { viewContent, container, workspace, app, index, settings } = setup();

        class TestRenderer extends DataviewRefreshableRenderer {
            renders = 0;
            async render() {
                // Mimic DataviewJSRenderer: clear, then rebuild asynchronously.
                this.container.innerHTML = "";
                this.renders++;
                await Promise.resolve();
                this.container.appendChild(document.createElement("div"));
            }
        }

        let renderer = new TestRenderer(container, index, app, settings);
        renderer.onload();
        expect(renderer.renders).toBe(1);

        // The user has scrolled the leaf view, then the index updates.
        viewContent.scrollTop = 800;
        index.revision = 2;
        workspace.trigger("dataview:refresh-views");

        // The browser synchronously clamps scrollTop to 0 while the content is collapsed.
        viewContent.scrollTop = 0;
        await Promise.resolve();
        await Promise.resolve();
        expect(renderer.renders).toBe(2);
        expect(viewContent.scrollTop).toBe(0); // content rebuilt, but the restore is still deferred

        await nextFrame();
        expect(viewContent.scrollTop).toBe(800);
    });

    test("leaves the scroll position alone when the view was not scrolled", async () => {
        let { viewContent, container, workspace, app, index, settings } = setup();

        class TestRenderer extends DataviewRefreshableRenderer {
            async render() {
                this.container.innerHTML = "";
                await Promise.resolve();
            }
        }

        let renderer = new TestRenderer(container, index, app, settings);
        renderer.onload();

        viewContent.scrollTop = 0;
        index.revision = 2;
        workspace.trigger("dataview:refresh-views");
        await Promise.resolve();
        await Promise.resolve();
        await nextFrame();

        expect(viewContent.scrollTop).toBe(0);
    });

    test("preserves scroll for DataviewJSRenderer refreshes", async () => {
        let { viewContent, container, workspace, app, index, settings } = setup();
        let jsSettings = { ...settings, enableDataviewJs: true };
        let api = { index, app, settings: jsSettings } as unknown as DataviewApi;

        let renderer = new DataviewJSRenderer(api, 'dv.view("text", "hello")', container, "test.md");
        renderer.onload();
        expect(asyncEvalInContext).toHaveBeenCalledTimes(1);

        viewContent.scrollTop = 500;
        index.revision = 2;
        workspace.trigger("dataview:refresh-views");
        viewContent.scrollTop = 0;
        await Promise.resolve();
        await Promise.resolve();
        expect(asyncEvalInContext).toHaveBeenCalledTimes(2);
        expect(viewContent.scrollTop).toBe(0);

        await nextFrame();
        expect(viewContent.scrollTop).toBe(500);
    });

    test("double refresh in flight restores to the user's latest position", async () => {
        let { viewContent, container, workspace, app, index, settings } = setup();

        class RacyRenderer extends DataviewRefreshableRenderer {
            async render() {
                this.container.innerHTML = "";
                for (let i = 0; i < 3; i++) await Promise.resolve();
                this.container.appendChild(document.createElement("div"));
            }
        }

        let renderer = new RacyRenderer(container, index, app, settings);
        renderer.onload();
        await new Promise<void>(resolve => setTimeout(resolve, 0));

        // First refresh: user scrolled to 300.
        viewContent.scrollTop = 300;
        index.revision = 2;
        workspace.trigger("dataview:refresh-views");

        // Second refresh fires while render #1 is still in flight: user has moved to 700.
        viewContent.scrollTop = 700;
        index.revision = 3;
        workspace.trigger("dataview:refresh-views");

        // The browser clamps the scroll while the content is collapsed.
        viewContent.scrollTop = 0;
        await new Promise<void>(resolve => setTimeout(resolve, 0));

        // Both deferred restores queue for the same frame (FIFO); the fresher capture lands last.
        await nextFrame();
        expect(viewContent.scrollTop).toBe(700);
    });
});

describe("useIndexBackedState (DQL) scroll preservation", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        jest.restoreAllMocks();
    });

    test("preserves the scroll position across a DQL refresh", async () => {
        let viewContent = document.createElement("div");
        viewContent.className = "view-content";
        document.body.appendChild(viewContent);
        let container = document.createElement("div");
        viewContent.appendChild(container);
        let index = { revision: 1 } as FullIndex;
        let vault = new Vault();
        let app = {
            workspace: {
                on: vault.on.bind(vault),
                trigger: vault.trigger.bind(vault),
                offref: () => {},
            },
        } as unknown as App;

        let computed = 0;
        function DqlView() {
            let value = useIndexBackedState<string>(container, app, DEFAULT_SETTINGS, index, "", async () => {
                await Promise.resolve();
                computed++;
                return "v" + index.revision;
            });
            return h("span", { class: "dql" }, value);
        }

        let renderer = new ReactRenderer({ app, index, settings: DEFAULT_SETTINGS, container }, h(DqlView, {}));
        renderer.onload();
        // Let preact effects register the refresh handlers and the initial compute settle.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        expect(computed).toBe(1);
        expect(container.querySelector(".dql")?.textContent).toBe("v1");

        // The user scrolls the leaf view, then the index updates.
        viewContent.scrollTop = 900;
        index.revision = 2;
        app.workspace.trigger("dataview:refresh-views");

        // The browser synchronously clamps scrollTop to 0 while the content is collapsed.
        viewContent.scrollTop = 0;
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        expect(computed).toBe(2);
        expect(container.querySelector(".dql")?.textContent).toBe("v2");
        expect(viewContent.scrollTop).toBe(0); // content rebuilt; the restore is still frame-deferred

        await nextFrame();
        expect(viewContent.scrollTop).toBe(900);

        renderer.onunload();
    });
});
