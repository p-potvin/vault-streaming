// web/devices.js — per-device settings and watch history for the web client (operator, Sat 21 Nov 2026).
//
// A device is its tailnet address. The web client is reached through greencloud's nginx, which admits only the
// tailnet (100.64.0.0/10) and passes the viewer's address as X-Real-IP; that header is trusted only when the request
// itself comes from greencloud or this machine. Requests from this machine without it (the desktop app's own data,
// a local browser) keep the shared files.
//
// Per device: the settings (get-settings / save-settings: language, subtitles, the Library…) and the watch history
// (watch-history:*), kept in <userData>/devices/<address>/ — the same file names as the shared ones, served by their
// own copy of src/watch-history.js. A device seen for the first time starts with a copy of the shared settings (they
// carry the service keys) and an empty history. Everything else (catalog, Moments, debrid, subtitles cache) stays
// shared.

const child_process = require('child_process');
const fs = require('fs');
const path = require('path');
const { IpcBridge } = require('./ipc-bridge');

const TRUSTED_PROXIES = new Set(['100.73.93.84', '127.0.0.1', '::1', '::ffff:127.0.0.1']);   // greencloud, loopback
const TAILNET = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/;              // 100.64.0.0/10
const PER_DEVICE = new Set(['get-settings', 'save-settings']);
const isPerDevice = (channel) => PER_DEVICE.has(channel) || channel.startsWith('watch-history:');

/** The device a request comes from ('' = this machine / shared data). */
function deviceOf(req) {
    const peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const forwarded = TRUSTED_PROXIES.has(peer) || TRUSTED_PROXIES.has(req.socket.remoteAddress)
        ? String(req.get('x-real-ip') || '').trim() : '';
    const ip = forwarded || peer;
    return TAILNET.test(ip) ? ip : '';
}

function createDevices({ userData, loadSharedSettings, envExtras }) {
    const root = path.join(userData, 'devices');
    const bridges = new Map();   // ip -> IpcBridge
    const names = new Map();     // ip -> tailnet machine name (for the log)

    function nameOf(ip) {
        if (names.has(ip)) return names.get(ip);
        names.set(ip, ip);
        try {
            const exe = process.platform === 'win32' ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : 'tailscale';
            const out = child_process.execFileSync(exe, ['whois', '--json', ip], { timeout: 5000, windowsHide: true });
            const who = JSON.parse(String(out));
            const n = (who.Node && (who.Node.ComputedName || who.Node.Name)) || ip;
            names.set(ip, String(n).replace(/\.$/, ''));
        } catch (_) { /* tailscale not answering: the address is the name */ }
        return names.get(ip);
    }

    function bridgeFor(ip) {
        if (bridges.has(ip)) return bridges.get(ip);
        const dir = path.join(root, ip.replace(/[^0-9.]/g, '_'));
        const settingsPath = path.join(dir, 'vault-settings.json');
        fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(settingsPath)) {
            // a new device: the shared settings (service keys, language), its own history from now on
            const shared = { ...loadSharedSettings() };
            delete shared.tmdbBearerToken;   // from the environment, re-added on every load
            fs.writeFileSync(settingsPath, JSON.stringify(shared, null, 2), 'utf8');
            console.log(`[web:devices] new device ${nameOf(ip)} (${ip}): settings copied, history starts empty`);
        }
        const loadSettings = () => {
            try { return { ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')), ...envExtras() }; }
            catch (_) { return { folders: [], ...envExtras() }; }
        };
        const saveSettings = async (s) => {
            try {
                const out = { ...s };
                delete out.tmdbBearerToken;
                await fs.promises.writeFile(settingsPath, JSON.stringify(out, null, 2), 'utf8');
                return true;
            } catch (e) { console.error(`[web:devices] ${ip}: settings not saved:`, e.message); return false; }
        };
        const bridge = new IpcBridge();
        bridge.ipcMain.handle('get-settings', () => loadSettings());
        bridge.ipcMain.handle('save-settings', async (_e, s) => saveSettings(s));
        // its own copy of the watch history module (the module keeps its file and cache in module state)
        const modPath = require.resolve('../src/watch-history');
        const shared = require.cache[modPath];
        delete require.cache[modPath];
        const history = require(modPath);
        if (shared) require.cache[modPath] = shared; else delete require.cache[modPath];
        history.registerWatchHistoryHandlers(bridge.ipcMain, { getPath: () => dir });
        bridge.flushHistory = history.flushNow;
        bridges.set(ip, bridge);
        console.log(`[web:devices] ${nameOf(ip)} (${ip}): ${dir}`);
        return bridge;
    }

    /** The bridge to run `channel` on for this request, or null for the shared one. */
    function route(req, channel) {
        if (!isPerDevice(channel)) return null;
        const ip = deviceOf(req);
        return ip ? bridgeFor(ip) : null;
    }

    function flushAll() {
        for (const b of bridges.values()) { try { b.flushHistory && b.flushHistory(); } catch (_) { } }
    }

    return { route, deviceOf, nameOf, flushAll };
}

module.exports = { createDevices, deviceOf, isPerDevice };
