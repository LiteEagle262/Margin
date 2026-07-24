import { settings } from "../../state/store.js";

export const APPEARANCE_DEFAULT = { hue: 348, saturation: 58, lightness: 50 };

// [name, hue, saturation, lightness]
const ACCENT_PRESETS = [
  ["mono", 330, 0, 80],
  ["t3 pink", 330, 76, 56],
  ["crimson", 348, 58, 50],
  ["ember", 24, 88, 60],
  ["gold", 42, 65, 58],
  ["jade", 158, 49, 45],
  ["mint", 160, 55, 62],
  ["cyan", 194, 72, 55],
  ["steel", 214, 28, 62],
  ["violet", 258, 72, 68]
];

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

export function normalizeAppearanceSettings(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    hue: clampInt(value.hue, 0, 360, APPEARANCE_DEFAULT.hue),
    saturation: clampInt(value.saturation, 0, 100, APPEARANCE_DEFAULT.saturation),
    lightness: clampInt(value.lightness, 35, 80, APPEARANCE_DEFAULT.lightness)
  };
}

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const c = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
}

export function applyAppearanceTheme(appearance) {
  const { hue, saturation, lightness } = normalizeAppearanceSettings(appearance);
  const root = document.documentElement;
  const dimAlpha = saturation === 0 ? 0.08 : 0.14;
  root.style.setProperty("--accent", `hsl(${hue} ${saturation}% ${lightness}%)`);
  root.style.setProperty("--accent-bright", `hsl(${hue} ${saturation}% ${Math.min(lightness + 14, 92)}%)`);
  root.style.setProperty("--accent-dim", `hsl(${hue} ${saturation}% ${lightness}% / ${dimAlpha})`);
  root.style.setProperty("--accent-border", `hsl(${hue} ${saturation}% ${lightness}% / 0.35)`);
  root.style.setProperty("--on-accent", lightness >= 50 ? "#0e0e10" : "#ffffff");
}

function readSliders() {
  const hueInput = document.getElementById("appearance-hue");
  const satInput = document.getElementById("appearance-sat");
  const ligInput = document.getElementById("appearance-lig");
  if (!hueInput || !satInput || !ligInput) return null;
  return normalizeAppearanceSettings({
    hue: hueInput.value,
    saturation: satInput.value,
    lightness: ligInput.value
  });
}

function syncAppearanceUI(appearance) {
  const { hue, saturation, lightness } = appearance;
  const hex = hslToHex(hue, saturation, lightness);
  const accent = `hsl(${hue} ${saturation}% ${lightness}%)`;

  const hueInput = document.getElementById("appearance-hue");
  const satInput = document.getElementById("appearance-sat");
  const ligInput = document.getElementById("appearance-lig");
  if (hueInput) hueInput.value = String(hue);
  if (satInput) satInput.value = String(saturation);
  if (ligInput) ligInput.value = String(lightness);

  const hueVal = document.getElementById("appearance-hue-val");
  const satVal = document.getElementById("appearance-sat-val");
  const ligVal = document.getElementById("appearance-lig-val");
  if (hueVal) hueVal.textContent = `${hue}°`;
  if (satVal) satVal.textContent = `${saturation}%`;
  if (ligVal) ligVal.textContent = `${lightness}%`;

  const chipDot = document.getElementById("appearance-accent-dot");
  const chipHex = document.getElementById("appearance-accent-hex");
  if (chipDot) chipDot.style.background = accent;
  if (chipHex) chipHex.textContent = hex;

  const readoutDot = document.getElementById("appearance-readout-dot");
  const readoutHex = document.getElementById("appearance-readout-hex");
  const readoutHsl = document.getElementById("appearance-readout-hsl");
  if (readoutDot) readoutDot.style.background = accent;
  if (readoutHex) readoutHex.textContent = hex;
  if (readoutHsl) readoutHsl.textContent = `h${hue} s${saturation} l${lightness}`;

  document.querySelectorAll("#appearance-presets .appearance-preset").forEach((btn) => {
    const [, presetHue, presetSat, presetLig] = JSON.parse(btn.dataset.preset);
    btn.classList.toggle(
      "active",
      presetHue === hue && presetSat === saturation && presetLig === lightness
    );
  });
}

function applyFromSliders() {
  const appearance = readSliders();
  if (!appearance) return;
  applyAppearanceTheme(appearance);
  syncAppearanceUI(appearance);
}

function renderAppearanceSettings() {
  const appearance = normalizeAppearanceSettings(settings.appearance);
  applyAppearanceTheme(appearance);
  syncAppearanceUI(appearance);
}

function collectAppearanceFromUI() {
  return readSliders() || normalizeAppearanceSettings(settings.appearance);
}

function setOverlayOpen(open) {
  const overlay = document.getElementById("appearance-overlay");
  if (!overlay) return;
  overlay.classList.toggle("hidden", !open);
  if (open) {
    document.getElementById("appearance-hue")?.focus();
  }
}

function initAppearanceSettings() {
  const presetsHost = document.getElementById("appearance-presets");
  if (presetsHost && !presetsHost.childElementCount) {
    for (const preset of ACCENT_PRESETS) {
      const [name, hue, saturation, lightness] = preset;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "appearance-preset";
      btn.dataset.preset = JSON.stringify(preset);
      btn.innerHTML = `<span class="appearance-preset-swatch" style="background:hsl(${hue} ${saturation}% ${lightness}%)"></span>${name}`;
      btn.addEventListener("click", () => {
        const hueInput = document.getElementById("appearance-hue");
        const satInput = document.getElementById("appearance-sat");
        const ligInput = document.getElementById("appearance-lig");
        if (hueInput) hueInput.value = String(hue);
        if (satInput) satInput.value = String(saturation);
        if (ligInput) ligInput.value = String(lightness);
        applyFromSliders();
      });
      presetsHost.appendChild(btn);
    }
  }

  for (const id of ["appearance-hue", "appearance-sat", "appearance-lig"]) {
    document.getElementById(id)?.addEventListener("input", applyFromSliders);
  }

  document.getElementById("appearance-reset-btn")?.addEventListener("click", () => {
    const hueInput = document.getElementById("appearance-hue");
    const satInput = document.getElementById("appearance-sat");
    const ligInput = document.getElementById("appearance-lig");
    if (hueInput) hueInput.value = String(APPEARANCE_DEFAULT.hue);
    if (satInput) satInput.value = String(APPEARANCE_DEFAULT.saturation);
    if (ligInput) ligInput.value = String(APPEARANCE_DEFAULT.lightness);
    applyFromSliders();
  });

  document.getElementById("customize-look-btn")?.addEventListener("click", () => setOverlayOpen(true));
  document.getElementById("appearance-close-btn")?.addEventListener("click", () => setOverlayOpen(false));
  document.getElementById("appearance-overlay")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) setOverlayOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const overlay = document.getElementById("appearance-overlay");
    if (overlay && !overlay.classList.contains("hidden")) setOverlayOpen(false);
  });
}

export const appearanceSection = {
  key: "appearance",
  normalize: normalizeAppearanceSettings,
  render: renderAppearanceSettings,
  collect: collectAppearanceFromUI,
  init: initAppearanceSettings
};
