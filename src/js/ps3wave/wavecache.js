// The Wave Cache: the Original wave's rope run to its start state (sim.js warmRope, about a
// second of work), saved by its settings so the next start takes it as it is. Kept in the
// Windows Temp folder, or in the system directory with Save Cache in System Directory
// (lib.rs wave_cache_load / wave_cache_save); deleted with the other temporary files.

import { call } from "../api.js";
import { warmRopeAsync, NN } from "./sim.js";

const MAX = 8;                // (a few: one per wave setting used lately)
let _map = null;              // key -> base64 of cur + vel (Float64, NN x 4 each: exactly the run's result)

async function load() {
  if (_map) return _map;
  try { const o = JSON.parse(await call("wave_cache_load") || "{}"); _map = new Map(Object.entries(o && typeof o === "object" ? o : {})); }
  catch (e) { _map = new Map(); }
  return _map;
}
function save() {
  if (!_map) return;
  call("wave_cache_save", { data: JSON.stringify(Object.fromEntries(_map)) }).catch(() => {});
}
const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };

// the rope's start for these settings: from the cache, or worked out (in a worker) and saved
export async function cachedWarmRope(n, q) {
  const key = JSON.stringify([1, n, q]);
  const m = await load();
  const hit = m.get(key);
  if (hit) {
    try {
      const u = unb64(hit);
      if (u.length === NN * 4 * 8 * 2) {
        const f = new Float64Array(u.buffer);
        m.delete(key); m.set(key, hit);   // (most recently used last)
        return { cur: f.slice(0, NN * 4), vel: f.slice(NN * 4) };
      }
    } catch (e) {}
    m.delete(key);
  }
  const w = await warmRopeAsync(n, q);
  const both = new Float64Array(NN * 8); both.set(w.cur, 0); both.set(w.vel, NN * 4);
  m.set(key, b64(new Uint8Array(both.buffer)));
  while (m.size > MAX) m.delete(m.keys().next().value);
  save();
  return w;
}
// Delete Wave Cache: forgotten here too (made again at the wave's next start)
export function forgetWaveCache() { _map = new Map(); }
// Save Cache in System Directory switched: saved again, in its new place
export function moveWaveCache() { if (_map && _map.size) save(); }
