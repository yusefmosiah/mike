//! The X server side: the screen size, screenshots (GetImage of the root
//! window), input through XTest, and the front window from the window
//! manager's EWMH properties.

use std::thread::sleep;
use std::time::Duration;

use computer_core::keys::Combo;
use image::RgbaImage;
use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::xproto::{
    self, AtomEnum, ConnectionExt as _, ImageFormat, ImageOrder, Window,
};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;

use crate::keysyms;

fn x(e: impl std::fmt::Display) -> String {
    format!("X server: {e}")
}

/// The front window, as the window manager reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub id: Window,
    /// WM_CLASS's class part ("Firefox-esr"), the helper's app id.
    pub class: Option<String>,
    pub title: Option<String>,
    pub pid: Option<u32>,
}

struct Atoms {
    active_window: u32,
    wm_name: u32,
    wm_pid: u32,
    utf8: u32,
}

pub struct Display {
    conn: RustConnection,
    root: Window,
    pub width: u16,
    pub height: u16,
    atoms: Atoms,
    min_keycode: u8,
    max_keycode: u8,
}

/// Mouse buttons in X11 numbering: 4 and 5 scroll up and down, 6 and 7 left and right.
pub const LEFT: u8 = 1;
pub const RIGHT: u8 = 3;

impl Display {
    /// Connect to `$DISPLAY` and check it has XTest.
    pub fn connect() -> Result<Self, String> {
        let (conn, screen) =
            x11rb::connect(None).map_err(|e| format!("cannot open the X display: {e}"))?;
        if conn
            .extension_information(x11rb::protocol::xtest::X11_EXTENSION_NAME)
            .map_err(x)?
            .is_none()
        {
            return Err(
                "the X server has no XTest extension, so the helper cannot click or type".into(),
            );
        }
        let setup = conn.setup();
        let root = &setup.roots[screen];
        let (root_window, width, height) = (root.root, root.width_in_pixels, root.height_in_pixels);
        let (min_keycode, max_keycode) = (setup.min_keycode, setup.max_keycode);
        let atom = |name: &str| -> Result<u32, String> {
            Ok(conn
                .intern_atom(false, name.as_bytes())
                .map_err(x)?
                .reply()
                .map_err(x)?
                .atom)
        };
        let atoms = Atoms {
            active_window: atom("_NET_ACTIVE_WINDOW")?,
            wm_name: atom("_NET_WM_NAME")?,
            wm_pid: atom("_NET_WM_PID")?,
            utf8: atom("UTF8_STRING")?,
        };
        Ok(Self {
            conn,
            root: root_window,
            width,
            height,
            atoms,
            min_keycode,
            max_keycode,
        })
    }

    /// A round trip, so every request sent so far has been handled.
    fn sync(&self) -> Result<(), String> {
        self.conn.get_input_focus().map_err(x)?.reply().map_err(x)?;
        Ok(())
    }

    // MARK: Screenshot

    /// The whole screen, with the pointer left out.
    pub fn capture(&self) -> Result<RgbaImage, String> {
        let reply = self
            .conn
            .get_image(
                ImageFormat::Z_PIXMAP,
                self.root,
                0,
                0,
                self.width,
                self.height,
                !0,
            )
            .map_err(x)?
            .reply()
            .map_err(x)?;
        let setup = self.conn.setup();
        let bits = setup
            .pixmap_formats
            .iter()
            .find(|f| f.depth == reply.depth)
            .map(|f| f.bits_per_pixel);
        if bits != Some(32) {
            return Err(format!(
                "the screen's pixel format (depth {}) is not supported",
                reply.depth
            ));
        }
        let lsb = setup.image_byte_order == ImageOrder::LSB_FIRST;
        let mut rgba = Vec::with_capacity(reply.data.len());
        for px in reply.data.as_chunks::<4>().0 {
            let (r, g, b) = if lsb {
                (px[2], px[1], px[0])
            } else {
                (px[1], px[2], px[3])
            };
            rgba.extend_from_slice(&[r, g, b, 255]);
        }
        RgbaImage::from_raw(u32::from(self.width), u32::from(self.height), rgba)
            .ok_or_else(|| "the screenshot came back the wrong size".into())
    }

    // MARK: Pointer

    fn fake(&self, kind: u8, detail: u8, px: i16, py: i16) -> Result<(), String> {
        self.conn
            .xtest_fake_input(kind, detail, x11rb::CURRENT_TIME, self.root, px, py, 0)
            .map_err(x)?;
        Ok(())
    }

    fn clamp(&self, px: f64, py: f64) -> (i16, i16) {
        let max_x = f64::from(self.width.saturating_sub(1));
        let max_y = f64::from(self.height.saturating_sub(1));
        (
            px.round().clamp(0.0, max_x) as i16,
            py.round().clamp(0.0, max_y) as i16,
        )
    }

    pub fn move_to(&self, px: f64, py: f64) -> Result<(), String> {
        let (px, py) = self.clamp(px, py);
        self.fake(xproto::MOTION_NOTIFY_EVENT, 0, px, py)?;
        self.sync()
    }

    pub fn click(&self, px: f64, py: f64, button: u8, count: u32) -> Result<(), String> {
        self.move_to(px, py)?;
        sleep(Duration::from_millis(30));
        for _ in 0..count {
            self.fake(xproto::BUTTON_PRESS_EVENT, button, 0, 0)?;
            self.fake(xproto::BUTTON_RELEASE_EVENT, button, 0, 0)?;
            self.sync()?;
            sleep(Duration::from_millis(40));
        }
        Ok(())
    }

    /// Scroll by lines; positive `dy` scrolls down and positive `dx` right,
    /// as on the other platforms.
    pub fn scroll(&self, dx: f64, dy: f64) -> Result<(), String> {
        let wheel = |button: u8, lines: f64| -> Result<(), String> {
            for _ in 0..(lines.abs().round() as u32) {
                self.fake(xproto::BUTTON_PRESS_EVENT, button, 0, 0)?;
                self.fake(xproto::BUTTON_RELEASE_EVENT, button, 0, 0)?;
            }
            Ok(())
        };
        wheel(if dy < 0.0 { 4 } else { 5 }, dy)?;
        wheel(if dx < 0.0 { 6 } else { 7 }, dx)?;
        self.sync()
    }

    // MARK: Keyboard

    fn keymap(&self) -> Result<(usize, Vec<u32>), String> {
        let count = self.max_keycode - self.min_keycode + 1;
        let reply = self
            .conn
            .get_keyboard_mapping(self.min_keycode, count)
            .map_err(x)?
            .reply()
            .map_err(x)?;
        Ok((usize::from(reply.keysyms_per_keycode), reply.keysyms))
    }

    /// The keycode that makes `sym`, and whether it needs Shift.
    fn find(&self, sym: u32) -> Result<Option<(u8, bool)>, String> {
        let (per, syms) = self.keymap()?;
        for (i, row) in syms.chunks(per.max(1)).enumerate() {
            let code = self.min_keycode + i as u8;
            if row.first() == Some(&sym) {
                return Ok(Some((code, false)));
            }
            if row.get(1) == Some(&sym) {
                return Ok(Some((code, true)));
            }
        }
        Ok(None)
    }

    /// A keycode with nothing on it, to borrow for characters the keyboard
    /// layout lacks.
    fn scratch(&self) -> Result<(u8, usize), String> {
        let (per, syms) = self.keymap()?;
        syms.chunks(per.max(1))
            .enumerate()
            .rev()
            .find(|(_, row)| row.iter().all(|s| *s == 0))
            .map(|(i, _)| (self.min_keycode + i as u8, per))
            .ok_or_else(|| "the keyboard has no free key to type unusual characters with".into())
    }

    fn tap(&self, code: u8, shift: bool) -> Result<(), String> {
        let shift_code = if shift {
            self.find(keysyms::SHIFT)?.map(|(c, _)| c)
        } else {
            None
        };
        if let Some(s) = shift_code {
            self.fake(xproto::KEY_PRESS_EVENT, s, 0, 0)?;
        }
        self.fake(xproto::KEY_PRESS_EVENT, code, 0, 0)?;
        self.fake(xproto::KEY_RELEASE_EVENT, code, 0, 0)?;
        if let Some(s) = shift_code {
            self.fake(xproto::KEY_RELEASE_EVENT, s, 0, 0)?;
        }
        self.sync()
    }

    /// Type one character: from the layout when it has the character,
    /// otherwise by putting its keysym on a spare keycode for the moment.
    pub fn type_char(&self, c: char) -> Result<(), String> {
        let sym = keysyms::for_char(c);
        if let Some((code, shift)) = self.find(sym)? {
            return self.tap(code, shift);
        }
        let (code, per) = self.scratch()?;
        self.conn
            .change_keyboard_mapping(1, code, per as u8, &vec![sym; per])
            .map_err(x)?;
        self.sync()?;
        // Clients refresh their keymap on MappingNotify; give them a moment.
        sleep(Duration::from_millis(20));
        let typed = self.tap(code, false);
        sleep(Duration::from_millis(20));
        self.conn
            .change_keyboard_mapping(1, code, per as u8, &vec![0; per])
            .map_err(x)?;
        self.sync()?;
        typed
    }

    pub fn press(&self, combo: &Combo) -> Result<(), String> {
        let sym = keysyms::for_key(combo.key);
        let (code, shift) = self
            .find(sym)?
            .ok_or_else(|| "the keyboard has no such key".to_string())?;
        let m = combo.modifiers;
        let mut held = Vec::new();
        for (on, modifier) in [
            (m.ctrl, keysyms::CONTROL),
            (m.alt, keysyms::ALT),
            (m.shift || shift, keysyms::SHIFT),
            (m.logo, keysyms::SUPER),
        ] {
            if on && let Some((c, _)) = self.find(modifier)? {
                self.fake(xproto::KEY_PRESS_EVENT, c, 0, 0)?;
                held.push(c);
            }
        }
        self.fake(xproto::KEY_PRESS_EVENT, code, 0, 0)?;
        self.fake(xproto::KEY_RELEASE_EVENT, code, 0, 0)?;
        for c in held.into_iter().rev() {
            self.fake(xproto::KEY_RELEASE_EVENT, c, 0, 0)?;
        }
        self.sync()
    }

    // MARK: Windows

    fn property(&self, window: Window, atom: u32, kind: u32) -> Result<Vec<u8>, String> {
        Ok(self
            .conn
            .get_property(false, window, atom, kind, 0, 1024)
            .map_err(x)?
            .reply()
            .map_err(x)?
            .value)
    }

    fn property32(&self, window: Window, atom: u32, kind: AtomEnum) -> Result<Option<u32>, String> {
        let reply = self
            .conn
            .get_property(false, window, atom, kind, 0, 1)
            .map_err(x)?
            .reply()
            .map_err(x)?;
        Ok(reply.value32().and_then(|mut v| v.next()))
    }

    pub fn active_window(&self) -> Result<Option<WindowInfo>, String> {
        let Some(id) = self
            .property32(self.root, self.atoms.active_window, AtomEnum::WINDOW)?
            .filter(|w| *w != 0)
        else {
            return Ok(None);
        };
        let class =
            wm_class(&self.property(id, AtomEnum::WM_CLASS.into(), AtomEnum::STRING.into())?);
        let title = Some(self.property(id, self.atoms.wm_name, self.atoms.utf8)?)
            .filter(|v| !v.is_empty())
            .or_else(|| {
                self.property(id, AtomEnum::WM_NAME.into(), AtomEnum::STRING.into())
                    .ok()
            })
            .map(|v| String::from_utf8_lossy(&v).into_owned())
            .filter(|t| !t.is_empty());
        let pid = self.property32(id, self.atoms.wm_pid, AtomEnum::CARDINAL)?;
        Ok(Some(WindowInfo {
            id,
            class,
            title,
            pid,
        }))
    }
}

/// WM_CLASS is "instance\0Class\0"; the class names the app.
pub fn wm_class(value: &[u8]) -> Option<String> {
    let mut parts = value.split(|b| *b == 0).filter(|p| !p.is_empty());
    let instance = parts.next();
    parts
        .next()
        .or(instance)
        .map(|p| String::from_utf8_lossy(p).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_class_from_wm_class() {
        assert_eq!(
            wm_class(b"Navigator\0firefox-esr\0").as_deref(),
            Some("firefox-esr")
        );
        assert_eq!(wm_class(b"xterm\0").as_deref(), Some("xterm"));
        assert_eq!(wm_class(b""), None);
    }
}
