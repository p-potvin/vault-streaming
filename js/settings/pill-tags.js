// js/settings/pill-tags.js - pill-tag widget for glob exclusion entry

// ── Pill-Tag system for Glob Exclusions ──────────────────────────────────
function pillTagGetValues() {
    return Array.from(document.querySelectorAll('#pill-tag-container-glob .pill-tag'))
        .map(p => p.dataset.value);
}

function pillTagAdd(val) {
    const v = val.trim().replace(/^,+|,+$/g, '').trim();
    if (!v) return;
    const existing = pillTagGetValues();
    if (existing.includes(v)) return;
    const pill = document.createElement('span');
    pill.className = 'pill-tag'; pill.dataset.value = v;
    pill.innerHTML = `${v}<button class="pill-tag-remove" title="Remove" tabindex="-1">&times;</button>`;
    pill.querySelector('.pill-tag-remove').addEventListener('click', (e) => {
        e.stopPropagation(); pill.remove();
    });
    const input = document.getElementById('pill-tag-input-glob');
    input.parentNode.insertBefore(pill, input);
}

function pillTagLoad(arr) {
    document.querySelectorAll('#pill-tag-container-glob .pill-tag').forEach(p => p.remove());
    (arr || []).forEach(v => pillTagAdd(v));
}
