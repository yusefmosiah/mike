//! The X11 backend for a computer helper: the agent's own sandboxed desktop,
//! and a person's Linux X11 session. The element tree comes from AT-SPI,
//! input from XTest, and screenshots from the X server. The platform glue
//! builds on Linux only; the parts below it are plain logic, tested
//! everywhere.

pub mod config;
pub mod desktop;
pub mod keysyms;
pub mod roles;

#[cfg(target_os = "linux")]
mod a11y;
#[cfg(target_os = "linux")]
mod backend;
#[cfg(target_os = "linux")]
pub mod display;

#[cfg(target_os = "linux")]
pub use backend::X11Backend;
