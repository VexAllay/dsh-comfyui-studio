/**
 * Live generation progress, fed by ComfyUI's WebSocket. The server broadcasts
 * `progress` events ({value, max, node, prompt_id}) to every connected client,
 * so one shared socket tracks progress for all queue tasks — including ones
 * the plugin did not submit. Progress is best-effort: a remote server behind
 * an authenticating proxy (or one that never connects) simply shows queue
 * tasks without a progress bar. Reconnects on drop until dispose.
 */
export class ProgressTracker {
    progress = new Map();
    socket = null;
    retryTimer = null;
    stopped = true;
    /** Current progress for one prompt, if the server reported any. */
    get(promptId) {
        return this.progress.get(promptId);
    }
    /** Start listening on the server's /ws endpoint. Idempotent per url. */
    attach(wsUrl) {
        this.stopped = false;
        this.connect(wsUrl);
    }
    connect(wsUrl) {
        if (this.stopped)
            return;
        let socket;
        try {
            socket = new WebSocket(wsUrl);
        }
        catch {
            this.scheduleRetry(wsUrl);
            return;
        }
        this.socket = socket;
        socket.addEventListener('message', (event) => this.onMessage(event.data));
        socket.addEventListener('close', () => {
            if (this.socket === socket)
                this.socket = null;
            this.scheduleRetry(wsUrl);
        });
        socket.addEventListener('error', () => {
            try {
                socket.close();
            }
            catch {
                // close already in flight
            }
        });
    }
    onMessage(data) {
        let message = null;
        try {
            message = JSON.parse(String(data));
        }
        catch {
            return;
        }
        if (message?.type !== 'progress' || !isObject(message.data))
            return;
        const promptId = message.data.prompt_id;
        const value = message.data.value;
        const max = message.data.max;
        if (typeof promptId !== 'string' || promptId === '' || typeof value !== 'number' || typeof max !== 'number')
            return;
        this.progress.set(promptId, {
            value,
            max,
            node: typeof message.data.node === 'number' ? message.data.node : null,
        });
    }
    scheduleRetry(wsUrl) {
        if (this.stopped || this.retryTimer !== null)
            return;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.connect(wsUrl);
        }, 3_000);
    }
    dispose() {
        this.stopped = true;
        if (this.retryTimer !== null) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        if (this.socket !== null) {
            try {
                this.socket.close();
            }
            catch {
                // already closed
            }
            this.socket = null;
        }
    }
}
function isObject(value) {
    return typeof value === 'object' && value !== null;
}
