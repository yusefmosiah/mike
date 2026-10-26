//! [`X11Backend`]: observe and act on an X11 desktop, the agent's own
//! sandbox or a person's Linux session.

use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

use atspi::ObjectRefOwned;
use computer_client::{Backend, Control, run_batch};
use computer_core::frame::{Frame, FrameElement};
use computer_core::keys;
use computer_core::policy::{self, Decision, HelperConfig};
use computer_core::protocol::{
    ActResult, Action, Button, Capabilities, Coordinates, Element, Observation, ObservedApp,
    Platform, SecureInput, Takeover,
};
use computer_core::screen::{Rect, ScreenMapping};
use computer_core::shot;

use crate::a11y::A11y;
use crate::desktop;
use crate::display::{self, Display};
use crate::roles;

pub struct X11Backend {
    display: Display,
    a11y: Result<A11y, String>,
    config: HelperConfig,
    platform: Platform,
    frame: Option<Frame<ObjectRefOwned>>,
}

impl X11Backend {
    pub fn new(config: HelperConfig, platform: Platform) -> Result<Self, String> {
        Ok(Self {
            display: Display::connect()?,
            a11y: A11y::connect(),
            config,
            platform,
            frame: None,
        })
    }

    fn display_rect(&self) -> Rect {
        Rect {
            x: 0.0,
            y: 0.0,
            w: f64::from(self.display.width),
            h: f64::from(self.display.height),
        }
    }

    /// The front app's id (its WM_CLASS class), when there is a front window.
    fn front_app(&self) -> Option<String> {
        self.display
            .active_window()
            .ok()
            .flatten()
            .and_then(|w| w.class)
    }

    /// Typing or clicking is refused while a password field from the last
    /// observation has focus, and in a blocked app.
    fn check_input_allowed(&self) -> Result<(), String> {
        if let (Some(frame), Ok(a11y)) = (&self.frame, &self.a11y) {
            let secret_focused = frame
                .elements
                .values()
                .filter(|e| roles::is_secret(&e.role))
                .any(|e| a11y.is_focused(&e.handle));
            if secret_focused {
                return Err("a password field has focus; the helper will not type or click".into());
            }
        }
        match policy::app(self.front_app().as_deref(), &self.config, self.platform) {
            Decision::Allow => Ok(()),
            Decision::Refuse(reason) => Err(reason),
        }
    }

    fn perform(&mut self, action: &Action) -> Result<(), String> {
        if let Action::OpenApp { name, bundle_id } = action {
            return self.open_app(name.as_deref(), bundle_id.as_deref());
        }
        self.check_input_allowed()?;
        let frame = self.frame.as_ref();
        let aim = |r: &Option<String>, x: &Option<f64>, y: &Option<f64>| {
            frame
                .ok_or_else(|| "observe first".to_string())
                .and_then(|f| f.target(r.as_deref(), *x, *y))
        };
        match action {
            Action::Click {
                r#ref,
                x,
                y,
                button,
                count,
            } => {
                if let (Some(r), Some(frame), Ok(a11y)) = (r#ref, frame, &self.a11y) {
                    let element = frame
                        .elements
                        .get(r)
                        .ok_or_else(|| format!("no element {r} in this frame"))?;
                    if *button == Button::Left
                        && *count == 1
                        && roles::pressable(&element.role)
                        && a11y.press(&element.handle).unwrap_or(false)
                    {
                        return Ok(());
                    }
                }
                let (px, py) = aim(r#ref, x, y)?;
                let button = match button {
                    Button::Left => display::LEFT,
                    Button::Right => display::RIGHT,
                };
                self.display.click(px, py, button, *count)
            }
            Action::Scroll {
                r#ref,
                x,
                y,
                dx,
                dy,
                ..
            } => {
                if r#ref.is_some() || (x.is_some() && y.is_some()) {
                    let (px, py) = aim(r#ref, x, y)?;
                    self.display.move_to(px, py)?;
                }
                self.display.scroll(*dx, *dy)
            }
            Action::Type { text } => {
                for c in text.chars() {
                    self.display.type_char(c)?;
                    sleep(Duration::from_millis(5));
                }
                Ok(())
            }
            Action::Key { combo } => {
                let parsed = keys::parse(combo).ok_or_else(|| format!("unknown key {combo}"))?;
                self.display.press(&parsed)
            }
            Action::OpenApp { .. } | Action::Wait { .. } => Ok(()),
        }
    }

    fn open_app(&self, name: Option<&str>, id: Option<&str>) -> Result<(), String> {
        let entries = desktop::entries(&desktop::search_dirs());
        let entry = desktop::find(&entries, name, id)
            .ok_or_else(|| format!("no app named {}", id.or(name).unwrap_or("")))?;
        if let Decision::Refuse(reason) = policy::app(Some(&entry.id), &self.config, self.platform)
        {
            return Err(reason);
        }
        let classes = entry.window_classes();
        let in_front = |d: &Display| {
            d.active_window()
                .ok()
                .flatten()
                .and_then(|w| w.class)
                .is_some_and(|c| classes.contains(&c.to_lowercase()))
        };
        if in_front(&self.display) {
            return Ok(());
        }
        let mut child = Command::new(&entry.exec[0])
            .args(&entry.exec[1..])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("could not start {}: {e}", entry.name))?;
        // Reap it when it exits, so it never lingers as a zombie.
        std::thread::spawn(move || child.wait());
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(10) {
            if in_front(&self.display) {
                return Ok(());
            }
            sleep(Duration::from_millis(100));
        }
        Err(format!(
            "{} opened but did not come to the front",
            entry.name
        ))
    }
}

impl Backend for X11Backend {
    fn platform(&self) -> Platform {
        self.platform
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            coordinates: Coordinates::Screen,
            // Nothing watches for a person's own input yet: on the sandbox no
            // one else types, and on a person's session that is still to do.
            takeover: Takeover::None,
            secure_input: SecureInput::BestEffort,
        }
    }

    fn current_frame_id(&self) -> Option<String> {
        self.frame.as_ref().map(|f| f.id.clone())
    }

    fn observe(&mut self, screenshot: bool, max_elements: u32) -> Result<Observation, String> {
        let display_rect = self.display_rect();
        let mapping = ScreenMapping::new(display_rect);
        let mut frame: Frame<ObjectRefOwned> = Frame::new(mapping);
        let window = self.display.active_window()?;
        let mut elements = Vec::new();
        let mut elements_note = None;
        let mut app_name = None;
        let mut window_title = window.as_ref().and_then(|w| w.title.clone());

        match (&self.a11y, &window) {
            (Err(why), _) => {
                elements_note = Some(format!("No element tree: {why}"));
            }
            (Ok(_), None) => elements_note = Some("No window is in front.".into()),
            (Ok(a11y), Some(w)) => match a11y.window(w.pid, w.title.as_deref()) {
                Err(why) => elements_note = Some(format!("No element tree: {why}")),
                Ok(None) => {
                    elements_note = Some(
                        "The front window has no accessible content the helper can read.".into(),
                    )
                }
                Ok(Some(acc)) => {
                    app_name = acc.app_name;
                    window_title = window_title.or(acc.title);
                    let walk = a11y
                        .walk(&acc.handle, display_rect, max_elements as usize)
                        .unwrap_or_else(|why| {
                            elements_note = Some(format!("No element tree: {why}"));
                            crate::a11y::Walk {
                                nodes: vec![],
                                truncated: false,
                            }
                        });
                    if walk.truncated {
                        elements_note = Some(format!(
                            "Element list stopped at {}; ask for more with max_elements.",
                            walk.nodes.len()
                        ));
                    }
                    for node in walk.nodes {
                        let r#ref = format!("e{}", elements.len() + 1);
                        elements.push(Element {
                            r#ref: r#ref.clone(),
                            role: roles::shared(&node.native_role).into(),
                            native_role: Some(node.native_role.clone()),
                            title: node.title,
                            value: node.value,
                            description: node.description,
                            frame: mapping.frame(node.rect),
                            enabled: (!node.enabled).then_some(false),
                            focused: node.focused.then_some(true),
                        });
                        frame.elements.insert(
                            r#ref,
                            FrameElement {
                                handle: node.handle,
                                role: node.native_role,
                                rect: node.rect,
                            },
                        );
                    }
                }
            },
        }

        let app = window
            .as_ref()
            .and_then(|w| w.class.clone())
            .map(|class| ObservedApp {
                name: app_name.unwrap_or_else(|| class.clone()),
                bundle_id: Some(class),
            });
        let (shot, screenshot_note) = if screenshot {
            match self
                .display
                .capture()
                .and_then(|image| shot::render(&image, &mapping, &elements))
            {
                Ok(s) => (Some(s), None),
                Err(e) => (None, Some(e)),
            }
        } else {
            (None, None)
        };
        let observation = Observation {
            frame_id: frame.id.clone(),
            app,
            window_title: policy::truncate(window_title.as_deref()),
            elements,
            elements_note,
            screenshot: shot,
            screenshot_note,
        };
        self.frame = Some(frame);
        Ok(observation)
    }

    fn act(&mut self, actions: &[Action], control: &Control) -> ActResult {
        run_batch(actions, control, |action| self.perform(action))
    }
}
