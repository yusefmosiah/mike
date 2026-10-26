//! Finding an app to open from the freedesktop `.desktop` entries, by its
//! name or by its id (the file name without `.desktop`, or the entry's
//! `StartupWMClass`, which is also the WM_CLASS the helper reports).

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopEntry {
    /// The file name without `.desktop`.
    pub id: String,
    pub name: String,
    /// The command line, split, with field codes (`%u`, `%F`, ...) removed.
    pub exec: Vec<String>,
    pub wm_class: Option<String>,
}

impl DesktopEntry {
    /// The ids a window of this app may report as its WM_CLASS.
    pub fn window_classes(&self) -> Vec<String> {
        let mut classes = vec![self.id.to_lowercase()];
        if let Some(c) = &self.wm_class {
            classes.push(c.to_lowercase());
        }
        if let Some(program) = self.exec.first() {
            let base = Path::new(program)
                .file_name()
                .map(|n| n.to_string_lossy().to_lowercase());
            classes.extend(base);
        }
        classes
    }
}

/// Parse one `.desktop` file; None for hidden entries and anything not an
/// application with a command.
pub fn parse(id: &str, text: &str) -> Option<DesktopEntry> {
    let mut in_entry = false;
    let (mut name, mut exec, mut wm_class) = (None, None, None);
    let mut application = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_entry {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            "Name" => name = Some(value.trim().to_string()),
            "Exec" => exec = Some(split_exec(value.trim())),
            "StartupWMClass" => wm_class = Some(value.trim().to_string()),
            "Type" => application = value.trim() == "Application",
            "NoDisplay" | "Hidden" if value.trim() == "true" => return None,
            _ => {}
        }
    }
    let exec = exec.filter(|e| !e.is_empty())?;
    application.then(|| DesktopEntry {
        id: id.to_string(),
        name: name.unwrap_or_else(|| id.to_string()),
        exec,
        wm_class,
    })
}

/// Split an `Exec` value as the spec quotes it, dropping field codes.
pub fn split_exec(exec: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let (mut quoted, mut escaped, mut started) = (false, false, false);
    for c in exec.chars() {
        if escaped {
            current.push(c);
            escaped = false;
        } else if c == '\\' && quoted {
            escaped = true;
        } else if c == '"' {
            quoted = !quoted;
            started = true;
        } else if c.is_whitespace() && !quoted {
            if started {
                args.push(std::mem::take(&mut current));
                started = false;
            }
        } else {
            current.push(c);
            started = true;
        }
    }
    if started {
        args.push(current);
    }
    args.into_iter()
        .filter(|a| !(a.len() == 2 && a.starts_with('%')))
        .map(|a| a.replace("%%", "%"))
        .collect()
}

/// Where `.desktop` files live: `$XDG_DATA_HOME` (or `~/.local/share`) and
/// each of `$XDG_DATA_DIRS` (or `/usr/local/share:/usr/share`).
pub fn search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    match std::env::var_os("XDG_DATA_HOME") {
        Some(home) if !home.is_empty() => dirs.push(PathBuf::from(home)),
        _ => dirs.extend(std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share"))),
    }
    let data = std::env::var("XDG_DATA_DIRS")
        .ok()
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| "/usr/local/share:/usr/share".into());
    dirs.extend(data.split(':').filter(|d| !d.is_empty()).map(PathBuf::from));
    dirs.into_iter().map(|d| d.join("applications")).collect()
}

/// Every application entry in `dirs`; an earlier directory's entry wins over
/// a later one with the same id, as the spec says.
pub fn entries(dirs: &[PathBuf]) -> Vec<DesktopEntry> {
    let mut found: Vec<DesktopEntry> = Vec::new();
    for dir in dirs {
        let Ok(read) = std::fs::read_dir(dir) else {
            continue;
        };
        for file in read.flatten() {
            let path = file.path();
            if path.extension().is_none_or(|e| e != "desktop") {
                continue;
            }
            let Some(id) = path.file_stem().map(|s| s.to_string_lossy().into_owned()) else {
                continue;
            };
            if found.iter().any(|e| e.id == id) {
                continue;
            }
            if let Some(entry) = std::fs::read_to_string(&path)
                .ok()
                .and_then(|text| parse(&id, &text))
            {
                found.push(entry);
            }
        }
    }
    found
}

/// The entry an `open_app` names: an exact id or WM class first, then an
/// exact name, then a name that starts with what was asked.
pub fn find<'a>(
    entries: &'a [DesktopEntry],
    name: Option<&str>,
    id: Option<&str>,
) -> Option<&'a DesktopEntry> {
    let norm = |s: &str| s.trim().to_lowercase();
    if let Some(id) = id.map(norm).filter(|s| !s.is_empty())
        && let Some(e) = entries.iter().find(|e| {
            e.id.to_lowercase() == id || e.wm_class.as_deref().map(norm).as_deref() == Some(&id)
        })
    {
        return Some(e);
    }
    let name = name.map(norm).filter(|s| !s.is_empty())?;
    entries
        .iter()
        .find(|e| norm(&e.name) == name || e.id.to_lowercase() == name)
        .or_else(|| entries.iter().find(|e| norm(&e.name).starts_with(&name)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIREFOX: &str = "[Desktop Entry]\nName=Firefox ESR\nExec=/usr/lib/firefox-esr/firefox-esr %u\nType=Application\nStartupWMClass=Firefox-esr\n\n[Desktop Action new-window]\nName=New Window\nExec=firefox-esr --new-window\n";

    #[test]
    fn parses_an_entry_and_skips_actions_and_hidden_ones() {
        let e = parse("firefox-esr", FIREFOX).unwrap();
        assert_eq!(e.name, "Firefox ESR");
        assert_eq!(e.exec, vec!["/usr/lib/firefox-esr/firefox-esr"]);
        assert_eq!(e.wm_class.as_deref(), Some("Firefox-esr"));
        assert!(e.window_classes().contains(&"firefox-esr".to_string()));
        assert!(
            parse(
                "x",
                "[Desktop Entry]\nName=X\nExec=x\nType=Application\nNoDisplay=true\n"
            )
            .is_none()
        );
        assert!(parse("x", "[Desktop Entry]\nName=X\nType=Application\n").is_none());
        assert!(parse("x", "[Desktop Entry]\nName=X\nExec=x\nType=Link\n").is_none());
    }

    #[test]
    fn splits_quoted_exec_lines() {
        assert_eq!(
            split_exec(r#"sh -c "echo \"hi there\"" %F 100%%"#),
            vec!["sh", "-c", "echo \"hi there\"", "100%"]
        );
        assert_eq!(split_exec(r#"app """#), vec!["app", ""]);
    }

    #[test]
    fn finds_by_id_class_or_name() {
        let entries = vec![
            parse(
                "org.gnome.TextEditor",
                "[Desktop Entry]\nName=Text Editor\nExec=gnome-text-editor\nType=Application\n",
            )
            .unwrap(),
            parse("firefox-esr", FIREFOX).unwrap(),
        ];
        let id = |e: Option<&DesktopEntry>| e.map(|e| e.id.clone());
        assert_eq!(
            id(find(&entries, None, Some("FIREFOX-ESR"))),
            Some("firefox-esr".into())
        );
        assert_eq!(
            id(find(&entries, Some("text editor"), None)),
            Some("org.gnome.TextEditor".into())
        );
        assert_eq!(
            id(find(&entries, Some("Firefox"), None)),
            Some("firefox-esr".into())
        );
        assert_eq!(id(find(&entries, Some("nope"), Some("nope"))), None);
        assert_eq!(id(find(&entries, None, None)), None);
    }

    #[test]
    fn reads_a_directory_and_the_first_id_wins() {
        let root = std::env::temp_dir().join(format!("desktop-test-{}", std::process::id()));
        let (a, b) = (root.join("a"), root.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("firefox-esr.desktop"), FIREFOX).unwrap();
        std::fs::write(
            b.join("firefox-esr.desktop"),
            FIREFOX.replace("Firefox ESR", "Other"),
        )
        .unwrap();
        std::fs::write(b.join("notes.txt"), "x").unwrap();
        let found = entries(&[a, b, root.join("missing")]);
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "Firefox ESR");
    }
}
