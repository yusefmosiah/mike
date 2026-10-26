//! The platform-neutral half of a computer helper. A platform backend
//! (Windows, Linux X11, Linux Wayland) supplies the element tree, the
//! screenshot and the input; everything a helper decides lives here, so every
//! platform decides it the same way.
//!
//! - [`protocol`]: the wire types in `packages/contracts` ("Computers").
//! - [`policy`]: limits, the blocked/allowed apps check, batch validation.
//! - [`keys`]: key combos parsed into platform-neutral keys and modifiers.
//! - [`screen`]: mapping between screen coordinates and screenshot pixels.
//! - [`shot`]: scaling a capture, drawing ref badges, encoding the JPEG.
//! - [`frame`]: the latest observation, so stale refs are refused.

pub mod frame;
pub mod keys;
pub mod policy;
pub mod protocol;
pub mod screen;
pub mod shot;
