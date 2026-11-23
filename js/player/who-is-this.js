// js/player/who-is-this.js — "who is this" on the paused frame (vault-raggae semantic plan section 3.5).
//
// One small button among the right-hand controls, shown only while a catalog title streams. A click pauses the video,
// reads the frame (the window's canvas, else ffmpeg in the main process when the source is cross-origin), and asks
// vault-raggae (POST /v1/faces/who) who the faces are: the ColONEL-KFC Celebrities gallery, scored against the playing
// title's cast first. Each face found gets a thin box and its name (and role) on the picture; a face no one matches
// gets a box only. Playing again, Escape or a click on the picture clears it. Nothing is kept.

(function () {
    let reqId = 0;

    function media() {
        const m = window.activeStreamingMedia;
        return m && m.tmdbId ? m : null;
    }

    function els() {
        return { box: el('who-container'), btn: el('btn-who'), layer: el('who-overlay'), vp: el('video-player') };
    }

    /** The frame as a base64 JPEG from a canvas, or null when the video is cross-origin (a tainted canvas). */
    function canvasFrame(vp) {
        if (!vp || !vp.videoWidth || !vp.videoHeight) return null;
        try {
            const c = document.createElement('canvas');
            c.width = vp.videoWidth;
            c.height = vp.videoHeight;
            c.getContext('2d').drawImage(vp, 0, 0, c.width, c.height);
            return c.toDataURL('image/jpeg', 0.92);
        } catch (_) {
            return null;
        }
    }

    /** Where the picture sits inside the <video> box (object-fit: contain leaves bars). */
    function contentRect(vp, w, h) {
        const bw = vp.clientWidth, bh = vp.clientHeight;
        const s = Math.min(bw / w, bh / h);
        return { left: vp.offsetLeft + (bw - w * s) / 2, top: vp.offsetTop + (bh - h * s) / 2, scale: s };
    }

    function clear() {
        const { layer, btn } = els();
        reqId++;
        if (layer) { layer.innerHTML = ''; layer.style.display = 'none'; }
        if (btn) btn.classList.remove('active');
    }

    function note(text) {
        const { layer } = els();
        if (!layer) return;
        layer.innerHTML = '';
        const n = document.createElement('div');
        n.className = 'who-note';
        n.textContent = text;
        layer.append(n);
        layer.style.display = 'block';
    }

    function draw(res) {
        const { layer, vp } = els();
        if (!layer || !vp) return;
        layer.innerHTML = '';
        const w = res.width || vp.videoWidth, h = res.height || vp.videoHeight;
        if (!w || !h) return;
        const r = contentRect(vp, w, h);
        const room = layer.clientHeight || vp.clientHeight;
        let named = 0;
        for (const f of res.faces) {
            const [x1, y1, x2, y2] = f.bbox;
            const box = document.createElement('div');
            // a name under the threshold (a credited cast member close to it) is shown as a guess: dashed, with "?"
            const maybe = !!f.name && !f.match;
            box.className = 'who-face' + (f.name ? ' named' : '') + (maybe ? ' maybe' : '');
            Object.assign(box.style, {
                left: `${r.left + x1 * r.scale}px`, top: `${r.top + y1 * r.scale}px`,
                width: `${(x2 - x1) * r.scale}px`, height: `${(y2 - y1) * r.scale}px`,
            });
            if (f.name) {
                named++;
                const tag = document.createElement('div');
                // a face at the bottom of the picture gets its name above it: below, the wrapper would clip it
                const below = r.top + y2 * r.scale + 48 > room;
                tag.className = 'who-tag' + (below ? ' above' : '') + (maybe ? ' maybe' : '');
                if (f.picture) {
                    const img = document.createElement('img');
                    img.src = f.picture;
                    img.alt = '';
                    img.onerror = () => img.remove();
                    tag.append(img);
                }
                const text = document.createElement('span');
                const who = document.createElement('b');
                who.textContent = f.name;
                text.append(who);
                if (f.character) {
                    const role = document.createElement('small');
                    role.textContent = f.character;
                    text.append(role);
                }
                tag.append(text);
                tag.title = maybe ? tr('whoProbably', "Probably: close to a member of this title's cast")
                    : f.inCast ? tr('whoInCast', 'In the cast of this title')
                        : tr('whoFromGallery', 'Recognised from the face gallery');
                box.append(tag);
            }
            layer.append(box);
        }
        if (!res.faces.length) note(tr('whoNoFace', 'No face found in this frame.'));
        else if (!named) {
            const n = document.createElement('div');
            n.className = 'who-note';
            n.textContent = tr('whoNobody', 'No one recognised (the face gallery does not know everyone yet).');
            layer.append(n);
        }
        layer.style.display = 'block';
    }

    async function ask() {
        const { vp, btn } = els();
        const m = media();
        if (!vp || !m || !window.electronAPI || !window.electronAPI.whoIsThis) return;
        if (!vp.paused) vp.pause();
        const id = ++reqId;
        if (btn) btn.classList.add('active');
        note(tr('whoLooking', 'Looking…'));
        const image = canvasFrame(vp);
        let res = null;
        try {
            res = await window.electronAPI.whoIsThis({
                // on the web build a Comet stream plays through a same-origin wrapper (web-overrides.js) that may
                // redirect; ffmpeg has no cookie for it, so it reads the source the wrapper keeps
                image, url: image ? null : vp._vwSourceUrl || vp.currentSrc || vp.src, t: vp.currentTime,
                tmdbId: m.tmdbId, mediaType: m.mediaType, season: m.season, episode: m.episode,
            });
        } catch (_) { res = null; }
        if (id !== reqId) return;
        if (!res || !res.success) {
            note(res && res.error === 'no-frame' ? tr('whoNoFrame', 'This frame could not be read.')
                : tr('whoUnreachable', 'The catalog did not answer. Try again in a moment.'));
            return;
        }
        draw(res);
    }

    /** Shown only while a catalog title streams; anything drawn goes when the picture moves on. */
    function refresh() {
        const { box } = els();
        if (box) box.style.display = media() ? '' : 'none';
        clear();
    }

    function wire() {
        const { btn, layer, vp } = els();
        if (!btn || !layer || !vp) return;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (layer.style.display === 'block') clear(); else ask();
        });
        layer.addEventListener('click', (e) => { e.stopPropagation(); clear(); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && layer.style.display === 'block') { e.stopPropagation(); clear(); }
        }, true);
        ['play', 'seeking', 'loadstart', 'emptied'].forEach(ev => vp.addEventListener(ev, refresh));
        window.addEventListener('resize', clear);
        refresh();
    }

    window.whoIsThisRefresh = refresh;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})();
