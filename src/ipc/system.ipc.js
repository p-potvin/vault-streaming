// system.ipc.js — handles settings, themes, clipboard, external shells, and native context menus.

const { Menu, BrowserWindow, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { safeOpenFile } = require('./files.ipc');

function registerSystemIpc(ipcMain, settingsPath, loadSettings, saveSettings) {
    // Settings Settings
    ipcMain.handle('get-settings', () => loadSettings());
    ipcMain.handle('save-settings', async (_e, s) => { return await saveSettings(s); });

    // Themes
    ipcMain.handle('get-theme', async () => {
        const appSettings = loadSettings();
        return { success: true, theme: appSettings.theme || 'golden-slate' };
    });
    ipcMain.handle('set-theme', async (_event, theme) => {
        if (typeof theme !== 'string') return { success: false, error: 'Invalid input' };
        const appSettings = loadSettings();
        appSettings.theme = theme;
        await saveSettings(appSettings);
        return { success: true };
    });

    // Clipboard
    ipcMain.handle('copy-to-clipboard', (_event, text) => {
        console.log('[system.ipc:clipboard] Copying text');
        clipboard.writeText(text);
    });

    // External URL
    ipcMain.handle('open-external-url', async (_event, url) => {
        if (typeof url === 'string') {
            await shell.openExternal(url);
            return { success: true };
        }
        return { success: false, error: 'Invalid URL' };
    });

    // Context Menus
    ipcMain.handle('show-context-menu', async (event, item) => {
        return new Promise((resolve) => {
            let resolved = false;
            const once = (val) => { if (!resolved) { resolved = true; resolve(val); } };
            let templ = [];
            
            const folderSubmenu = (item.folders && item.folders.length > 0)
                ? item.folders.map(f => ({
                    label: f.label || f.name,
                    click: () => once(`add-to-folder:${f.id || f.name}`)
                  }))
                : [{ label: 'No virtual folders created', enabled: false }];
            
            if (item.isMultiSelect) {
                const selected = item.selectedItems || [];
                const hasVideo = selected.some(s => s.type === 'video');
                const hasEncrypted = selected.some(s => s.path && s.path.toLowerCase().endsWith('.enc'));
                const hasNonEncrypted = selected.some(s => s.path && !s.path.toLowerCase().endsWith('.enc'));
                const hasEnhanced = selected.some(s => s.enhancedPath || (s.enhancements && (s.enhancements.audio || s.enhancements.video || s.enhancements.subtitles || s.enhancements.translation)));
 
                const aiSubmenu = [];
                if (hasVideo) {
                    aiSubmenu.push(
                        { label: 'Enhance Audio for Selection 🪄', click: () => once('normalize-audio') },
                        { label: 'Generate Subtitles for Selection', click: () => once('generate-subtitles-prompt') },
                        { label: 'Translate Selection Video Tracks', click: () => once('translate-video-prompt') },
                        { label: 'Enhance Selection Videos 🪄', click: () => once('enhance-video-prompt') }
                    );
                    if (hasEnhanced) {
                        aiSubmenu.push(
                            { type: 'separator' },
                            { label: '    Revert Enhancements', click: () => once('revert-enhancements') }
                        );
                    }
                }
 
                templ = [
                    { label: 'Add to Favorites', click: () => once('toggle-favorite') },
                    { label: 'Add Selection to Virtual Folder', submenu: folderSubmenu },
                    { type: 'separator' },
                    { label: 'Cut Selection', click: () => once('cut') },
                    { label: 'Copy Selection', click: () => once('copy') },
                ];

                if (hasVideo) {
                    templ.push({ label: 'Generate Previews', click: () => once('generate-webm') });
                }

                if (aiSubmenu.length > 0) {
                    templ.push({ type: 'separator' });
                    templ.push({ label: 'AI Enhancements 🪄', submenu: aiSubmenu });
                }

                templ.push({ type: 'separator' });

                if (hasNonEncrypted) {
                    templ.push({ label: 'Encrypt Selection', click: () => once('encrypt-prompt') });
                }
                if (hasEncrypted) {
                    templ.push({ label: 'Decrypt Selection', click: () => once('decrypt-prompt') });
                }

                templ.push(
                    { label: 'Zip Selection', click: () => once('zip-selection') },
                    { label: 'Delete Selection', click: () => once('delete-item') }
                );
            } else if (item.type === 'video' || item.type === 'image' || item.type === 'other' || item.type === 'encrypted') {
                const isEnc = typeof item.path === 'string' && item.path.toLowerCase().endsWith('.enc');
                const hasEnhanced = item.enhancedPath;
                const hasAudioEnh = item.enhancements && item.enhancements.audio;
                const hasVideoEnh = item.enhancements && item.enhancements.video;
                const hasSubs = item.enhancements && item.enhancements.subtitles && item.enhancements.subtitles.length > 0;
                const hasTrans = item.enhancements && item.enhancements.translation && item.enhancements.translation.length > 0;

                const aiSubmenu = [];
                if (item.type === 'video' || (item.type === 'encrypted' && !isEnc)) {
                    aiSubmenu.push(
                        { label: 'Enhance Audio 🪄', type: 'checkbox', checked: !!hasAudioEnh, click: () => once('normalize-audio') },
                        { label: 'Generate Subtitles', type: 'checkbox', checked: !!hasSubs, click: () => once('generate-subtitles-prompt') },
                        { label: 'Translate this video', type: 'checkbox', checked: !!hasTrans, click: () => once('translate-video-prompt') },
                        { label: 'Enhance Video 🪄', type: 'checkbox', checked: !!hasVideoEnh, click: () => once('enhance-video-prompt') }
                    );
                    if (hasEnhanced) {
                        aiSubmenu.push(
                            { type: 'separator' },
                            { label: '    Revert Enhancements', click: () => once('revert-enhancements') }
                        );
                    }
                }

                templ = [
                    {
                        label: 'Open File', click: () => {
                            safeOpenFile(item.path)
                                .then(() => once('opened'))
                                .catch(() => once('open-error'));
                        }
                    },
                    { label: 'Show in Windows Explorer', click: () => { shell.showItemInFolder(item.path); once('show'); } },
                    { label: item.isFavorite ? 'Remove from Favorites' : 'Add to Favorites', click: () => once('toggle-favorite') },
                    { label: 'Add to Virtual Folder', submenu: folderSubmenu },
                    { type: 'separator' },
                    { label: 'Copy Path', click: () => { clipboard.writeText(item.path); once('copied'); } },
                    { label: 'Cut', click: () => once('cut') },
                    { label: 'Copy', click: () => once('copy') },
                    { label: 'Rename', click: () => once('rename') }
                ];

                const hasAiOrPreview = (aiSubmenu.length > 0) || (item.type === 'video' || (item.type === 'encrypted' && !isEnc));
                if (hasAiOrPreview) {
                    templ.push({ type: 'separator' });
                    if (aiSubmenu.length > 0) {
                        templ.push({ label: 'AI Enhancements 🪄', submenu: aiSubmenu });
                    }
                    if (item.type === 'video' || (item.type === 'encrypted' && !isEnc)) {
                        templ.push({ label: 'Generate Preview', click: () => once('generate-webm') });
                    }
                }

                templ.push(
                    { type: 'separator' },
                    isEnc ? { label: 'Decrypt File', click: () => once('decrypt-prompt') }
                        : { label: 'Encrypt File', click: () => once('encrypt-prompt') },
                    { label: 'Zip Selection', click: () => once('zip-selection') },
                    { label: 'Delete', click: () => once('delete-item') },
                    { type: 'separator' },
                    { label: 'Properties', click: () => once('properties') }
                );
            } else if (item.type === 'fakeFolder') {
                templ = [
                    { label: `Open Folder: ${item.name}`, click: () => once('open-folder') },
                    { type: 'separator' },
                    { label: 'Rename Folder', click: () => once('rename') },
                    { label: 'Paste into Folder', enabled: item._hasClipboard === true, click: () => once('paste-into-folder') },
                    { type: 'separator' },
                    { label: 'Remove Folder', click: () => once('remove-folder') }
                ];
            } else if (item.type === 'background') {
                templ = [
                    { label: 'Paste', enabled: item._hasClipboard === true, click: () => once('paste') },
                    { type: 'separator' },
                    { label: 'Refresh', click: () => once('bg-refresh') },
                    { label: 'Select All', click: () => once('bg-select-all') },
                    { type: 'separator' },
                    { label: 'New Virtual Folder…', click: () => once('bg-new-folder') },
                ];
            } else if (item.type === 'videoPlayer') {
                const isLocal = !item.isStreaming;
                const aiSubmenu = isLocal ? [
                    { label: 'Enhance Audio 🪄', click: () => once('normalize-audio') },
                    { label: 'Generate Subtitles', click: () => once('generate-subtitles-prompt') },
                    { label: 'Translate this video', click: () => once('translate-video-prompt') },
                    { label: 'Enhance Video 🪄', click: () => once('enhance-video-prompt') }
                ] : [];
                templ = [
                    { label: item.isPlaying ? 'Pause' : 'Play', click: () => once('play-pause') },
                    { label: item.isMuted ? 'Unmute' : 'Mute', click: () => once('mute') },
                    { type: 'separator' },
                    { label: 'Playback Speed', submenu: [
                        { label: '0.5x', type: 'radio', checked: item.speed === 0.5, click: () => once('speed:0.5') },
                        { label: '0.75x', type: 'radio', checked: item.speed === 0.75, click: () => once('speed:0.75') },
                        { label: 'Normal', type: 'radio', checked: !item.speed || item.speed === 1, click: () => once('speed:1') },
                        { label: '1.25x', type: 'radio', checked: item.speed === 1.25, click: () => once('speed:1.25') },
                        { label: '1.5x', type: 'radio', checked: item.speed === 1.5, click: () => once('speed:1.5') },
                        { label: '2x', type: 'radio', checked: item.speed === 2, click: () => once('speed:2') }
                    ]},
                    { label: 'Picture-in-Picture', click: () => once('pip') },
                    { label: 'Fullscreen', click: () => once('fullscreen') },
                    { type: 'separator' }
                ];
                if (aiSubmenu.length > 0) {
                    templ.push({ label: 'AI Enhancements 🪄', submenu: aiSubmenu });
                }
                if (isLocal) {
                    templ.push(
                        { label: 'Generate Preview', click: () => once('generate-webm') },
                        { type: 'separator' },
                        { label: 'Show in Windows Explorer', click: () => { shell.showItemInFolder(item.path); once('show'); } },
                        { label: 'Copy Path', click: () => { clipboard.writeText(item.path); once('copied'); } }
                    );
                } else {
                    templ.push(
                        { type: 'separator' },
                        { label: 'Copy Stream URL', click: () => { clipboard.writeText(item.path || ''); once('copied'); } }
                    );
                }
                if (isLocal) {
                    templ.push(
                        { type: 'separator' },
                        { label: 'Properties', click: () => once('properties') }
                    );
                }
            }
            const menu = Menu.buildFromTemplate(templ);
            menu.popup({ window: BrowserWindow.fromWebContents(event.sender) });
            menu.once('menu-will-close', () => { setTimeout(() => once('closed'), 50); });
        });
    });
}

module.exports = {
    registerSystemIpc
};
