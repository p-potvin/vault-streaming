// js/tooltip.js - Centralized Windows-style tooltip system using event delegation.

document.addEventListener('DOMContentLoaded', () => {
    let tooltipEl = document.getElementById('win-tooltip');
    if (!tooltipEl) {
        tooltipEl = document.createElement('div');
        tooltipEl.id = 'win-tooltip';
        tooltipEl.className = 'win-tooltip-hidden';
        tooltipEl.setAttribute('aria-hidden', 'true');
        document.body.appendChild(tooltipEl);
    }

    let activeTarget = null;
    let pendingTarget = null;
    let showTimeout = null;
    let mouseMoveHideTimeout = null;
    let suppressedTitleTarget = null;
    let suppressedTitle = '';
    let lastPointerX = 0;
    let lastPointerY = 0;

    const getTooltipText = (target) => {
        return target.getAttribute('data-tooltip') || target.getAttribute('title') || '';
    };

    const suppressNativeTitle = (target) => {
        const title = target.getAttribute('title');
        if (!title) return;

        suppressedTitleTarget = target;
        suppressedTitle = title;
        target.setAttribute('data-tooltip-native-title', title);
        target.removeAttribute('title');
    };

    const restoreNativeTitle = () => {
        if (!suppressedTitleTarget) return;

        if (!suppressedTitleTarget.hasAttribute('title')) {
            suppressedTitleTarget.setAttribute('title', suppressedTitle);
        }
        suppressedTitleTarget.removeAttribute('data-tooltip-native-title');
        suppressedTitleTarget = null;
        suppressedTitle = '';
    };

    const showTooltip = (target) => {
        const text = getTooltipText(target);
        if (!text) return;

        if (showTimeout) clearTimeout(showTimeout);
        restoreNativeTitle();
        suppressNativeTitle(target);
        pendingTarget = target;

        showTimeout = setTimeout(() => {
            if (pendingTarget !== target || !target.matches(':hover')) {
                hideTooltip();
                return;
            }

            tooltipEl.textContent = text;
            tooltipEl.classList.remove('win-tooltip-hidden');
            tooltipEl.classList.add('win-tooltip-visible');
            tooltipEl.setAttribute('aria-hidden', 'false');
            activeTarget = target;
            pendingTarget = null;
            positionTooltip(target);
        }, 400);
    };

    const hideTooltip = () => {
        if (showTimeout) clearTimeout(showTimeout);
        showTimeout = null;
        if (mouseMoveHideTimeout) clearTimeout(mouseMoveHideTimeout);
        mouseMoveHideTimeout = null;
        tooltipEl.classList.remove('win-tooltip-visible');
        tooltipEl.classList.add('win-tooltip-hidden');
        tooltipEl.setAttribute('aria-hidden', 'true');
        activeTarget = null;
        pendingTarget = null;
        restoreNativeTitle();
    };

    const debounceMouseMoveHide = () => {
        if (mouseMoveHideTimeout) clearTimeout(mouseMoveHideTimeout);
        mouseMoveHideTimeout = setTimeout(() => {
            mouseMoveHideTimeout = null;
            hideTooltip();
        }, 50);
    };

    const positionTooltip = (target) => {
        if (!activeTarget || !tooltipEl.classList.contains('win-tooltip-visible')) return;

        const targetRect = target.getBoundingClientRect();
        const tooltipWidth = tooltipEl.offsetWidth || 120;
        const tooltipHeight = tooltipEl.offsetHeight || 28;

        let left = targetRect.left + (targetRect.width - tooltipWidth) / 2;
        let top = targetRect.top - tooltipHeight - 6;

        if (top < 8) {
            top = targetRect.bottom + 6;
        }

        if (left < 8) {
            left = 8;
        }

        if (left + tooltipWidth > window.innerWidth - 8) {
            left = window.innerWidth - tooltipWidth - 8;
        }

        if (top + tooltipHeight > window.innerHeight - 8) {
            top = window.innerHeight - tooltipHeight - 8;
        }

        tooltipEl.style.left = `${left + window.scrollX}px`;
        tooltipEl.style.top = `${top + window.scrollY}px`;
    };

    document.body.addEventListener('mouseover', (e) => {
        const target = e.target.closest('[data-tooltip], [title]');
        if (target && target !== activeTarget) {
            showTooltip(target);
        }
    });

    document.body.addEventListener('mouseout', (e) => {
        const currentTarget = activeTarget || pendingTarget;
        if (currentTarget) {
            const relatedTarget = e.relatedTarget;
            if (!relatedTarget || (!currentTarget.contains(relatedTarget) && relatedTarget !== currentTarget)) {
                debounceMouseMoveHide();
            }
        }
    });

    document.body.addEventListener('mousemove', (e) => {
        const moved = Math.abs(e.clientX - lastPointerX) > 1 || Math.abs(e.clientY - lastPointerY) > 1;
        lastPointerX = e.clientX;
        lastPointerY = e.clientY;

        if (activeTarget && moved) {
            debounceMouseMoveHide();
        }
    });

    window.addEventListener('resize', () => {
        hideTooltip();
    });

    document.addEventListener('scroll', () => {
        hideTooltip();
    }, true);
});
