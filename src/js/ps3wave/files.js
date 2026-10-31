// The console's wave file, read once: lines.qrc (decoded and its programs transpiled).

import { Archive } from "./formats.js";
import { loadAssets } from "./renderer.js";
import { IN_TAURI, call, assetUrl } from "../api.js";

// The PS3's own files go in src-tauri/resources/ps3 (part of the build, like ffmpeg):
// fetched from there (the app's resources) and nowhere else, so a build without
// them has none. (Only the preview in a browser, without the app, reads them
// from assets/wave.)
export async function fetchPs3File(name) {
  const urls = [];
  if (IN_TAURI) { try { const p = await call("ps3_file", { name }); if (p) urls.push(assetUrl(p)); } catch (e) {} }
  else urls.push("./assets/wave/" + name);
  let last = 0;
  for (const u of urls) {
    try { const r = await fetch(u); if (r.ok) return new Uint8Array(await r.arrayBuffer()); last = r.status; } catch (e) {}
  }
  throw new Error("no " + name + (last ? " (" + last + ")" : ""));
}

let _files = null;
export function loadFiles() {
  if (_files) return _files;
  _files = (async () => {
    const archive = await Archive.fromBytes(await fetchPs3File("lines.qrc"));
    return { archive, assets: loadAssets(archive) };
  })();
  _files.catch(() => { _files = null; });
  return _files;
}
