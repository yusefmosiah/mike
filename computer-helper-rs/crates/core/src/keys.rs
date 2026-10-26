//! Key combos ("cmd+s", "ctrl+shift+t", "return", "f5") parsed into
//! platform-neutral keys and modifiers. A backend maps [`Key`] to its own
//! codes (Windows virtual keys, X11 keysyms).
//!
//! `cmd` means the platform's primary shortcut modifier: Command on macOS,
//! Ctrl on Windows and Linux, so a model that writes "cmd+s" saves on every
//! platform. `super`, `win` and `meta` mean the logo key.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Modifiers {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    /// The Windows / Super key.
    pub logo: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    /// A letter, digit or punctuation mark, lower-case as on a US keyboard.
    Char(char),
    Return,
    Tab,
    Space,
    Backspace,
    Delete,
    Escape,
    Home,
    End,
    PageUp,
    PageDown,
    Left,
    Right,
    Up,
    Down,
    Insert,
    /// F1 to F24.
    F(u8),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Combo {
    pub key: Key,
    pub modifiers: Modifiers,
}

const PUNCTUATION: &str = "=-[];',./\\`";

fn named_key(name: &str) -> Option<Key> {
    Some(match name {
        "return" | "enter" => Key::Return,
        "tab" => Key::Tab,
        "space" => Key::Space,
        "backspace" => Key::Backspace,
        "delete" | "forwarddelete" | "del" => Key::Delete,
        "escape" | "esc" => Key::Escape,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "left" | "arrowleft" => Key::Left,
        "right" | "arrowright" => Key::Right,
        "up" | "arrowup" => Key::Up,
        "down" | "arrowdown" => Key::Down,
        "insert" => Key::Insert,
        _ => {
            if let Some(n) = name.strip_prefix('f').and_then(|n| n.parse::<u8>().ok()) {
                return (1..=24).contains(&n).then_some(Key::F(n));
            }
            let mut chars = name.chars();
            let c = chars.next()?;
            if chars.next().is_some() {
                return None;
            }
            if c.is_ascii_alphanumeric() || PUNCTUATION.contains(c) {
                Key::Char(c)
            } else {
                return None;
            }
        }
    })
}

/// Parse a combo; None for an unknown key or modifier.
pub fn parse(combo: &str) -> Option<Combo> {
    let raw = combo.trim().to_lowercase();
    if raw.is_empty() {
        return None;
    }
    let parts: Vec<&str> = raw.split('+').map(str::trim).collect();
    let (key_name, modifier_names) = parts.split_last()?;
    let mut modifiers = Modifiers::default();
    for name in modifier_names {
        match *name {
            "cmd" | "command" | "ctrl" | "control" => modifiers.ctrl = true,
            "alt" | "opt" | "option" => modifiers.alt = true,
            "shift" => modifiers.shift = true,
            "super" | "win" | "windows" | "meta" | "logo" => modifiers.logo = true,
            _ => return None,
        }
    }
    Some(Combo {
        key: named_key(key_name)?,
        modifiers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_combos_platform_neutrally() {
        let save = parse("cmd+s").unwrap();
        assert_eq!(save.key, Key::Char('s'));
        assert!(save.modifiers.ctrl && !save.modifiers.logo);
        assert_eq!(
            parse("Ctrl + Shift + T").unwrap().modifiers,
            Modifiers {
                ctrl: true,
                shift: true,
                ..Default::default()
            }
        );
        assert_eq!(
            parse("win+r").unwrap().modifiers,
            Modifiers {
                logo: true,
                ..Default::default()
            }
        );
        assert_eq!(parse("return").unwrap().key, Key::Return);
        assert_eq!(parse("f12").unwrap().key, Key::F(12));
        assert_eq!(parse("down").unwrap().key, Key::Down);
        assert_eq!(parse("/").unwrap().key, Key::Char('/'));
    }

    #[test]
    fn refuses_what_it_does_not_know() {
        for combo in [
            "",
            "hyper+s",
            "cmd+",
            "cmd++",
            "f25",
            "f0",
            "é",
            "ctrl+banana",
        ] {
            assert_eq!(parse(combo), None, "{combo}");
        }
    }
}
