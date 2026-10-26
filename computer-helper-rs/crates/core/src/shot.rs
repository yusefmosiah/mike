//! The screenshot the model sees: the capture scaled to the mapping's size,
//! each element's ref drawn at its centre, encoded as a JPEG. The badge font
//! is a built-in bitmap of the characters refs use ("e" and digits), so no
//! font file ships with the helper.

use base64::Engine;
use image::{Rgb, RgbImage, RgbaImage, imageops};

use crate::protocol::{Element, Screenshot};
use crate::screen::ScreenMapping;

pub const JPEG_QUALITY: u8 = 70;
const GLYPH_W: u32 = 3;
const GLYPH_H: u32 = 5;
const PIXEL: u32 = 2;
const PAD: u32 = 2;
const BADGE: Rgb<u8> = Rgb([200, 30, 30]);
const INK: Rgb<u8> = Rgb([255, 255, 255]);

/// 3x5 glyphs, one row per byte, three low bits per row (left bit first).
fn glyph(c: char) -> Option<[u8; 5]> {
    Some(match c {
        '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b111, 0b001, 0b111, 0b100, 0b111],
        '3' => [0b111, 0b001, 0b111, 0b001, 0b111],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b111, 0b001, 0b111],
        '6' => [0b111, 0b100, 0b111, 0b101, 0b111],
        '7' => [0b111, 0b001, 0b010, 0b010, 0b010],
        '8' => [0b111, 0b101, 0b111, 0b101, 0b111],
        '9' => [0b111, 0b101, 0b111, 0b001, 0b111],
        'e' => [0b000, 0b111, 0b111, 0b100, 0b111],
        _ => return None,
    })
}

fn put(image: &mut RgbImage, x: i64, y: i64, color: Rgb<u8>) {
    if x >= 0 && y >= 0 && (x as u32) < image.width() && (y as u32) < image.height() {
        image.put_pixel(x as u32, y as u32, color);
    }
}

/// Draw `text` in a filled badge centred on (cx, cy), clipped to the image.
pub fn draw_badge(image: &mut RgbImage, text: &str, cx: f64, cy: f64) {
    let glyphs: Vec<[u8; 5]> = text.chars().filter_map(glyph).collect();
    if glyphs.is_empty() {
        return;
    }
    let n = glyphs.len() as u32;
    let w = n * GLYPH_W * PIXEL + (n - 1) * PIXEL + 2 * PAD;
    let h = GLYPH_H * PIXEL + 2 * PAD;
    let left = cx.round() as i64 - (w / 2) as i64;
    let top = cy.round() as i64 - (h / 2) as i64;
    for dy in 0..h as i64 {
        for dx in 0..w as i64 {
            put(image, left + dx, top + dy, BADGE);
        }
    }
    for (i, rows) in glyphs.iter().enumerate() {
        let gx = left + PAD as i64 + (i as u32 * (GLYPH_W + 1) * PIXEL) as i64;
        for (row, bits) in rows.iter().enumerate() {
            for col in 0..GLYPH_W {
                if bits & (1 << (GLYPH_W - 1 - col)) == 0 {
                    continue;
                }
                for py in 0..PIXEL {
                    for px in 0..PIXEL {
                        put(
                            image,
                            gx + (col * PIXEL + px) as i64,
                            top + PAD as i64 + (row as u32 * PIXEL + py) as i64,
                            INK,
                        );
                    }
                }
            }
        }
    }
}

/// Scale a capture of the mapped display, badge every element, and encode it.
pub fn render(
    capture: &RgbaImage,
    mapping: &ScreenMapping,
    elements: &[Element],
) -> Result<Screenshot, String> {
    let (width, height) = mapping.pixel_size();
    if width == 0 || height == 0 {
        return Err("the display has no size".into());
    }
    let rgb = image::DynamicImage::ImageRgba8(capture.clone()).into_rgb8();
    let mut scaled = if rgb.dimensions() == (width, height) {
        rgb
    } else {
        imageops::resize(&rgb, width, height, imageops::FilterType::Triangle)
    };
    for element in elements {
        let f = element.frame;
        draw_badge(
            &mut scaled,
            &element.r#ref,
            f.x + f.w / 2.0,
            f.y + f.h / 2.0,
        );
    }
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY)
        .encode_image(&scaled)
        .map_err(|e| format!("could not encode the screenshot: {e}"))?;
    Ok(Screenshot {
        data: base64::engine::general_purpose::STANDARD.encode(jpeg),
        mime_type: "image/jpeg".into(),
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ElementFrame;
    use crate::screen::Rect;

    #[test]
    fn draws_a_badge_where_the_element_is() {
        let mut image = RgbImage::from_pixel(100, 60, Rgb([0, 0, 0]));
        draw_badge(&mut image, "e12", 50.0, 30.0);
        assert_eq!(*image.get_pixel(50, 30 - 6), BADGE);
        assert!(image.pixels().any(|p| *p == INK));
        assert_eq!(*image.get_pixel(5, 5), Rgb([0, 0, 0]));
        // A badge at the edge is clipped, not a panic.
        draw_badge(&mut image, "e1", 0.0, 0.0);
        draw_badge(&mut image, "e1", 99.0, 59.0);
    }

    #[test]
    fn renders_a_scaled_jpeg_of_the_mapped_size() {
        let capture = RgbaImage::from_pixel(2560, 1440, image::Rgba([240, 240, 240, 255]));
        let mapping = ScreenMapping::new(Rect {
            x: 0.0,
            y: 0.0,
            w: 2560.0,
            h: 1440.0,
        });
        let element = Element {
            r#ref: "e1".into(),
            role: "button".into(),
            native_role: None,
            title: Some("Save".into()),
            value: None,
            description: None,
            frame: ElementFrame {
                x: 100.0,
                y: 100.0,
                w: 80.0,
                h: 30.0,
            },
            enabled: None,
            focused: None,
        };
        let shot = render(&capture, &mapping, &[element]).unwrap();
        assert_eq!((shot.width, shot.height), (1280, 720));
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&shot.data)
            .unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap().into_rgb8();
        assert_eq!(decoded.dimensions(), (1280, 720));
        let p = decoded.get_pixel(140, 115 - 6);
        assert!(
            p[0] > 150 && p[1] < 100,
            "badge colour survives JPEG: {p:?}"
        );
    }
}
