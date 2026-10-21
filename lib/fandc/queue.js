/**
 * Queue tracking: remembers every prompt this plugin queued (from tools or
 * the panel) so the panel can show "ours" in the ComfyUI queue and move
 * completed runs into the asset index. Sweeps run on read (queue/assets
 * routes), so no background timers leak into the fiber lifecycle.
 */
import { collectMedia, hasMedia } from './comfyui.js';
/** Upper bound on remembered runs; oldest are dropped beyond this. */
const MAX_TRACKED_RUNS = 500;
/** Tracks queued prompts until they complete or vanish. */
export class QueueTracker {
    persisted;
    runs = new Map();
    /** Prompt ids already swept into the asset index, so sweep is idempotent. */
    archived = new Set();
    /**
     * Optional durable backing: the tracked memory is persisted so completed
     * runs still land in the asset index after a web-server restart.
     */
    constructor(persisted) {
        this.persisted = persisted;
    }
    /** Restore persisted runs/archived state; call once before tracking. */
    async init() {
        if (this.persisted === undefined)
            return;
        const state = await this.persisted.load();
        for (const run of state.runs) {
            this.runs.set(run.promptId, {
                promptId: run.promptId,
                ts: run.ts,
                workflowName: run.workflowName,
                source: run.source,
            });
        }
        for (const id of state.archived)
            this.archived.add(id);
    }
    /** Fire-and-forget persistence; failures must not break queueing. */
    persistNow() {
        if (this.persisted === undefined)
            return;
        const state = {
            runs: [...this.runs.values()],
            archived: [...this.archived],
        };
        void this.persisted.save(state).catch(() => undefined);
    }
    track(run) {
        this.runs.set(run.promptId, run);
        this.persistNow();
    }
    untrack(promptId) {
        this.runs.delete(promptId);
        this.persistNow();
    }
    get(promptId) {
        return this.runs.get(promptId);
    }
    list() {
        return [...this.runs.values()];
    }
    /**
     * Move completed tracked runs into the asset store. Runs already archived
     * are skipped; failed runs stay tracked so their task rows keep a name.
     * @returns the records newly appended.
     */
    async sweep(opts) {
        const completed = [];
        for (const run of [...this.runs.values()]) {
            if (this.archived.has(run.promptId))
                continue;
            const entry = await opts.client.getHistory(run.promptId).catch(() => undefined);
            if (entry === undefined)
                continue;
            if (isCompleted(entry)) {
                const media = collectMedia({ promptId: run.promptId, entry, maxItems: opts.maxItems, proxyBase: opts.proxyBase });
                const record = {
                    promptId: run.promptId,
                    ts: run.ts,
                    workflowName: run.workflowName,
                    source: run.source,
                    media,
                };
                await opts.store.appendAsset(record);
                completed.push(record);
                this.archived.add(run.promptId);
            }
        }
        if (this.runs.size > MAX_TRACKED_RUNS) {
            const oldest = this.runs.keys().next().value;
            if (oldest !== undefined)
                this.runs.delete(oldest);
        }
        this.persistNow();
        return completed;
    }
}
function isCompleted(entry) {
    return entry.status?.status_str === 'success'
        || entry.status?.completed === true
        || hasMedia(entry);
}
