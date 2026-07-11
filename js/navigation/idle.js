// idle.js — after 60s of inactivity, crawl the current folder for videos missing
// hover-WebM previews and generate them 10 at a time, staggered 2 minutes apart.
//
// Guardrails against the old "spam" behaviour:
//   • Batches are awaited (not fired blindly), so we know each one's outcome.
//   • If a whole batch produces zero previews, generation stops — those files
//     are almost certainly unprocessable, and retrying them every cycle was the
//     source of the endless FAILED loop.
//   • Files that fail individually are remembered and never re-queued.
//   • On success we update window.allItems so a finished video isn't seen as
//     "missing" again (the per-card DOM refresh is handled by app.js).

(function() {
    const IDLE_MS = 60000;
    const BATCH_INTERVAL_MS = 120000; // 2 minutes between batches
    const BATCH_SIZE = 10;

    let idleTimeout = null;
    let nextBatchTimeout = null;
    let isIdle = false;
    let running = false;

    // Paths that already failed once — excluded from future batches so we don't
    // burn cycles re-encoding files that can't be processed.
    const failedPaths = new Set();

    function stopRunner() {
        if (nextBatchTimeout) {
            clearTimeout(nextBatchTimeout);
            nextBatchTimeout = null;
        }
        isIdle = false;
    }

    function findMissingPreviews() {
        const all = Array.isArray(window.allItems) ? window.allItems : [];
        return all
            .filter(item => item && item.type === 'video' && !item.hoverWebm && item.path && !failedPaths.has(item.path))
            .sort((a, b) => {
                const ta = a.modified ? new Date(a.modified).getTime() : 0;
                const tb = b.modified ? new Date(b.modified).getTime() : 0;
                return tb - ta; // newest first
            });
    }

    // Mark a video as having a preview in the in-memory model so it isn't picked
    // up as "missing" on the next crawl. The visible card is refreshed by app.js
    // via the per-video generate-webm-progress event.
    function markPreviewReady(path, hoverWebm) {
        const stamp = (arr) => {
            if (!Array.isArray(arr)) return;
            const it = arr.find(i => i && i.path === path);
            if (it) it.hoverWebm = hoverWebm;
        };
        stamp(window.allItems);
        stamp(window.displayedItems);
    }

    function scheduleNextBatch() {
        if (nextBatchTimeout) clearTimeout(nextBatchTimeout);
        nextBatchTimeout = setTimeout(runBatch, BATCH_INTERVAL_MS);
    }

    async function runBatch() {
        if (!isIdle || running) return;

        const missing = findMissingPreviews();
        if (missing.length === 0) {
            console.log('[Idle Previews] No videos missing previews. Idle runner stopped.');
            stopRunner();
            return;
        }

        const batch = missing.slice(0, BATCH_SIZE);
        console.log(`[Idle Previews] Generating batch of ${batch.length} preview(s).`);
        running = true;
        let result = null;
        try {
            result = await window.electronAPI.generateIdlePreviewBatch(batch);
        } catch (e) {
            console.error('[Idle Previews] Batch call failed:', e && e.message);
        }
        running = false;

        console.log('[Idle Previews] Batch result:', result
            ? { succeeded: result.succeeded, failed: result.failed, skipped: result.skipped,
                results: (result.results || []).map(r => ({ file: (r.path || '').split(/[\\/]/).pop(), success: r.success, reason: r.reason })) }
            : null);

        if (!isIdle) return; // user became active mid-batch

        // Cloud-backed folder or no usable result — don't keep trying.
        if (!result || result.skipped) {
            console.log('[Idle Previews] Batch skipped/unavailable. Idle runner stopped.');
            stopRunner();
            return;
        }

        // Refresh only the targeted files that now have previews.
        for (const r of (result.results || [])) {
            if (r.success && r.hoverWebm) {
                markPreviewReady(r.path, r.hoverWebm);
            } else if (!r.success) {
                failedPaths.add(r.path);
            }
        }

        // Hard stop: a batch that produced nothing means these files can't be
        // processed — bail instead of spamming the same failures next cycle.
        if ((result.succeeded || 0) === 0) {
            console.warn('[Idle Previews] Batch produced no previews — stopping idle generation.');
            stopRunner();
            return;
        }

        // Some succeeded — continue after the 2-minute stagger if work remains.
        if (findMissingPreviews().length > 0) {
            scheduleNextBatch();
        } else {
            console.log('[Idle Previews] All videos have previews. Idle runner stopped.');
            stopRunner();
        }
    }

    function startRunner() {
        stopRunner();
        isIdle = true;
        runBatch(); // first batch immediately, then staggered
    }

    function resetIdleTimer() {
        clearTimeout(idleTimeout);
        stopRunner();
        idleTimeout = setTimeout(() => {
            if (window.currentTab === 'files') {
                console.log('[Idle Previews] User idle 60s. Starting preview crawl.');
                startRunner();
            }
        }, IDLE_MS);
    }

    // Bind event listeners for user activity
    window.addEventListener('mousemove', resetIdleTimer);
    window.addEventListener('keydown', resetIdleTimer);
    window.addEventListener('click', resetIdleTimer);
    window.addEventListener('scroll', resetIdleTimer);

    // Initial start
    resetIdleTimer();
})();
