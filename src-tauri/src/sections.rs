//! Custom sections (System Settings > Sections).
//!
//! A section is a new category with its own subsections. Each subsection reads
//! the folders chosen for it (by default content/<Section>/<Subsection>).
//! Like games, every item has a folder of its own:
//!   • a game folder (game.json, info.txt, an .exe or a shortcut), read exactly
//!     like the Games folder;
//!   • an item folder holding one video, song or picture. Its "item.json" is
//!     made when the folder is first found: { "title": "…", "file": "…" }.
//!     icon.*, preview.* (a gif or a video), background.* and music.* put in
//!     the folder work like a game's.
//! A folder that holds item folders (not an item itself) is shown as a folder
//! of the section's folder type; `group` is its name ("" = none). A file put
//! loose in the section's own folder (content/<Section>) is given a folder of
//! its own first (named after it), and so are the files of a folder you made
//! there with several files in it (an album); elsewhere loose files aren't listed.

use crate::models::{Game, MediaItem};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ItemMeta {
    pub title: Option<String>,
    pub icon: Option<String>,
    pub gif: Option<String>,
    pub background: Option<String>,
    pub music: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionEntry {
    /// "game" | "video" | "music" | "photo"
    pub kind: String,
    /// the subfolder (directly under the subsection's folder) it's in; "" = none
    pub group: String,
    pub media: Option<MediaItem>,
    pub game: Option<Game>,
    pub meta: ItemMeta,
}

pub struct Ctx<'a> {
    pub icon_cache: &'a Path,
    pub covers: &'a Path,
    pub ffmpeg: Option<&'a Path>,
    pub video_icon: &'a dyn Fn(&Path) -> (Option<String>, Option<String>),
    /// loose files are given their own folder only inside this folder (content/)
    pub wrap_in: Option<&'a Path>,
}

pub fn list(roots: &[String], ctx: &Ctx) -> Vec<SectionEntry> {
    let mut out = Vec::new();
    for r in roots {
        let root = PathBuf::from(r);
        if !root.is_dir() { continue; }
        if ctx.wrap_in.map(|c| root.starts_with(c)).unwrap_or(false) { wrap_loose(&root); }
        walk(&root, "", 0, ctx, &mut out);
    }
    out
}

/// Every recognised file lying loose in `root` goes into a new folder named
/// after it (so it gets its item.json / game.json like the rest).
pub fn wrap_loose(root: &Path) {
    let Ok(rd) = fs::read_dir(root) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_file() { continue; }
        let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
        if kind_of(&ext).is_none() { continue; }
        let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let mut dir = root.join(safe_name(&stem));
        let mut n = 2;
        while dir.exists() { dir = root.join(format!("{} ({n})", safe_name(&stem))); n += 1; }
        if fs::create_dir_all(&dir).is_err() { continue; }
        let to = dir.join(p.file_name().unwrap_or_default());
        if fs::rename(&p, &to).is_err() { let _ = fs::remove_dir(&dir); }
    }
}

fn kind_of(ext: &str) -> Option<&'static str> {
    if crate::media::VIDEO_EXTS.contains(&ext) { Some("video") }
    else if crate::media::MUSIC_EXTS.contains(&ext) { Some("music") }
    else if crate::media::PHOTO_EXTS.contains(&ext) || crate::media::DOC_EXTS.contains(&ext) { Some("photo") }
    else if crate::media::APP_EXTS.contains(&ext) { Some("app") }
    else { None }
}

const ASSET_STEMS: [&str; 6] = ["icon", "preview", "background", "music", "icon0", "pic1"];

fn find_asset(dir: &Path, stem: &str, exts: &[&str]) -> Option<String> {
    let rd = fs::read_dir(dir).ok()?;
    let mut v: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_file()).collect();
    v.sort();
    v.into_iter().find(|p| {
        p.file_stem().map(|s| s.to_string_lossy().eq_ignore_ascii_case(stem)).unwrap_or(false)
            && p.extension().map(|e| exts.contains(&e.to_string_lossy().to_lowercase().as_str())).unwrap_or(false)
    }).map(|p| p.display().to_string())
}

/// An item folder's main file (and its kind): the one item.json names, or
/// the first video / song / picture that isn't one of its icon, preview,
/// background or music files.
fn item_main(dir: &Path, json: Option<&Value>) -> Option<(PathBuf, &'static str)> {
    if let Some(f) = json.and_then(|j| j.get("file")).and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
        let p = dir.join(f.trim());
        // (the app's own shortcut to a file elsewhere, made from a folder added
        // to the section: the file it points at)
        let p = if ext_of(&p) == crate::medialib::LINK_EXT { crate::medialib::read_link(&p).unwrap_or(p) } else { p };
        let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        if p.is_file() { if let Some(k) = kind_of(&ext).filter(|k| *k != "app") { return Some((p, k)); } }
    }
    let mut files: Vec<PathBuf> = fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).filter(|p| p.is_file()).collect();
    files.sort();
    // videos first, then music, then pictures (a picture is often the cover)
    for want in ["video", "music", "photo"] {
        for p in &files {
            let stem = p.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
            if ASSET_STEMS.contains(&stem.as_str()) { continue; }
            let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            if kind_of(&ext) == Some(want) { return Some((p.clone(), want)); }
        }
    }
    None
}

fn walk(dir: &Path, group: &str, depth: u32, ctx: &Ctx, out: &mut Vec<SectionEntry>) {
    if depth > 12 { return; }
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    dirs.sort();
    for d in dirs {
        // (an item folder made from an added folder holds the app's shortcut to
        // its file, which would otherwise make it look like a program's folder)
        let linked_item = fs::read_to_string(d.join("item.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .filter(|j| j.get("file").and_then(|f| f.as_str()).map(|f| f.to_lowercase().ends_with(&format!(".{}", crate::medialib::LINK_EXT))).unwrap_or(false))
            .and_then(|j| item_main(&d, Some(&j))).is_some();
        // a game folder
        if !linked_item && crate::library::is_game_dir(&d) {
            // (a program or script, not a PS3 game: program.json, its Format PC)
            if crate::ps3::game_at(&d).is_none() { crate::library::section_program(&d); }
            if let Some(game) = crate::library::parse_game(&d, None, Some(ctx.icon_cache)) {
                out.push(SectionEntry { kind: "game".into(), group: group.into(), media: None, game: Some(game), meta: ItemMeta::default() });
            }
            continue;
        }
        // an item folder (one video / song / picture)
        let jpath = d.join("item.json");
        let json: Option<Value> = fs::read_to_string(&jpath).ok().and_then(|t| serde_json::from_str(&t).ok());
        // a folder you made with several files in it (not an item): an album.
        // Each of its files gets a folder of its own inside it (as loose files
        // in the section's folder do), and it's shown as a folder of items
        if json.is_none() && loose_count(&d) >= 2 && ctx.wrap_in.map(|c| d.starts_with(c)).unwrap_or(false) {
            wrap_loose(&d);
            let g = if depth == 0 { d.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default() } else { group.to_string() };
            walk(&d, &g, depth + 1, ctx, out);
            continue;
        }
        if let Some((main, kind)) = item_main(&d, json.as_ref()) {
            let stem = main.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let file = main.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            // the item.json is made the first time (title + file), then it's the user's
            let mut j = match json { Some(Value::Object(m)) => m, _ => serde_json::Map::new() };
            let mut changed = false;
            if !j.contains_key("title") { j.insert("title".into(), Value::String(stem.clone())); changed = true; }
            if !j.contains_key("file") { j.insert("file".into(), Value::String(file)); changed = true; }
            if changed { let _ = fs::write(&jpath, serde_json::to_string_pretty(&Value::Object(j.clone())).unwrap_or_default()); }
            let Some(mut item) = crate::media::media_item(&main, kind, ctx.ffmpeg, depth == 0) else { continue };
            if kind == "video" { let (c, k) = (ctx.video_icon)(&main); item.cover = c; item.clip = k; }
            if kind == "music" { item.cover = crate::media::cache_cover(&main, ctx.covers, ctx.ffmpeg); }
            const IMG: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "bmp"];
            let meta = ItemMeta {
                title: j.get("title").and_then(|t| t.as_str()).map(|t| t.trim().to_string()).filter(|t| !t.is_empty()),
                icon: find_asset(&d, "icon", IMG).or_else(|| find_asset(&d, "icon0", IMG)),
                gif: find_asset(&d, "preview", &["gif", "mp4", "webm", "mov", "m4v"]),
                background: find_asset(&d, "background", IMG).or_else(|| find_asset(&d, "pic1", IMG)),
                music: find_asset(&d, "music", &["flac", "wav", "ogg", "mp3", "opus", "m4a", "aac"]),
            };
            out.push(SectionEntry { kind: kind.into(), group: group.into(), media: Some(item), game: None, meta });
            continue;
        }
        // a folder of items: shown as a folder (its subfolders are flattened into it)
        let g = if depth == 0 { d.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default() } else { group.to_string() };
        walk(&d, &g, depth + 1, ctx, out);
    }
}

/// How many videos, songs, pictures and documents lie loose in a folder (its
/// icon / preview / background / music files aside).
fn loose_count(dir: &Path) -> usize {
    let Ok(rd) = fs::read_dir(dir) else { return 0 };
    rd.flatten().map(|e| e.path()).filter(|p| p.is_file()).filter(|p| {
        let stem = p.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
        let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        !ASSET_STEMS.contains(&stem.as_str()) && matches!(kind_of(&ext), Some(k) if k != "app")
    }).count()
}

fn ext_of(p: &Path) -> String { p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default() }

// ------------------------------------------------- folders added to a section
//
// A folder added to a section (or subsection) is read like a game source
// folder: nothing is written in it. Each of its items gets an item folder of
// its own in the section's folder (content\<Section>, or the subsection's),
// with the app's shortcut to the file and an item.json (or, for a program,
// a program.json), so it gets an icon, preview, background and music like the
// rest. Each added folder has
//   • its mode: "loose" (every file of the chosen kinds lying loose in it is
//     an item) or "folders" (every subfolder in it is an item: its most likely
//     file of the chosen kinds), and
//   • its kinds: "music", "video", "photo" (pictures), "doc" (PDFs, comics)
//     and "app" (programs and scripts).
// What was made is kept in data\section_sources.json, so an item deleted by
// hand isn't made again, and removing the folder removes its items.

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceOpts {
    pub path: String,
    /// the section's (or subsection's) folder the items are made in
    pub dest: String,
    pub mode: String,
    pub kinds: Vec<String>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SourceEntry { pub target: String, pub folder: String, pub source: String, pub dest: String }
#[derive(Debug, Clone, Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SourceRecord { pub entries: Vec<SourceEntry> }

fn load_src_record(f: &Path) -> SourceRecord { fs::read_to_string(f).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default() }
fn save_src_record(f: &Path, r: &SourceRecord) { if let Ok(t) = serde_json::to_string_pretty(r) { let _ = fs::write(f, t); } }

/// A file's kind for an added folder (pictures and documents apart).
pub fn src_kind(ext: &str) -> Option<&'static str> {
    if crate::media::VIDEO_EXTS.contains(&ext) { Some("video") }
    else if crate::media::MUSIC_EXTS.contains(&ext) { Some("music") }
    else if crate::media::PHOTO_EXTS.contains(&ext) { Some("photo") }
    else if crate::media::DOC_EXTS.contains(&ext) { Some("doc") }
    else if crate::media::APP_EXTS.contains(&ext) { Some("app") }
    else { None }
}
fn is_asset(p: &Path) -> bool {
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
    ASSET_STEMS.contains(&stem.as_str())
}
fn files_in(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_file()).collect();
    v.sort();
    v
}

/// "folders": a subfolder's most likely file of the chosen kinds: its program
/// first (the exe that starts it, as for games), then a video, a song, a
/// document, a picture (inside it, up to two folders down).
fn folder_main(d: &Path, kinds: &[String]) -> Option<PathBuf> {
    let has = |k: &str| kinds.iter().any(|x| x == k);
    if has("app") {
        if let Some(exe) = crate::gamesrc::main_exe(d) { return Some(exe); }
        if let Some(p) = files_in(d).into_iter().find(|p| src_kind(&ext_of(p)) == Some("app")) { return Some(p); }
    }
    fn deep(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
        let mut sub = Vec::new();
        for p in files_in(dir) { out.push(p); }
        for e in fs::read_dir(dir).into_iter().flatten().flatten() { if e.path().is_dir() { sub.push(e.path()); } }
        sub.sort();
        if depth < 2 { for s in sub { deep(&s, depth + 1, out); } }
    }
    let mut all = Vec::new();
    deep(d, 0, &mut all);
    for want in ["video", "music", "doc", "photo"] {
        if !has(want) { continue; }
        if let Some(p) = all.iter().find(|p| !is_asset(p) && src_kind(&ext_of(p)) == Some(want)) { return Some(p.clone()); }
    }
    None
}

/// The items an added folder holds now: (the file, its title).
fn source_items(o: &SourceOpts) -> Vec<(PathBuf, String)> {
    let src = Path::new(&o.path);
    let has = |k: &str| o.kinds.iter().any(|x| x == k);
    if o.mode == "folders" {
        let mut dirs: Vec<PathBuf> = fs::read_dir(src).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        dirs.sort();
        dirs.into_iter().filter_map(|d| {
            let name = d.file_name()?.to_string_lossy().to_string();
            if name.starts_with('.') { return None; }
            folder_main(&d, &o.kinds).map(|f| (f, name))
        }).collect()
    } else {
        files_in(src).into_iter().filter(|p| !is_asset(p) && src_kind(&ext_of(p)).map(has).unwrap_or(false))
            .map(|p| { let t = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(); (p, t) })
            .collect()
    }
}

/// Make the item folders for the new items of the added folders. Returns how
/// many were made. `content` is the content folder: items are only ever made
/// inside it.
pub fn sync_sources(srcs: &[SourceOpts], content: &Path, record_file: &Path) -> usize {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _one = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut rec = load_src_record(record_file);
    let mut made = 0;
    for o in srcs {
        let dest = PathBuf::from(&o.dest);
        if !Path::new(&o.path).is_dir() || !dest.starts_with(content) || dest == content { continue; }
        if fs::create_dir_all(&dest).is_err() { continue; }
        for (file, title) in source_items(o) {
            let target = file.display().to_string();
            if rec.entries.iter().any(|e| e.target.eq_ignore_ascii_case(&target) && e.dest.eq_ignore_ascii_case(&o.dest)) { continue; }
            let base = safe_name(&title);
            let mut dir = dest.join(&base);
            let mut n = 2;
            while dir.exists() { dir = dest.join(format!("{base} ({n})")); n += 1; }
            if fs::create_dir_all(&dir).is_err() { continue; }
            let link = format!("{base}.{}", crate::medialib::LINK_EXT);
            if crate::medialib::write_link(&dir.join(&link), &file).is_err() { let _ = fs::remove_dir_all(&dir); continue; }
            let ok = if src_kind(&ext_of(&file)) == Some("app") {
                // a program: started like the section's other programs
                let j = serde_json::json!({ "title": title, "launch": link, "console": "PC" });
                fs::write(dir.join(crate::library::PROGRAM_JSON), serde_json::to_string_pretty(&j).unwrap_or_default()).is_ok()
            } else {
                let j = serde_json::json!({ "title": title, "file": link });
                fs::write(dir.join("item.json"), serde_json::to_string_pretty(&j).unwrap_or_default()).is_ok()
            };
            if !ok { let _ = fs::remove_dir_all(&dir); continue; }
            rec.entries.push(SourceEntry { target, folder: dir.display().to_string(), source: o.path.clone(), dest: o.dest.clone() });
            made += 1;
        }
    }
    save_src_record(record_file, &rec);
    made
}

/// An added folder was removed (or its mode or kinds changed): the item
/// folders made from it are deleted (only inside the content folder) and
/// forgotten. Returns how many were deleted.
pub fn remove_source(source: &str, dest: &str, content: &Path, record_file: &Path) -> usize {
    let mut rec = load_src_record(record_file);
    let root = content.canonicalize().ok();
    let mut n = 0;
    rec.entries.retain(|e| {
        if !(e.source.eq_ignore_ascii_case(source) && e.dest.eq_ignore_ascii_case(dest)) { return true; }
        if let (Ok(t), Some(r)) = (Path::new(&e.folder).canonicalize(), root.as_ref()) {
            if t.starts_with(r) && &t != r && fs::remove_dir_all(&t).is_ok() { n += 1; }
        }
        false
    });
    save_src_record(record_file, &rec);
    n
}

/// A file / folder name made safe for Windows.
pub fn safe_name(s: &str) -> String {
    let t: String = s.chars().map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '_' } else { c }).collect();
    let t = t.trim().trim_end_matches('.').trim().to_string();
    if t.is_empty() { "Section".into() } else { t }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn added_folders_make_items_in_the_section() {
        let root = std::env::temp_dir().join("xmb_section_src");
        let _ = fs::remove_dir_all(&root);
        let (src, content) = (root.join("Downloads"), root.join("content"));
        let dest = content.join("Stuff");
        for d in ["Comic A", "Tool B/bin", "Album C"] { fs::create_dir_all(src.join(d)).unwrap(); }
        fs::create_dir_all(&dest).unwrap();
        for f in ["a.pdf", "b.cbz", "c.png", "d.mp3", "e.exe", "setup.exe", "f.bat"] { fs::write(src.join(f), b"x").unwrap(); }
        fs::write(src.join("Comic A/book.cbz"), b"x").unwrap();
        fs::write(src.join("Comic A/icon.png"), b"x").unwrap();
        fs::write(src.join("Tool B/bin/tool.exe"), b"x").unwrap();
        fs::write(src.join("Album C/01.mp3"), b"x").unwrap();
        let rec = root.join("rec.json");
        let k = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // loose: documents and pictures only
        let o = SourceOpts { path: src.display().to_string(), dest: dest.display().to_string(), mode: "loose".into(), kinds: k(&["doc", "photo"]) };
        assert_eq!(sync_sources(&[o.clone()], &content, &rec), 3);
        assert_eq!(sync_sources(&[o.clone()], &content, &rec), 0);     // (made once)
        let none = |_: &Path| (None, None);
        let ctx = Ctx { icon_cache: &root, covers: &root, ffmpeg: None, video_icon: &none, wrap_in: None };
        let v = list(&[dest.display().to_string()], &ctx);
        assert_eq!(v.len(), 3);
        assert!(v.iter().all(|e| e.kind == "photo" && e.media.as_ref().unwrap().path.starts_with(&src.display().to_string())), "{:?}", v.iter().map(|e| e.media.as_ref().unwrap().path.clone()).collect::<Vec<_>>());
        // nothing is written in the added folder
        assert!(!src.join("item.json").exists() && !src.join("Comic A/item.json").exists());
        // removed: its items go
        assert_eq!(remove_source(&o.path, &o.dest, &content, &rec), 3);
        assert!(fs::read_dir(&dest).unwrap().next().is_none());
        // folders: programs and documents
        let o = SourceOpts { mode: "folders".into(), kinds: k(&["app", "doc"]), ..o };
        assert_eq!(sync_sources(&[o.clone()], &content, &rec), 2);     // (Album C has neither)
        let v = list(&[dest.display().to_string()], &ctx);
        assert_eq!(v.iter().filter(|e| e.kind == "game").count(), 1);
        assert_eq!(v.iter().filter(|e| e.kind == "photo").count(), 1);
        let _ = fs::remove_dir_all(&root);
    }
    #[test]
    fn items_need_their_own_folder() {
        let root = std::env::temp_dir().join("xmb_section_test");
        let _ = fs::remove_dir_all(&root);
        for d in ["Song", "Clip", "My Game", "Trips/Beach", "Trips/Hill"] { fs::create_dir_all(root.join(d)).unwrap(); }
        fs::write(root.join("loose.mp3"), b"x").unwrap();                // loose: not listed
        fs::write(root.join("Song").join("song.mp3"), b"x").unwrap();
        fs::write(root.join("Song").join("icon.png"), b"x").unwrap();
        fs::write(root.join("Clip").join("clip.mp4"), b"x").unwrap();
        fs::write(root.join("Clip").join("item.json"), r#"{"title":"My Clip"}"#).unwrap();
        fs::write(root.join("Clip").join("preview.gif"), b"x").unwrap();
        fs::write(root.join("My Game").join("Game.exe"), b"x").unwrap();
        fs::write(root.join("Trips/Beach").join("a.jpg"), b"x").unwrap();
        fs::write(root.join("Trips/Hill").join("b.jpg"), b"x").unwrap();
        let none = |_: &Path| (None, None);
        let ctx = Ctx { icon_cache: &root, covers: &root, ffmpeg: None, video_icon: &none, wrap_in: None };
        let v = list(&[root.display().to_string()], &ctx);
        let kinds: Vec<_> = v.iter().map(|e| format!("{}:{}", e.kind, e.group)).collect();
        assert_eq!(v.len(), 5, "{kinds:?}");
        assert_eq!(v.iter().filter(|e| e.kind == "photo" && e.group == "Trips").count(), 2);
        let song = v.iter().find(|e| e.kind == "music").unwrap();
        assert!(song.meta.icon.is_some());
        assert_eq!(song.meta.title.as_deref(), Some("song"));
        let clip = v.iter().find(|e| e.kind == "video").unwrap();
        assert_eq!(clip.meta.title.as_deref(), Some("My Clip"));
        assert!(clip.meta.gif.is_some());
        let j: Value = serde_json::from_str(&fs::read_to_string(root.join("Song").join("item.json")).unwrap()).unwrap();
        assert_eq!(j["file"], "song.mp3");
        let _ = fs::remove_dir_all(&root);
    }
    #[test]
    fn loose_files_get_a_folder() {
        let root = std::env::temp_dir().join("xmb_section_wrap");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("clip.mp4"), b"x").unwrap();
        fs::write(root.join("notes.txt"), b"x").unwrap();
        let none = |_: &Path| (None, None);
        let ctx = Ctx { icon_cache: &root, covers: &root, ffmpeg: None, video_icon: &none, wrap_in: Some(&root) };
        let v = list(&[root.display().to_string()], &ctx);
        assert!(root.join("clip").join("clip.mp4").is_file());
        assert!(root.join("clip").join("item.json").is_file());
        assert!(root.join("notes.txt").is_file());
        assert_eq!(v.len(), 1);
        let _ = fs::remove_dir_all(&root);
    }
    #[test]
    fn a_folder_of_files_is_an_album() {
        let root = std::env::temp_dir().join("xmb_section_album");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Novels")).unwrap();
        fs::create_dir_all(root.join("One")).unwrap();
        fs::write(root.join("Novels").join("a.pdf"), b"x").unwrap();
        fs::write(root.join("Novels").join("b.pdf"), b"x").unwrap();
        fs::write(root.join("One").join("c.pdf"), b"x").unwrap();
        let none = |_: &Path| (None, None);
        let ctx = Ctx { icon_cache: &root, covers: &root, ffmpeg: None, video_icon: &none, wrap_in: Some(&root) };
        let v = list(&[root.display().to_string()], &ctx);
        assert_eq!(v.iter().filter(|e| e.group == "Novels").count(), 2);
        assert!(root.join("Novels").join("a").join("a.pdf").exists());
        assert_eq!(v.iter().filter(|e| e.group.is_empty()).count(), 1);   // "One": still one item
        let _ = fs::remove_dir_all(&root);
    }
    #[test]
    fn programs_get_program_json() {
        let root = std::env::temp_dir().join("xmb_section_prog");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Old")).unwrap();
        fs::create_dir_all(root.join("New")).unwrap();
        fs::write(root.join("Old").join("old.exe"), b"x").unwrap();
        fs::write(root.join("Old").join("game.json"), r#"{"title":"Old","isDisc":false,"console":"PS3"}"#).unwrap();
        fs::write(root.join("New").join("new.exe"), b"x").unwrap();
        let none = |_: &Path| (None, None);
        let ctx = Ctx { icon_cache: &root, covers: &root, ffmpeg: None, video_icon: &none, wrap_in: Some(&root) };
        let v = list(&[root.display().to_string()], &ctx);
        for d in ["Old", "New"] {
            assert!(root.join(d).join("program.json").exists() && !root.join(d).join("game.json").exists());
            let t = fs::read_to_string(root.join(d).join("program.json")).unwrap();
            assert!(!t.contains("isDisc") && t.contains("\"PC\""), "{t}");
        }
        assert!(v.iter().all(|e| e.game.as_ref().map(|g| g.console == "PC").unwrap_or(false)));
        let _ = fs::remove_dir_all(&root);
    }
}