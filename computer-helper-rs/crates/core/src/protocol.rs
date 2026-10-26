//! Wire types, mirroring `packages/contracts/index.d.ts` ("Computers") and the
//! Swift helper's `Protocol.swift`. The fixtures in
//! `packages/contracts/fixtures/computers/` pin all three to the same JSON.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    Observe {
        id: String,
        #[serde(default = "yes")]
        screenshot: bool,
        #[serde(default = "default_max_elements")]
        max_elements: u32,
    },
    Act {
        id: String,
        frame_id: String,
        actions: Vec<Action>,
    },
}

fn yes() -> bool {
    true
}

fn default_max_elements() -> u32 {
    80
}

impl Command {
    pub fn id(&self) -> &str {
        match self {
            Command::Observe { id, .. } | Command::Act { id, .. } => id,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Button {
    #[default]
    Left,
    Right,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    Click {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        r#ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        x: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        y: Option<f64>,
        #[serde(default)]
        button: Button,
        #[serde(default = "one")]
        count: u32,
    },
    Type {
        text: String,
    },
    Key {
        combo: String,
    },
    Scroll {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        r#ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        x: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        y: Option<f64>,
        #[serde(default)]
        dx: f64,
        #[serde(default)]
        dy: f64,
    },
    OpenApp {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bundle_id: Option<String>,
    },
    Wait {
        ms: i64,
    },
}

fn one() -> u32 {
    1
}

impl Action {
    /// The element ref this action aims at, if any.
    pub fn element_ref(&self) -> Option<&str> {
        match self {
            Action::Click { r#ref, .. } | Action::Scroll { r#ref, .. } => r#ref.as_deref(),
            _ => None,
        }
    }

    /// True when the action aims at screenshot coordinates rather than a ref.
    pub fn uses_point(&self) -> bool {
        matches!(
            self,
            Action::Click {
                r#ref: None,
                x: Some(_),
                y: Some(_),
                ..
            } | Action::Scroll {
                r#ref: None,
                x: Some(_),
                y: Some(_),
                ..
            }
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ElementFrame {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Element {
    pub r#ref: String,
    /// A shared role name (`ComputerRole`); the platform's own is in `native_role`.
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub frame: ElementFrame,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ObservedApp {
    pub name: String,
    pub bundle_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Screenshot {
    pub data: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Observation {
    pub frame_id: String,
    pub app: Option<ObservedApp>,
    pub window_title: Option<String>,
    pub elements: Vec<Element>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elements_note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<Screenshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot_note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActionOutcome {
    pub index: usize,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ActResult {
    pub outcomes: Vec<ActionOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped_reason: Option<String>,
}

/// The body posted for a command (`ComputerCommandResult`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CommandResult {
    Observation { ok: True, observation: Observation },
    Act { ok: True, act: ActResult },
    Error { ok: False, error: String },
}

impl CommandResult {
    pub fn observation(observation: Observation) -> Self {
        CommandResult::Observation {
            ok: True,
            observation,
        }
    }
    pub fn act(act: ActResult) -> Self {
        CommandResult::Act { ok: True, act }
    }
    pub fn error(error: impl Into<String>) -> Self {
        CommandResult::Error {
            ok: False,
            error: error.into(),
        }
    }
}

/// `true` on the wire, and only `true`: lets the untagged result enum tell
/// its variants apart by `ok`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct True;
/// `false` on the wire, and only `false`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct False;

macro_rules! bool_literal {
    ($name:ident, $value:literal) => {
        impl Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_bool($value)
            }
        }
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                if bool::deserialize(d)? == $value {
                    Ok($name)
                } else {
                    Err(serde::de::Error::custom(concat!(
                        "expected ",
                        stringify!($value)
                    )))
                }
            }
        }
    };
}
bool_literal!(True, true);
bool_literal!(False, false);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    Macos,
    Windows,
    Linux,
    Sandbox,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Coordinates {
    Screen,
    RefsOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Takeover {
    Full,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecureInput {
    System,
    BestEffort,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities {
    pub coordinates: Coordinates,
    pub takeover: Takeover,
    pub secure_input: SecureInput,
}

/// The body of `POST /computers/device/heartbeat`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Heartbeat {
    pub platform: Platform,
    pub capabilities: Capabilities,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_version: Option<String>,
}

/// The roles every helper shares (`ComputerRole` in the contracts).
pub const ROLES: &[&str] = &[
    "button",
    "checkbox",
    "radio",
    "switch",
    "textfield",
    "textarea",
    "searchfield",
    "combobox",
    "popup",
    "menu",
    "menuitem",
    "link",
    "tab",
    "list",
    "listitem",
    "row",
    "cell",
    "slider",
    "text",
    "heading",
    "image",
    "other",
];
