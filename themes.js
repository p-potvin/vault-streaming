/* VaultWares Theme Library — canonical data
   --------------------------------------------------------------------------
   Each theme satisfies the VaultTheme schema (see AGENTS.md):
     name, mode,
     primary, surface, surface_alt,
     accent, accent_muted,
     text, text_muted, text_inverse,
     border (rgba), muted,
     error, error_bg, warning, warning_bg,
     success, success_bg, info, info_bg.

   Color harmony rules per AGENTS.md:
     - error ≈ analogous (warm theme) or complementary (cool theme) of accent
     - warning ≈ amber, sits between accent and error on the hue wheel
     - success ≈ mid-saturation green/teal
     - info     ≈ calm blue or violet
     - *_bg     ≈ 12–15% alpha of the corresponding semantic color
     - muted    ≈ desaturated by 30–40%
   ------------------------------------------------------------------------- */

window.VAULT_THEMES = [
  {
    id: "vaultwares-revisited-console",
    name: "Console",
    mode: "dark",
    inspiredBy: "VaultWares Revisited",
    family: "Revisited",
    primary:      "#0b0813",
    surface:      "#13101c",
    surface_alt:  "#2A2340",
    accent:       "#B07CFF",
    accent_muted: "#614d8a",
    text:         "#fff",
    text_muted:   "#a394cc",
    text_inverse: "#0b0813",
    border:       "rgba(255,255,255,0.06)",
    muted:        "#453763",
    error:        "#FF6B7A",
    error_bg:     "rgba(255,107,122,0.13)",
    warning:      "#F0B94B",
    warning_bg:   "rgba(240,185,75,0.14)",
    success:      "#6BE675",
    success_bg:   "rgba(107,230,117,0.13)",
    info:         "#4173d6",
    info_bg:      "rgba(65,115,214,0.13)",
  },
  {
    id: "vaultwares-revisited-warm",
    name: "Warm",
    mode: "light",
    inspiredBy: "VaultWares Revisited",
    family: "Revisited",
    primary:      "#F5F1E8",
    surface:      "#FCFAF5",
    surface_alt:  "#ECE5D8",
    accent:       "#D6A441",
    accent_muted: "#B78C1E",
    text:         "#161320",
    text_muted:   "rgba(22, 19, 32, 0.6)",
    text_inverse: "#F5F1E8",
    border:       "rgba(22, 19, 32, 0.08)",
    muted:        "#ECE5D8",
    error:        "#FF6B7A",
    error_bg:     "rgba(255,107,122,0.13)",
    warning:      "#F0B94B",
    warning_bg:   "rgba(240,185,75,0.14)",
    success:      "#6BE675",
    success_bg:   "rgba(107,230,117,0.13)",
    info:         "#4173d6",
    info_bg:      "rgba(65,115,214,0.13)",
  }
];

window.VAULT_THEME_BY_ID = Object.fromEntries(window.VAULT_THEMES.map(t => [t.id, t]));

/* ──────────────────────────────────────────────────────────────────────────
   applyVaultTheme — set every VaultTheme key as a CSS custom property on
   the given root (defaults to <html>). Also stamps data-theme=<id> and
   data-theme-mode=<light|dark> for selector-based fallbacks.
   ────────────────────────────────────────────────────────────────────────── */

window.applyVaultTheme = function (id, root) {
  const t = window.VAULT_THEME_BY_ID[id];
  if (!t) {
    console.warn("Unknown VaultTheme id:", id);
    return null;
  }
  const el = root || document.documentElement;
  const keys = [
    "primary", "surface", "surface_alt",
    "accent",  "accent_muted",
    "text",    "text_muted", "text_inverse",
    "border",  "muted",
    "error",   "error_bg",
    "warning", "warning_bg",
    "success", "success_bg",
    "info",    "info_bg",
  ];
  for (const k of keys) {
    el.style.setProperty(`--vt-${k.replace(/_/g, "-")}`, t[k]);
  }
  el.setAttribute("data-theme", id);
  el.setAttribute("data-theme-mode", t.mode);
  return t;
};

window.getVaultTheme = (id) => window.VAULT_THEME_BY_ID[id];
window.listVaultThemes = (mode) => window.VAULT_THEMES.filter(t => !mode || t.mode === mode);
