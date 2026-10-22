/**
 * Durable plugin data: the saved-workflow library and the generated-asset
 * index, both persisted as JSON files under the plugin data directory
 * (`dataDir`, default DSH_HOME/data/dsh-comfyui). ComfyUI's own history is
 * ephemeral, so the asset index is the plugin's memory of what it generated.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
/** Trailing newline for the JSON files this store writes. */
const NEWLINE = '\n';
/** Validate a workflow-shaped value; returns an error message or undefined. */
export function validateWorkflow(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return 'workflow must be an object mapping node id → { class_type, inputs }';
    }
    const entries = Object.entries(value);
    if (entries.length === 0)
        return 'workflow must contain at least one node';
    for (const [id, node] of entries) {
        if (typeof node !== 'object' || node === null)
            return `node "${id}" must be an object`;
        const record = node;
        if (typeof record.class_type !== 'string' || record.class_type === '') {
            return `node "${id}" needs a non-empty class_type`;
        }
        if (typeof record.inputs !== 'object' || record.inputs === null) {
            return `node "${id}" needs an inputs object`;
        }
    }
    return undefined;
}
function sanitizeText(value, max) {
    return typeof value === 'string' ? value.slice(0, max) : '';
}
async function readJsonFile(path, fallback) {
    try {
        const parsed = JSON.parse(await readFile(path, 'utf8'));
        return parsed;
    }
    catch {
        return fallback;
    }
}
/** JSON-file-backed store for workflows and assets. */
export class ComfyUIStore {
    maxAssets;
    workflowsPath;
    assetsPath;
    trackedPath;
    mediaSizesPath;
    mediaHashesPath;
    currentImagePath;
    /** Root of the per-workflow skill packs (one directory per pack). */
    skillsRoot;
    constructor(dir, maxAssets) {
        this.maxAssets = maxAssets;
        this.skillsRoot = join(dir, 'skills');
        this.workflowsPath = join(dir, 'workflows.json');
        this.assetsPath = join(dir, 'assets.json');
        this.trackedPath = join(dir, 'tracked.json');
        this.mediaSizesPath = join(dir, 'media-sizes.json');
        this.mediaHashesPath = join(dir, 'media-hashes.json');
        this.currentImagePath = join(dir, 'current-image.json');
    }
    /** Ensure the data directory exists. */
    async init() {
        await mkdir(dirname(this.workflowsPath), { recursive: true });
    }
    /** Pixel sizes of files uploaded through the panel, keyed by file name —
     * used to default the workflow output size to the source image. */
    async loadMediaSizes() {
        const parsed = await readJsonFile(this.mediaSizesPath, {});
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
    }
    async saveMediaSize(name, size) {
        const sizes = await this.loadMediaSizes();
        sizes[name] = size;
        await writeFile(this.mediaSizesPath, `${JSON.stringify(sizes, null, 2)}\n`, 'utf8');
    }
    /** Content-hash → file name index: re-uploading identical bytes reuses the
     * existing file instead of creating a duplicate. */
    async loadMediaHashes() {
        const parsed = await readJsonFile(this.mediaHashesPath, {});
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
    }
    async lookupMediaHash(hash) {
        return (await this.loadMediaHashes())[hash];
    }
    async saveMediaHash(hash, name) {
        const hashes = await this.loadMediaHashes();
        hashes[hash] = name;
        await writeFile(this.mediaHashesPath, `${JSON.stringify(hashes, null, 2)}\n`, 'utf8');
    }
    /** The load-area slots: an ordered list where each entry is either a picked
     * file or `null` for an empty slot the user added but has not filled yet.
     * Slot 0 is the primary source (the big preview, and the default source
     * image for image-to-image).
     *
     * The file held a single `{name,kind,source}` object before the load area
     * had more than one slot; that shape is still read and lifted into a
     * one-slot list, so an existing selection survives the upgrade. */
    async loadSlots() {
        const parsed = await readJsonFile(this.currentImagePath, undefined);
        if (typeof parsed !== 'object' || parsed === null)
            return [];
        const raw = Array.isArray(parsed.items)
            ? parsed.items
            : [parsed];
        const slots = [];
        for (const entry of raw) {
            if (entry === null) {
                slots.push(null);
                continue;
            }
            if (typeof entry !== 'object')
                continue;
            const { name, kind, source } = entry;
            if (typeof name !== 'string' || name === '') {
                slots.push(null);
                continue;
            }
            slots.push({
                name,
                kind: kind === 'video' || kind === 'audio' ? kind : 'image',
                source: source === 'generated' ? 'generated' : 'imported',
            });
        }
        return slots;
    }
    async saveSlots(slots) {
        await writeFile(this.currentImagePath, JSON.stringify({ items: slots }, null, 2) + NEWLINE, 'utf8');
    }
    async listWorkflows() {
        const list = await readJsonFile(this.workflowsPath, []);
        return Array.isArray(list) ? list : [];
    }
    async getWorkflow(id) {
        return (await this.listWorkflows()).find((workflow) => workflow.id === id);
    }
    async writeWorkflows(list) {
        await writeFile(this.workflowsPath, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
    }
    /** Create or update a workflow (update when `input.id` matches an existing one). */
    async saveWorkflow(input) {
        const problem = validateWorkflow(input.workflow);
        if (problem !== undefined)
            return { ok: false, error: problem };
        const name = sanitizeText(input.name, 80) || 'unnamed-workflow';
        const description = sanitizeText(input.description, 2000);
        const workflow = input.workflow;
        const parameters = Array.isArray(input.parameters) && input.parameters.length > 0 ? input.parameters : undefined;
        const tags = Array.isArray(input.tags)
            ? [...new Set(input.tags.map((tag) => sanitizeText(tag, 24)).filter((tag) => tag !== ''))]
            : undefined;
        const now = new Date().toISOString();
        const list = await this.listWorkflows();
        if (input.id !== undefined) {
            const index = list.findIndex((entry) => entry.id === input.id);
            if (index === -1)
                return { ok: false, error: `workflow "${input.id}" not found` };
            const updated = {
                ...list[index], name, description, workflow,
                parameters,
                tags: tags !== undefined ? tags : list[index].tags,
                // Skill-pack fields are owned by the skill routes, not the workflow
                // editor: a plain save must never drop a pack the user attached.
                skillDir: list[index].skillDir,
                requireSkill: list[index].requireSkill,
                source: input.source ?? list[index].source,
                comfyuiFile: input.comfyuiFile ?? list[index].comfyuiFile,
                updatedAt: now,
            };
            list[index] = updated;
            await this.writeWorkflows(list);
            return { ok: true, workflow: updated };
        }
        const created = {
            id: randomUUID(), name, description, workflow,
            parameters,
            tags: tags !== undefined && tags.length > 0 ? tags : undefined,
            source: input.source,
            comfyuiFile: input.comfyuiFile,
            updatedAt: now,
        };
        list.push(created);
        await this.writeWorkflows(list);
        return { ok: true, workflow: created };
    }
    /** Patch the skill-pack fields of one workflow without touching its JSON or
     * parameters. `skillDir: null` detaches the pack (the directory stays on
     * disk until an explicit destroy). */
    async updateWorkflowSkill(id, patch) {
        const list = await this.listWorkflows();
        const index = list.findIndex((entry) => entry.id === id);
        if (index === -1)
            return undefined;
        const current = list[index];
        const next = { ...current, updatedAt: new Date().toISOString() };
        if (patch.skillDir !== undefined) {
            if (patch.skillDir === null) {
                delete next.skillDir;
                delete next.requireSkill;
            }
            else {
                next.skillDir = patch.skillDir;
            }
        }
        if (patch.requireSkill !== undefined) {
            if (patch.requireSkill)
                next.requireSkill = true;
            else
                delete next.requireSkill;
        }
        list[index] = next;
        await this.writeWorkflows(list);
        return next;
    }
    /** Delete a workflow by id; false when it did not exist. */
    async deleteWorkflow(id) {
        const list = await this.listWorkflows();
        const next = list.filter((entry) => entry.id !== id);
        if (next.length === list.length)
            return false;
        await this.writeWorkflows(next);
        return true;
    }
    async listAssets() {
        const list = await readJsonFile(this.assetsPath, []);
        return Array.isArray(list) ? list : [];
    }
    /** Prepend an asset record (deduplicated by promptId, capped at maxAssets). */
    /** Drop one asset record from the index; returns the record that was
     * removed so the caller can delete the files it referenced. */
    async deleteAsset(promptId) {
        const list = await this.listAssets();
        const index = list.findIndex((record) => record.promptId === promptId);
        if (index === -1)
            return undefined;
        const [removed] = list.splice(index, 1);
        await writeFile(this.assetsPath, JSON.stringify(list, null, 2) + NEWLINE, 'utf8');
        return removed;
    }
    async appendAsset(record) {
        const list = await this.listAssets();
        if (list.some((entry) => entry.promptId === record.promptId))
            return;
        list.unshift(record);
        if (list.length > this.maxAssets)
            list.length = this.maxAssets;
        await writeFile(this.assetsPath, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
    }
    /** Load the persisted queue-tracker state (empty when absent/corrupt). */
    async loadTracked() {
        const data = await readJsonFile(this.trackedPath, {});
        const runs = Array.isArray(data.runs) ? data.runs.filter((run) => typeof run === 'object' && run !== null && typeof run.promptId === 'string')
            : [];
        const archived = Array.isArray(data.archived) ? data.archived.filter((id) => typeof id === 'string') : [];
        return { runs, archived };
    }
    /** Persist the queue-tracker state so completed runs survive restarts. */
    async saveTracked(state) {
        await writeFile(this.trackedPath, `${JSON.stringify(state)}\n`, 'utf8');
    }
}
