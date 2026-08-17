// web/ipc-bridge.js — turns the Electron IPC surface into HTTP + SSE.
//
// The src/ modules all register their work as `ipcMain.handle(channel, fn)`.
// We hand them a fake ipcMain that records those handlers in a Map instead of
// wiring them to Electron, then dispatch into that Map from POST /api/invoke.
// Push channels (`event.sender.send(...)`) fan out over the caller's SSE stream.
//
// Net effect: src/ runs unmodified, and the browser sees the same async API the
// preload script exposed.

const { EventEmitter } = require('events');

// ── Buffer-safe JSON ────────────────────────────────────────────────────────
// Some channels carry raw media (transcode-chunk, upscale-chunk feed MediaSource).
// JSON.stringify turns a Buffer into {type:'Buffer',data:[...]}, one number per
// byte — a ~30x blowup. Encode as base64 with a marker and revive it to a
// Uint8Array in the browser, which is what appendBuffer wants anyway.
function encode(value) {
    return JSON.stringify(value, function (_key, val) {
        if (val && val.type === 'Buffer' && Array.isArray(val.data)) {
            return { __vwBuf: Buffer.from(val.data).toString('base64') };
        }
        return val;
    });
}

class IpcBridge {
    constructor() {
        this.handlers = new Map();
        this.bus = new EventEmitter();
        this.bus.setMaxListeners(0);
        // Channels whose desktop implementation can never complete headlessly.
        // They resolve to a structured refusal so the UI shows a message instead
        // of awaiting a promise that will never settle.
        this.unsupported = new Map([
            ['show-context-menu', null],
            ['dialog:openDirectory', { canceled: true, filePaths: [] }],
            ['open-file', { success: false, error: 'Opening files on the host is not available in the web client.' }],
            ['show-in-folder', { success: false, error: 'Revealing files on the host is not available in the web client.' }],
            ['library-export-backup', { success: false, error: 'Backup export runs on the desktop app only.' }],
            ['library-import-backup', { success: false, error: 'Backup import runs on the desktop app only.' }],
        ]);
    }

    // The object handed to registerXxxIpc(...) in place of Electron's ipcMain.
    get ipcMain() {
        const self = this;
        return {
            handle(channel, fn) { self.handlers.set(channel, fn); },
            handleOnce(channel, fn) { self.handlers.set(channel, fn); },
            removeHandler(channel) { self.handlers.delete(channel); },
            on() { },
            once() { },
            removeAllListeners() { },
        };
    }

    // Stand-in for the IpcMainInvokeEvent. `sender.send` is the only member src/
    // uses, and it becomes an SSE push aimed at the client that made the call.
    makeEvent(clientId) {
        const bus = this.bus;
        const sender = {
            send(channel, payload) { bus.emit('push', { clientId, channel, payload }); },
            isDestroyed: () => false,
            id: clientId,
        };
        return { sender, senderFrame: null, frameId: 0, processId: 0 };
    }

    async invoke(channel, args, clientId) {
        if (this.unsupported.has(channel)) {
            return { ok: true, result: this.unsupported.get(channel) };
        }
        const handler = this.handlers.get(channel);
        if (!handler) {
            return { ok: false, error: `No handler registered for IPC channel '${channel}'` };
        }
        try {
            const result = await handler(this.makeEvent(clientId), ...args);
            return { ok: true, result };
        } catch (err) {
            console.error(`[web:invoke] ${channel} failed:`, err);
            return { ok: false, error: err && err.message ? err.message : String(err) };
        }
    }

    // Attach an SSE response to a client id. Returns a detach function.
    subscribe(clientId, res) {
        const onPush = (msg) => {
            if (msg.clientId !== clientId) return;
            try {
                res.write(`event: ${msg.channel}\n`);
                res.write(`data: ${encode(msg.payload === undefined ? null : msg.payload)}\n\n`);
            } catch (_) { /* client vanished mid-write; the close handler cleans up */ }
        };
        this.bus.on('push', onPush);
        return () => this.bus.off('push', onPush);
    }

    channels() {
        return [...this.handlers.keys()].sort();
    }
}

module.exports = { IpcBridge, encode };
