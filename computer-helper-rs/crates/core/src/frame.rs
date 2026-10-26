//! The latest observation: its id, and where each ref's element was. An act
//! whose frame id is not the latest is refused when it aims at a ref or a
//! point, because the screen it was planned against may be gone.

use std::collections::HashMap;

use crate::screen::{Rect, ScreenMapping};

/// One observation, as a backend remembers it. `E` is the platform's handle
/// to an element (a UIA element, an AT-SPI object path), kept for actions
/// such as Invoke or DoAction that need no coordinates.
pub struct Frame<E> {
    pub id: String,
    pub mapping: ScreenMapping,
    pub elements: HashMap<String, FrameElement<E>>,
}

pub struct FrameElement<E> {
    pub handle: E,
    pub role: String,
    /// Screen coordinates.
    pub rect: Rect,
}

/// A short random frame id.
pub fn new_frame_id() -> String {
    use rand::Rng;
    let n: u64 = rand::rng().random();
    format!("f{:012x}", n & 0xffff_ffff_ffff)
}

impl<E> Frame<E> {
    pub fn new(mapping: ScreenMapping) -> Self {
        Self {
            id: new_frame_id(),
            mapping,
            elements: HashMap::new(),
        }
    }

    /// Where an action aims, in screen coordinates: a ref's centre, or a
    /// screenshot point mapped back to the screen.
    pub fn target(
        &self,
        element_ref: Option<&str>,
        x: Option<f64>,
        y: Option<f64>,
    ) -> Result<(f64, f64), String> {
        if let Some(r) = element_ref {
            return self
                .elements
                .get(r)
                .map(|e| e.rect.center())
                .ok_or_else(|| format!("no element {r} in this frame"));
        }
        match (x, y) {
            (Some(x), Some(y)) => {
                let (w, h) = self.mapping.pixel_size();
                if x < 0.0 || y < 0.0 || x >= w as f64 || y >= h as f64 {
                    return Err(format!("({x}, {y}) is outside the {w}x{h} screenshot"));
                }
                Ok(self.mapping.to_screen(x, y))
            }
            _ => Err("needs a ref or x and y".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aims_at_refs_and_points() {
        let mut frame: Frame<()> = Frame::new(ScreenMapping::new(Rect {
            x: 0.0,
            y: 0.0,
            w: 2560.0,
            h: 1600.0,
        }));
        frame.elements.insert(
            "e1".into(),
            FrameElement {
                handle: (),
                role: "button".into(),
                rect: Rect {
                    x: 100.0,
                    y: 200.0,
                    w: 50.0,
                    h: 20.0,
                },
            },
        );
        assert_eq!(frame.target(Some("e1"), None, None), Ok((125.0, 210.0)));
        assert_eq!(frame.target(None, Some(10.0), Some(20.0)), Ok((20.0, 40.0)));
        assert!(frame.target(Some("e9"), None, None).is_err());
        assert!(frame.target(None, Some(1280.0), Some(0.0)).is_err());
        assert!(frame.target(None, None, None).is_err());
        assert!(frame.id.starts_with('f') && frame.id.len() == 13);
    }
}
