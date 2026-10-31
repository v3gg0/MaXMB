// XMB background, in one of two Wave Styles:
//   * "original" (the default): the PS3's own wave from the console's lines.qrc
//     (ps3wave/original.js, a port of moyou);
//   * "linkev": the WebGL2 recreation of linkev/PlayStation-3-XMB (wavegl.js).
// This class is a thin theme-control shim: it converts the Theme Settings
// values (background colour, wave/dot colour + toggles, day/night mode, and the
// Wave and Sparkles Personalization spline/particle params) into calls on the
// active renderer; both take the same calls. If the Original wave can't run
// (no lines.qrc, no WebGL2 half-float support), linkev's is used instead.

import { RealWave } from "./wavegl.js";
import { OriginalWave } from "./ps3wave/original.js";
import { ps3Background } from "./ps3wave/background.js";

export const MONTH_COLORS = {
  1: "#7a8391", 2: "#c76fa0", 3: "#5fa85a", 4: "#d98cc0",
  5: "#8ab84f", 6: "#3f8fd0", 7: "#8f7fd6", 8: "#2f9bd0",
  9: "#b5822e", 10: "#d5702a", 11: "#7a5230", 12: "#2f7d3f",
};
// "#rrggbb" or "#rrggbbaa": a custom colour's opacity fades it toward
// transparent (black behind the background, dimmer light for waves / dots).
const hexToRgb = (hex) => {
  const h = (hex || "#888").replace("#", "");
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r: parseInt(h.slice(0, 2), 16) * a, g: parseInt(h.slice(2, 4), 16) * a, b: parseInt(h.slice(4, 6), 16) * a };
};

export class WaveBackground {
  // opts.guard (graphics safety, kept in the settings for this computer):
  // { state(): { originalWave: "ok" | "trial" | "failed", reason }, set(state, reason) }
  constructor(canvas, opts = {}) {
    // `canvas` is the legacy 2D canvas (#wave); it stays fully transparent now
    // that Real Style Waves owns the whole background. Kept only so main.js can
    // pass it without changing its call site.
    this.canvas = canvas;
    if (this.canvas) { try { this.canvas.getContext("2d")?.clearRect(0, 0, this.canvas.width, this.canvas.height); } catch (e) {} }
    this.hidden = false; this.wallpaper = false;
    this.wavesEnabled = true;
    this.dotsEnabled = true;
    this.waveColor = { r: 255, g: 255, b: 255 };
    this.dotColor = { r: 255, g: 255, b: 255 };
    this.setColor("auto");
    // the Wave and Sparkles Personalization values in use (replayed into a new renderer)
    this._params = {};
    // (the Wave Style last chosen on this computer: the one it starts with)
    this.style = opts.style === "linkev" ? "linkev" : "original";
    // Graphics safety: the Original wave is used once it has run well on this
    // computer. Not yet: a "trial" is noted while it starts, so if the system
    // freezes or closes then, the next start goes straight to linkev's. Marked
    // "failed" (it couldn't run, or too slowly): linkev's, until Original is
    // chosen again in Wave Style.
    this._guard = opts.guard || null;
    const g = this._guardState();
    if (g.originalWave === "failed") this._originalFailed = true;
    else if (g.originalWave === "trial") { this._originalFailed = true; this._guardSet("failed", "the system stopped while the Original wave was starting"); }
    this._makeEngine(this._originalFailed || this.style === "linkev" ? "linkev" : "original");
    window.__menuTint = () => this.updateMenuTint();
    this.updateMenuTint();
    // linkev's copy of the console's month background (lines.qrc) made ahead,
    // once the system has started: otherwise linkev's wave, chosen later (or
    // its Original Background Color), shows its own month colours for a moment
    // and then changes to the console's, the wave's colour with it
    setTimeout(() => { try { ps3Background(); } catch (e) {} }, 8000);
  }

  setColor(color) {
    // (the Visualizer Wave background is drawn from its own gradient, as Original is)
    if (color === "visualizer") color = "auto";
    // (the Original wave: a PS3 theme's month colour is that month's own background)
    if (this._themeHex(color)) color = "auto";
    const isAuto = !color || color === "auto";
    const base = isAuto ? MONTH_COLORS[new Date().getMonth() + 1] : color;
    this.base = hexToRgb(base);
    // the "Black" Background Color is the system's own default background
    // (the same near-black gradient as Auto), not a black-tinted gradient
    this._autoColor = isAuto || String(color).toLowerCase() === "#1a1a1a";
    if (this.real) this.real.setBaseColor(this.base, this._autoColor);
    this.updateMenuTint();
  }
  // The option menus (△ menus, the game menu) are tinted with the background's
  // actual colour right now (month / time of day, the wave's own colours or the
  // Background Color), lighter. Refreshed whenever a menu opens.
  updateMenuTint() {
    let c = null;
    if (this.real && this.real.ok) { try { c = this.real.backgroundColor().map((v) => v * 255); } catch (e) { c = null; } }
    if (!c) { const b = this.base || { r: 58, g: 60, b: 68 }; c = [b.r, b.g, b.b]; }
    const lt = (v) => Math.round(Math.max(0, Math.min(255, v + (255 - v) * 0.35)));
    document.documentElement.style.setProperty("--menu-rgb", c.map(lt).join(","));
    this._updateIconAuto();
  }
  // Icon Style "Liquid Glass (Reactive Glow)": the glow takes the background's
  // light as it is right now (its brighter end at full brightness, paler);
  // white over a picture or before the background is drawn
  updateGlow(hi) {
    if (hi === undefined) { hi = null; if (!this.wallpaper && this.real && this.real.ok) { try { hi = this.real.backgroundBright(); } catch (e) { hi = null; } } }
    const m = hi ? Math.max(...hi) : 0;
    const glow = m > 0.02 ? Array.from(hi, (v) => { const b = Math.min(1, v / m); return Math.round(255 * (b + (1 - b) * 0.5)); }) : [255, 255, 255];
    const v = glow.join(",");
    if (v !== this._glow) { this._glow = v; document.documentElement.style.setProperty("--glow-rgb", v); }
  }
  // Icon Color "Original" (as on the console): the icons take the background's
  // colour: its brighter end brought up to full brightness (same hue), then
  // mixed 55 % toward white, so the icons come out as pale
  // as in the captures (green → #6ba36b, blue → #7abed7, brown → khaki);
  // over a background picture or video too (the background's colour as it
  // would be, though it's hidden). Rounded so a slowly changing background
  // (Month and Time Colors) only re-shades the icons now and then.
  _updateIconAuto() {
    let hi = null;
    if (this.real && this.real.ok) { try { hi = this.real.backgroundBright(); } catch (e) { hi = null; } }
    let rgb = [1, 1, 1], def = [1, 1, 1], gain = 1, bright = false;
    if (hi) {
      const k = Math.min(4, 0.92 / Math.max(1e-3, ...hi));
      rgb = hi.map((v) => { const b = Math.min(1, v * k); return Math.min(1, Math.round((b + (1 - b) * 0.55) * 32) / 32); });
      // Icon Style "Default" only: on a bright background (October's yellow,
      // February's gold, January's silver) the console's icons are a pale
      // cream, nearly white, and brighter, so they stand out from it
      const lum = 0.3 * hi[0] + 0.59 * hi[1] + 0.11 * hi[2];
      const t = Math.max(0, Math.min(1, (lum - 0.45) / 0.3)), e = t * t * (3 - 2 * t), white = 0.7 + 0.18 * e;
      def = hi.map((v) => { const b = Math.min(1, v * k); return Math.min(1, Math.round((b + (1 - b) * white) * 32) / 32); });
      gain = Math.round((1 + 0.7 * e) * 16) / 16;
      bright = t > 0.5;
    }
    document.documentElement.toggleAttribute("data-bright-bg", bright && !this.wallpaper);
    // (the glow: white over a picture, as before)
    this.updateGlow(this.wallpaper ? null : hi);
    const key = rgb.join(",") + "|" + def.join(",") + "|" + gain;
    if (key === this._iconAutoKey) return;
    this._iconAutoKey = key; this.iconAutoRgb = rgb; this.iconAutoDefault = def; this.iconAutoGain = gain;
    this.onIconAuto && this.onIconAuto(rgb, gain, def);
  }
  // Wave Style: "original" or "linkev". Each renderer has its own canvas (the
  // same element id and styles: the old one is swapped out), set up with
  // every setting the old one had.
  // opts.visualizer: the Visualizer Wave is showing (the Music Player's, or the
  // Visualizer background / wave colour): it's linkev's wave's own look, so
  // linkev's is drawn meanwhile; the other renderer is kept aside (not
  // started again from nothing) and comes back when the Visualizer is gone.
  setStyle(style, opts = {}) {
    style = style === "linkev" ? "linkev" : "original";
    const userChange = style !== this.style;
    this.style = style;
    const vis = !!opts.visualizer;
    const want = vis ? "linkev" : style === "original" && !this._originalFailed ? "original" : "linkev";
    // (the Wave Style chosen by hand: nothing kept aside for later)
    if (userChange && !vis && this._parked && this._parked.kind !== want) this._dropParked();
    if (this.real && this.activeStyle === want) { this._syncReal(); this.real.start(); return; }
    if (this._parked && this._parked.kind === want) { this._swapParked(); return; }
    this._makeEngine(want, vis);
  }
  _dropParked() {
    const pk = this._parked; this._parked = null;
    if (!pk) return;
    try { pk.real.destroy ? pk.real.destroy() : pk.real.stop(); } catch (e) {}
    if (!pk.real.destroy) { try { (pk.canvas.getContext("webgl2") || pk.canvas.getContext("webgl"))?.getExtension("WEBGL_lose_context")?.loseContext(); } catch (e) {} }
  }
  // the renderer kept aside back on screen, the one on screen kept aside
  _swapParked() {
    const pk = this._parked, cur = document.getElementById("wavegl");
    if (this.real) { try { this.real.stop(); } catch (e) {} }
    this._parked = this.real && cur ? { kind: this.activeStyle, real: this.real, canvas: cur } : null;
    if (cur) cur.replaceWith(pk.canvas); else document.body.prepend(pk.canvas);
    this.real = pk.real; this.activeStyle = pk.kind;
    this.real.resetParams();
    this.real.applyParams(this._params);
    this._syncReal();
    this.real.start();
    this.updateMenuTint && this.updateMenuTint();
    this.onStyleChange && this.onStyleChange();
  }
  // A PS3 theme's colour (a month, 0-11; null: none). With the Original wave
  // it's that month's own background (the wave and sparkles stay the
  // console's); linkev's shows the same month's background and wave colours.
  setThemeMonth(m) {
    this.themeMonth = m == null ? null : m;
    if (this.real && this.real.setThemeMonth) this.real.setThemeMonth(this.themeMonth);
  }
  _themeHex(c) {
    return this.themeMonth != null && !!c && String(c).toLowerCase() === MONTH_COLORS[this.themeMonth + 1].toLowerCase();
  }
  // the style really drawn ("linkev" when the Original wave can't run)
  activeWaveStyle() { return this.activeStyle; }
  // why the Original wave isn't shown (null: it is, or it wasn't tried)
  originalFailReason() { return this._originalFailed ? (this._failReason || this._guardState().reason || "it couldn't run on this computer") : null; }
  // Wave Style set to Original by hand: try it again (even after it failed)
  retryOriginal() {
    if (!this._originalFailed) return;
    this._originalFailed = false; this._failReason = null;
    this._guardSet("", null);
    if (this.style === "original") { this._makeEngine("original"); this.onStyleChange && this.onStyleChange(); }
  }
  _guardState() { try { return (this._guard && this._guard.state()) || {}; } catch (e) { return {}; } }
  _guardSet(st, reason) { try { this._guard && this._guard.set(st, reason); } catch (e) {} }
  // park: keep the renderer on screen aside instead of letting it go (see setStyle)
  _makeEngine(kind, park = false) {
    let old = document.getElementById("wavegl");
    if (park && this.real && old && this.activeStyle !== kind) {
      this._dropParked();
      try { this.real.stop(); } catch (e) {}
      this._parked = { kind: this.activeStyle, real: this.real, canvas: old };
      const fresh = old.cloneNode(false); fresh.classList.remove("show"); old.replaceWith(fresh);
      this.real = null; old = fresh;
    }
    // (Original left while still on trial, without trouble: not a failure)
    if (this.real && this.activeStyle === "original" && kind !== "original" && !this._originalFailed && this._guardState().originalWave === "trial") this._guardSet("", null);
    if (this.real) { try { this.real.destroy ? this.real.destroy() : this.real.stop(); } catch (e) {} }
    // (the previous Wave Style's drawing context goes with it; linkev's copy of
    // the console's month background stays, so going back to linkev's, or
    // choosing Original as its Background Color, shows it from the first frame)
    if (this.real && this.activeStyle !== kind) {
      if (!this.real.destroy && old) { try { (old.getContext("webgl2") || old.getContext("webgl"))?.getExtension("WEBGL_lose_context")?.loseContext(); } catch (e) {} }
    }
    let canvas = old;
    if (this.real && old) {
      // (a canvas keeps the WebGL context it was first given: a new one for the new renderer)
      canvas = old.cloneNode(false);
      canvas.classList.remove("show");
      old.replaceWith(canvas);
    }
    this.activeStyle = kind;
    if (!canvas) { this.real = null; return; }
    if (kind === "original") {
      const w = this.real = new OriginalWave(canvas);
      // (not proven on this computer yet: a trial until its first seconds ran well)
      if (this._guardState().originalWave !== "ok") this._guardSet("trial", null);
      w.onHealthy = () => { if (this.real === w && this._guardState().originalWave !== "ok") this._guardSet("ok", null); };
      const fail = (e) => {
        if (this.real !== w) return;
        this._failReason = (e && e.message) || null;
        // (the files missing: nothing to remember, it's tried again next time)
        if (e && e.files) { if (this._guardState().originalWave === "trial") this._guardSet("", null); }
        else this._guardSet("failed", this._failReason);
        this._originalFailed = true;
        this._makeEngine("linkev");
        this.onStyleChange && this.onStyleChange();
      };
      w.onFail = fail;
      w.ready.then(() => { if (this.real === w) { this.updateMenuTint(); this.onStyleChange && this.onStyleChange(); } }, fail);
    } else this.real = new RealWave(canvas);
    this.real.resetParams();
    this.real.applyParams(this._params);
    this._syncReal();
    this.real.start();
    this.updateMenuTint && this.updateMenuTint();
  }
  // Push the current theme colours/toggles into the Real-style renderer.
  _syncReal() {
    if (!this.real) return;
    this.real.setBaseColor(this.base, this._autoColor !== false);
    this.real.setWaveColor(this.waveColor);
    if (this.real.setOverlay) this.real.setOverlay(this.overlay ? this.overlay.name : null, this.overlay ? this.overlay.files : null, true);
    this.real.complexAuto = this.waveAuto !== false;
    this.real.setDotColor(this.dotColor);
    this.real.setWavesEnabled(this.wavesEnabled);
    this.real.setDotsEnabled(this.dotsEnabled);
    this.real.setWallpaper(this.wallpaper);
    if (this.real.setBgOff) this.real.setBgOff(!!this.bgOff);
    this.real.setHidden(this.hidden);
    if (this.real.setStill) this.real.setStill(!!this.still);
    if (this.real.setLowPower) this.real.setLowPower(this.lowPower | 0);
    this.real.setMonthMode(this.monthMode !== false);
    if (this.real.setThemeMonth) this.real.setThemeMonth(this.themeMonth ?? null);
  }
  // ---- Wave and Sparkles Personalization (spline + particle params) ----
  setWaveParam(group, key, val) { this._params[group + ":" + key] = val; if (this.real) this.real.setParam(group, key, val); }
  getWaveParam(group, key) { return this.real ? this.real.getParam(group, key) : undefined; }
  applyWaveParams(map) { if (map) Object.assign(this._params, map); if (this.real) this.real.applyParams(map); this.updateMenuTint(); }
  resetWaveParams() { this._params = {}; if (this.real) this.real.resetParams(); }

  setLowPower(level) { this.lowPower = level | 0; if (this.real) this.real.setLowPower(this.lowPower); }
  // (kept, so a renderer made later (another Wave Style for another user, or
  // the linkev wave taking over from an Original wave that failed) gets it too)
  setStill(on) { this.still = !!on; if (this.real) this.real.setStill(this.still); }
  // (hidden behind an item's own background: the PS3 theme's animated
  // background holds still under it too, p3tbg.js)
  setHidden(h) { this.hidden = h; if (this.real) this.real.setHidden(h); document.body.classList.toggle("bgcovered", !!h); }
  setWallpaper(on) { this.wallpaper = !!on; if (this.real) this.real.setWallpaper(!!on); this._updateIconAuto(); }
  // (Overlay over the Background Color) the page draws the gradient instead
  setBgOff(on) { this.bgOff = !!on; if (this.real && this.real.setBgOff) this.real.setBgOff(!!on); }
  backgroundImage() { return this.real && this.real.ok && this.real.backgroundImage ? this.real.backgroundImage() : null; }
  setWavesEnabled(on) { this.wavesEnabled = on !== false; if (this.real) this.real.setWavesEnabled(on !== false); }
  setDotsEnabled(on) { this.dotsEnabled = on !== false; if (this.real) this.real.setDotsEnabled(on !== false); }
  setMotion(x, y) { if (this.real && this.real.setMotion) this.real.setMotion(x, y); }
  addMotionImpulse(dv) { if (this.real && this.real.addMotionImpulse) this.real.addMotionImpulse(dv); }
  // Month and Time Colors (the real XMB's month / time-of-day background)
  setMonthMode(on) { this.monthMode = on !== false; if (this.real) this.real.setMonthMode(this.monthMode); this.updateMenuTint(); }
  setDotColor(color) {
    if (this._themeHex(color)) color = "auto";
    this.dotColor = (!color || color === "auto") ? { r: 255, g: 255, b: 255 } : hexToRgb(color);
    if (this.real) this.real.setDotColor(this.dotColor);
  }
  setWaveColor(color) {
    if (this._themeHex(color)) color = "auto";
    this.waveAuto = !color || color === "auto";
    this.waveColor = this.waveAuto ? { r: 255, g: 255, b: 255 } : hexToRgb(color);
    if (this.real) { this.real.setWaveColor(this.waveColor); this.real.complexAuto = this.waveAuto; }
  }
  // The Original wave: one of the console's own screen presets (lines.qrc
  // override/<name>: music_1 is its Music Player's Visualizer) faded in over
  // the time of day, for the given .mnu files; null: back to the time of day
  setOverlay(name, files = null) {
    this.overlay = name ? { name, files } : null;
    if (this.real && this.real.setOverlay) this.real.setOverlay(name, files);
    // (the icons' and menus' colours follow the background once its fade is
    // over: leaving the Music Player, they're not left in its Visualizer's colours)
    clearTimeout(this._ovTintT); clearTimeout(this._ovTintT2);
    this._ovTintT = setTimeout(() => this.updateMenuTint(), 600);
    this._ovTintT2 = setTimeout(() => this.updateMenuTint(), 1500);
  }

}
