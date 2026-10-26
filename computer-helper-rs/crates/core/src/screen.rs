//! Mapping between screen coordinates (the display's own, top-left origin;
//! physical pixels on Windows and X11) and the screenshot the model sees,
//! whose long edge is at most [`crate::policy::SCREENSHOT_LONG_EDGE`].

use crate::policy::SCREENSHOT_LONG_EDGE;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn center(&self) -> (f64, f64) {
        (self.x + self.w / 2.0, self.y + self.h / 2.0)
    }

    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.w && y < self.y + self.h
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenMapping {
    /// The captured display, in screen coordinates.
    pub display: Rect,
    /// Screenshot pixels per screen unit; never above 1.
    pub scale: f64,
}

impl ScreenMapping {
    pub fn new(display: Rect) -> Self {
        let edge = display.w.max(display.h);
        let scale = if edge > 0.0 {
            (SCREENSHOT_LONG_EDGE / edge).min(1.0)
        } else {
            1.0
        };
        Self { display, scale }
    }

    pub fn pixel_size(&self) -> (u32, u32) {
        (
            (self.display.w * self.scale).round() as u32,
            (self.display.h * self.scale).round() as u32,
        )
    }

    pub fn to_pixels(&self, x: f64, y: f64) -> (f64, f64) {
        (
            (x - self.display.x) * self.scale,
            (y - self.display.y) * self.scale,
        )
    }

    pub fn to_screen(&self, x: f64, y: f64) -> (f64, f64) {
        (
            x / self.scale + self.display.x,
            y / self.scale + self.display.y,
        )
    }

    /// An element's frame in screenshot pixels, rounded as the wire carries it.
    pub fn frame(&self, rect: Rect) -> crate::protocol::ElementFrame {
        let (x, y) = self.to_pixels(rect.x, rect.y);
        crate::protocol::ElementFrame {
            x: x.round(),
            y: y.round(),
            w: (rect.w * self.scale).round(),
            h: (rect.h * self.scale).round(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scales_a_large_display_down_and_round_trips() {
        let m = ScreenMapping::new(Rect {
            x: 1920.0,
            y: 0.0,
            w: 2560.0,
            h: 1440.0,
        });
        assert_eq!(m.scale, 0.5);
        assert_eq!(m.pixel_size(), (1280, 720));
        assert_eq!(m.to_pixels(2000.0, 100.0), (40.0, 50.0));
        assert_eq!(m.to_screen(40.0, 50.0), (2000.0, 100.0));
    }

    #[test]
    fn never_upscales() {
        assert_eq!(
            ScreenMapping::new(Rect {
                x: 0.0,
                y: 0.0,
                w: 1024.0,
                h: 768.0
            })
            .scale,
            1.0
        );
    }
}
