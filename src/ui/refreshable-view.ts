import { FullIndex } from "data-index";
import { App, MarkdownRenderChild } from "obsidian";
import { DataviewSettings } from "settings";
import { beginHeightPreserve, captureViewScroll, restoreViewScroll } from "util/scroll";

/** Generic code for embedded Dataviews. */
export abstract class DataviewRefreshableRenderer extends MarkdownRenderChild {
    private lastReload: number;

    public constructor(
        public container: HTMLElement,
        public index: FullIndex,
        public app: App,
        public settings: DataviewSettings
    ) {
        super(container);
        this.lastReload = 0;
    }

    abstract render(): Promise<void>;

    onload() {
        this.render();
        this.lastReload = this.index.revision;
        // Refresh after index changes stop.
        this.registerEvent(this.app.workspace.on("dataview:refresh-views", this.maybeRefresh));
        // ...or when the DOM is shown (sidebar expands, tab selected, nodes scrolled into view).
        this.register(this.container.onNodeInserted(this.maybeRefresh));
    }

    maybeRefresh = () => {
        // If the index revision has changed recently, then queue a reload.
        // But only if we're mounted in the DOM and auto-refreshing is active.
        if (this.lastReload != this.index.revision && this.container.isShown() && this.settings.refreshEnabled) {
            this.lastReload = this.index.revision;
            // Preserve the user's scroll position across the async re-render (obsidian-dataview#2208).
            let captured = captureViewScroll(this.containerEl);
            // Hold the container's height BEFORE render() clears it, so the browser cannot clamp
            // the view's scroll while the content is collapsed.
            let guard = beginHeightPreserve(this.containerEl);
            this.render()
                .finally(() => guard.release())
                .then(() => restoreViewScroll(captured, guard.height, this.containerEl.offsetHeight));
        }
    };
}
