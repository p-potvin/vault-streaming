# Agent Ledger

## 2026-05-28

- **Goal:** Secure the application against shell command injection vulnerabilities.
- **Decision:** Replaced all instances of `child_process.exec` in `main.js` with `child_process.execFile`.
- **Context:** The `exec` function spawns a shell, which interprets shell metacharacters. If unvalidated file paths are interpolated into the string command, they could be crafted to execute arbitrary commands. Using `execFile` passes arguments safely in an array directly to the executable, avoiding the shell interpreter entirely.
- **Affected Components:** `get-everything-size` IPC handler and `ffmpeg` queue execution (`generate-webm` handler, `processFfmpegQueue`, and `runPreviewFfmpeg`).

## 2026-05-29

- **Goal:** Improve UX and accessibility for empty states.
- **Decision:** Added context-aware Call-to-Action (CTA) buttons ("Browse Vault" or "Clear Filters") and `aria-hidden="true"` attributes to decorative SVGs in the empty states.
- **Context:** Empty states previously only provided textual guidance which required users to hunt for the correct UI element (e.g., the toolbar button). Placing direct, actionable buttons contextually improves usability. Additionally, decorative images like the empty state SVGs should explicitly be hidden from screen readers to reduce noise.
- **Affected Components:** `index.html` static empty state, and dynamic empty state generation within the `applyFilters` JavaScript function.

## 2026-05-08

- **Goal:** Secure the application against shell command injection vulnerabilities and introduce initial feature scaffolding.
- **Decision:** Replaced `child_process.exec` with `child_process.execFile` in `scripts/generate_webm.js`. Deleted insecure `test-exec.js`. Added `upscale-video` IPC handler scaffolding and context menu item in `main.js`.
- **Context:** `generate_webm.js` contained a shell injection vulnerability due to string concatenation in `exec` calls involving unescaped file paths. Refactored to use `execFile` with argument arrays. Deleted `test-exec.js` which was an insecure test script. Added a mock `upscale-video` IPC handler and wired it to the context menu to provide a foundation for future development, adhering to the strategy of identifying and preparing unfinished features.
- **Affected Components:** `scripts/generate_webm.js`, `test-exec.js`, `main.js`.

## 2026-05-16

- **Goal:** Improve micro-UX interactions focusing on accessibility and state validation.
- **Decision:** Added dynamic disabled states with informative tooltips for the "Create Folder" button. Fixed focus visibility for custom checkboxes and keyboard access for the volume slider. Added hover tooltips to modal close buttons.
- **Context:** These small enhancements target pain points such as users clicking inactive buttons without knowing why they are disabled, keyboard users being unable to see their selection focus due to overlapping 0-opacity elements, and hidden child controls not revealing on focus-within. All of these improve the application's overall accessibility score and UX.
- **Affected Components:** `index.html` (CSS focus states, tooltip attributes, JS event listeners for the fake folder dialog).

## 2026-05-16

- **Goal:** Improve dialog keyboard accessibility and focus management.
- **Decision:** Added appropriate ARIA attributes (`aria-haspopup`, `aria-expanded`, `role="dialog"`) to the Theme Picker panel and button. Implemented focus restoration logic for when the Theme Picker or Fake Folder dialogs are closed via Escape key or Cancel buttons.
- **Context:** Custom modals or dialogs implemented in DOM without native `<dialog>` tags require manual focus trapping and restoration to ensure screen reader users and keyboard navigators do not lose context when a dialog is dismissed. By restoring focus back to the triggering element (e.g., `#theme-trigger` or `#btn-new-folder`), the user experience remains coherent.
- **Affected Components:** `index.html` (Theme Picker HTML, Fake Folder dialog logic, global Escape key listener).

## 2024-05-16 (UX Improvements)

- **Goal:** Improve explicit focus management for custom modal interactions.
- **Decision:** Added `tabindex="-1"` to the Video Player Modal, explicit `.focus()` call when opening it, and implemented focus restoration to the triggering `.file-card` when the modal is closed.
- **Context:** Custom modals that appear over the main content must explicitly shift focus into themselves when opened, otherwise keyboard users will remain focused on the background grid behind the modal overlay. Similarly, when the modal is closed, returning focus to the element that triggered it (the clicked video card) prevents the user's position in the list from being lost.
- **Affected Components:** `index.html` (Video modal HTML, `playItem` function, modal close handlers).

## 2026-05-16

- **Goal:** Fix CRITICAL DOM XSS vulnerability in file card generation and synchronize project features.
- **Decision:** Implement an `escapeHtml` utility in `index.html` to sanitize dynamically injected strings before `innerHTML` assignment. Update `README.md` to reflect recently added features.
- **Context:** The `createCardElement` function injects unescaped file names into HTML, creating a DOM XSS vulnerability if malicious file names are encountered. Escaping ensures the integrity of the UI. Additionally, we are synchronizing recent feature additions (accessibility, theming, upscaling scaffolding) into the project documentation.
- **Affected Components:** `index.html`, `README.md`.

## 2026-05-17

- **Goal:** Execute Ziegler routine for feature synchronization and AI upscaling scaffolding.
- **Decision:** Updated `README.md` to reflect recently completed features found in the ledger. Replaced the error return in the `upscale-video` IPC handler in `main.js` with a mock async timeout returning success, providing scaffolding for future ML integration.
- **Context:** Following the daily Ziegler routine, project documentation must stay synchronized with completed features (accessibility, focus management, empty states). Additionally, scanning the codebase revealed the `upscale-video` feature was unfinished. Providing a mock async scaffold prepares the architecture for task delegation (e.g., to the `kraftwerk` agent) without breaking the current UI.
- **Affected Components:** `README.md`, `main.js`.

## 2026-05-17

- **Goal:** Improve UX and accessibility by surfacing keyboard shortcut hints.
- **Decision:** Updated search box placeholder to include "(Ctrl/Cmd+F)" and added a `keydown` listener to handle the shortcut for cross-platform discoverability. Appended the learning to `.Jules/palette.md`.
- **Context:** Power-user features triggered exclusively by keyboard shortcuts are effectively invisible to standard users unless explicitly surfaced in the UI. Exposing shortcuts like Ctrl/Cmd+F improves discoverability and provides a smoother interaction without additional clicks.
- **Affected Components:** `index.html` (search input placeholder, global keydown listener), `.Jules/palette.md`.

## 2026-05-17

- **Goal:** Update webSecurity configuration and fix ReDoS/unintended rename vulnerability. Synchronize features to README.
- **Decision:** Updated `README.md` to reflect recently completed features (AI upscaling scaffolding, dialog focus management, dynamic empty states, keyboard shortcuts). Changed `webSecurity: false` to `true` in `main.js`. Escaped user input `oldBase` before passing it to `new RegExp` in the `rename-file` IPC handler. Recorded learnings in `.jules/ziegler.md`.
- **Context:** Following the daily Ziegler routine and security focus, project documentation must stay synchronized with completed features. `webSecurity: false` disables the same-origin policy, leading to a critical security vulnerability. Escaping user input in regular expressions prevents Regular Expression Denial of Service (ReDoS) and incorrect file modifications when file names include regex metacharacters.
- **Affected Components:** `README.md`, `main.js`, `.jules/ziegler.md`.

## 2026-05-27

- **Goal:** Modernize Vault Explorer inline UI elements under VaultWares Revisited standards.
- **Decision:** Replaced all legacy emoji icons in the Movies & Series tab, streaming details modals, Real-Debrid dialog loaders, and Torrentio scrape status indicators with unified revisited SVG components. Downloaded and cached local high-fidelity favicons (IMDb, Apple TV, JustWatch) in the root to bypass external service load times and maintain visual aesthetics.
- **Context:** Emojis do not align with the professional HUD-style, crisp technical design system of VaultWares. The revisited component library defines exact stroke, size, and state-based coloring tokens which have been fully integrated.
- **Affected Components:** `index.html` (Streaming tab icon, Play/YouTube actions, backdrop layouts), `js/streaming.js` (Scraping/No sources SVG feedback, external watch badges with cached favicon rendering), `js/app.js` (Real-Debrid unrestrict loading, progress download bar header, and workflow error indicators).
