//! The element tree over AT-SPI: the front window's accessible objects, with
//! their roles, text and screen rectangles, and the elements' own actions.

use async_io::block_on;
use atspi::proxy::accessible::{AccessibleProxy, ObjectRefExt};
use atspi::proxy::proxy_ext::ProxyExt;
use atspi::{AccessibilityConnection, CoordType, Interface, ObjectRefOwned, State};
use computer_core::policy;
use computer_core::screen::Rect;

use crate::roles;

const MAX_DEPTH: usize = 40;
const MAX_VISITED: usize = 3000;
const MAX_VALUE_CHARS: i32 = 200;

fn a(e: impl std::fmt::Display) -> String {
    format!("accessibility: {e}")
}

/// One element worth listing.
#[derive(Debug, Clone)]
pub struct Node {
    pub handle: ObjectRefOwned,
    pub native_role: String,
    pub rect: Rect,
    pub title: Option<String>,
    pub value: Option<String>,
    pub description: Option<String>,
    pub enabled: bool,
    pub focused: bool,
}

pub struct Walk {
    pub nodes: Vec<Node>,
    pub truncated: bool,
}

/// The front window's accessible, and its app's name.
pub struct Window {
    pub handle: ObjectRefOwned,
    pub app_name: Option<String>,
    pub title: Option<String>,
}

pub struct A11y {
    conn: AccessibilityConnection,
}

impl A11y {
    /// Connect to the accessibility bus, first asking apps on the session
    /// bus to turn their accessibility on.
    pub fn connect() -> Result<Self, String> {
        block_on(async {
            let _ = atspi::connection::set_session_accessibility(true).await;
            AccessibilityConnection::new()
                .await
                .map(|conn| Self { conn })
        })
        .map_err(a)
    }

    fn zbus(&self) -> &zbus::Connection {
        self.conn.connection()
    }

    async fn proxy<'a>(&'a self, obj: &'a ObjectRefOwned) -> Result<AccessibleProxy<'a>, String> {
        obj.as_accessible_proxy(self.zbus()).await.map_err(a)
    }

    async fn pid_of(&self, app: &ObjectRefOwned) -> Option<u32> {
        let name = app.name()?.clone();
        let dbus = zbus::fdo::DBusProxy::new(self.zbus()).await.ok()?;
        dbus.get_connection_unix_process_id(name.into()).await.ok()
    }

    /// The top-level window of the app with this process id: its active
    /// frame, else the one with this title, else the first showing. With no
    /// process id, any app's active frame.
    pub fn window(&self, pid: Option<u32>, title: Option<&str>) -> Result<Option<Window>, String> {
        block_on(async {
            let root = self.conn.root_accessible_on_registry().await.map_err(a)?;
            let apps = root.get_children().await.map_err(a)?;
            for app in &apps {
                if let Some(pid) = pid
                    && self.pid_of(app).await != Some(pid)
                {
                    continue;
                }
                let Ok(app_proxy) = self.proxy(app).await else {
                    continue;
                };
                let app_name = app_proxy.name().await.ok().filter(|n| !n.is_empty());
                let frames = app_proxy.get_children().await.unwrap_or_default();
                let mut best: Option<(u8, ObjectRefOwned, Option<String>)> = None;
                for frame in frames {
                    let Ok(p) = self.proxy(&frame).await else {
                        continue;
                    };
                    let state = p.get_state().await.unwrap_or_default();
                    let name = p.name().await.ok().filter(|n| !n.is_empty());
                    let score = if state.contains(State::Active) {
                        3
                    } else if title.is_some() && name.as_deref() == title {
                        2
                    } else if state.contains(State::Showing) {
                        1
                    } else {
                        0
                    };
                    if pid.is_none() && score < 3 {
                        continue;
                    }
                    if score > 0 && best.as_ref().is_none_or(|(s, ..)| score > *s) {
                        best = Some((score, frame.clone(), name));
                    }
                }
                if let Some((_, handle, name)) = best {
                    return Ok(Some(Window {
                        handle,
                        app_name,
                        title: name,
                    }));
                }
            }
            Ok(None)
        })
    }

    /// The listable elements under `window`, in reading order, skipping
    /// subtrees that are hidden or off the display.
    pub fn walk(
        &self,
        window: &ObjectRefOwned,
        display: Rect,
        limit: usize,
    ) -> Result<Walk, String> {
        block_on(async {
            let mut nodes = Vec::new();
            let mut truncated = false;
            let mut visited = 0;
            let mut stack = vec![(window.clone(), 0usize)];
            while let Some((obj, depth)) = stack.pop() {
                if visited >= MAX_VISITED {
                    truncated = true;
                    break;
                }
                if nodes.len() >= limit {
                    truncated = true;
                    break;
                }
                visited += 1;
                let Ok(p) = self.proxy(&obj).await else {
                    continue;
                };
                let state = p.get_state().await.unwrap_or_default();
                if depth > 0 && !state.contains(State::Showing) {
                    continue;
                }
                let rect = self.extents(&p).await;
                if let Some(r) = rect
                    && depth > 0
                    && r.w > 0.0
                    && r.h > 0.0
                    && !intersects(&r, &display)
                {
                    continue;
                }
                let native = p
                    .get_role()
                    .await
                    .map(|r| r.name().to_string())
                    .unwrap_or_default();
                if let Some(rect) = rect.filter(|r| listable(r, &display))
                    && let Some(node) = self.consider(&p, &obj, &native, rect, state).await
                {
                    nodes.push(node);
                }
                if depth < MAX_DEPTH {
                    let children = p.get_children().await.unwrap_or_default();
                    stack.extend(children.into_iter().rev().map(|c| (c, depth + 1)));
                }
            }
            Ok(Walk { nodes, truncated })
        })
    }

    async fn extents(&self, p: &AccessibleProxy<'_>) -> Option<Rect> {
        let component = p.proxies().await.ok()?.component().await.ok()?;
        let (x, y, w, h) = component.get_extents(CoordType::Screen).await.ok()?;
        Some(Rect {
            x: f64::from(x),
            y: f64::from(y),
            w: f64::from(w),
            h: f64::from(h),
        })
    }

    async fn consider(
        &self,
        p: &AccessibleProxy<'_>,
        obj: &ObjectRefOwned,
        native: &str,
        rect: Rect,
        state: atspi::StateSet,
    ) -> Option<Node> {
        if !(roles::actionable(native) || roles::textual(native)) {
            return None;
        }
        let title = policy::truncate(p.name().await.ok().as_deref());
        let description = policy::truncate(p.description().await.ok().as_deref());
        // Never read a password field; a label's text is usually its name again.
        let value = if roles::is_secret(native) {
            None
        } else {
            self.value(p).await.filter(|v| Some(v) != title.as_ref())
        };
        let has_text = title.is_some() || value.is_some() || description.is_some();
        if !(roles::actionable(native) || roles::textual(native) && has_text) {
            return None;
        }
        Some(Node {
            handle: obj.clone(),
            native_role: native.to_string(),
            rect,
            title,
            value,
            description,
            enabled: state.contains(State::Enabled) || state.contains(State::Sensitive),
            focused: state.contains(State::Focused),
        })
    }

    async fn value(&self, p: &AccessibleProxy<'_>) -> Option<String> {
        let proxies = p.proxies().await.ok()?;
        let interfaces = p.get_interfaces().await.ok()?;
        if interfaces.contains(Interface::Text) {
            let text = proxies.text().await.ok()?;
            let count = text.character_count().await.ok()?;
            let s = text.get_text(0, count.min(MAX_VALUE_CHARS)).await.ok()?;
            return policy::truncate(Some(&s.replace('\u{fffc}', "")));
        }
        if interfaces.contains(Interface::Value) {
            let v = proxies.value().await.ok()?.current_value().await.ok()?;
            return Some(format!("{v}"));
        }
        None
    }

    /// Run the element's press-like action. False when it has none.
    pub fn press(&self, obj: &ObjectRefOwned) -> Result<bool, String> {
        block_on(async {
            let p = self.proxy(obj).await?;
            let interfaces = p.get_interfaces().await.map_err(a)?;
            if !interfaces.contains(Interface::Action) {
                return Ok(false);
            }
            let action = p.proxies().await.map_err(a)?.action().await.map_err(a)?;
            let n = action.n_actions().await.map_err(a)?;
            for i in 0..n {
                let name = action.get_name(i).await.unwrap_or_default();
                if roles::is_press_action(&name) {
                    return action.do_action(i).await.map_err(a);
                }
            }
            Ok(false)
        })
    }

    /// Whether this element has keyboard focus now.
    pub fn is_focused(&self, obj: &ObjectRefOwned) -> bool {
        block_on(async {
            match self.proxy(obj).await {
                Ok(p) => p
                    .get_state()
                    .await
                    .map(|s| s.contains(State::Focused))
                    .unwrap_or(false),
                Err(_) => false,
            }
        })
    }
}

fn intersects(r: &Rect, d: &Rect) -> bool {
    r.x < d.x + d.w && d.x < r.x + r.w && r.y < d.y + d.h && d.y < r.y + r.h
}

/// Big enough to aim at, and centred on the display.
fn listable(r: &Rect, display: &Rect) -> bool {
    let (cx, cy) = r.center();
    r.w >= 2.0 && r.h >= 2.0 && display.contains(cx, cy)
}
