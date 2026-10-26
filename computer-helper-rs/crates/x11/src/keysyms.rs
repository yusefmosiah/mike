//! X11 keysyms for the neutral keys in [`computer_core::keys`] and for
//! typed characters.

use computer_core::keys::Key;

pub const SHIFT: u32 = 0xffe1;
pub const CONTROL: u32 = 0xffe3;
pub const ALT: u32 = 0xffe9;
pub const SUPER: u32 = 0xffeb;
pub const RETURN: u32 = 0xff0d;
pub const TAB: u32 = 0xff09;

pub fn for_key(key: Key) -> u32 {
    match key {
        Key::Char(c) => for_char(c),
        Key::Return => RETURN,
        Key::Tab => TAB,
        Key::Space => 0x20,
        Key::Backspace => 0xff08,
        Key::Delete => 0xffff,
        Key::Escape => 0xff1b,
        Key::Home => 0xff50,
        Key::End => 0xff57,
        Key::PageUp => 0xff55,
        Key::PageDown => 0xff56,
        Key::Left => 0xff51,
        Key::Up => 0xff52,
        Key::Right => 0xff53,
        Key::Down => 0xff54,
        Key::Insert => 0xff63,
        Key::F(n) => 0xffbe + u32::from(n.clamp(1, 24)) - 1,
    }
}

/// The keysym that types `c`: Latin-1 keysyms are the code point, control
/// characters have their own, and everything else is 0x0100_0000 + the code
/// point (X11's Unicode keysyms).
pub fn for_char(c: char) -> u32 {
    match c {
        '\n' | '\r' => RETURN,
        '\t' => TAB,
        ' '..='~' | '\u{a0}'..='\u{ff}' => c as u32,
        _ => 0x0100_0000 + c as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_keys_and_characters() {
        assert_eq!(for_key(Key::Char('a')), 0x61);
        assert_eq!(for_key(Key::F(1)), 0xffbe);
        assert_eq!(for_key(Key::F(12)), 0xffc9);
        assert_eq!(for_key(Key::Return), 0xff0d);
        assert_eq!(for_char('é'), 0xe9);
        assert_eq!(for_char('—'), 0x0100_2014);
        assert_eq!(for_char('\n'), RETURN);
        assert_eq!(for_char('🙂'), 0x0101_f642);
    }
}
