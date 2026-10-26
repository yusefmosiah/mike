//! What a helper allows, the same on every platform as in the Swift helper's
//! `Policy.swift`: limits, the blocked and allowed apps, and a batch check
//! before any action runs.

use serde::{Deserialize, Serialize};

use crate::keys;
use crate::protocol::{Action, Platform};

pub const MAX_ACTIONS_PER_BATCH: usize = 20;
pub const MAX_WAIT_PER_ACTION_MS: i64 = 5_000;
pub const MAX_WAIT_PER_BATCH_MS: i64 = 15_000;
pub const MAX_ELEMENTS: u32 = 150;
pub const MAX_TEXT_CHARS: usize = 80;
pub const MAX_SCROLL_LINES: f64 = 50.0;
pub const SCREENSHOT_LONG_EDGE: f64 = 1280.0;

/// The helper's config file (`HelperConfig` in the Swift helper).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HelperConfig {
    #[serde(default)]
    pub server_url: String,
    #[serde(default)]
    pub token: String,
    /// App ids the helper may act in; empty allows every app not blocked.
    #[serde(default)]
    pub allowed_apps: Vec<String>,
    /// App ids the helper never acts in or opens. Missing means the platform's defaults.
    #[serde(default)]
    pub blocked_apps: Option<Vec<String>>,
    #[serde(default = "instant")]
    pub speed: String,
    /// A shared-password gate in front of the server (staging), if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate_password: Option<String>,
}

fn instant() -> String {
    "instant".into()
}

impl HelperConfig {
    pub fn template(platform: Platform) -> Self {
        Self {
            server_url: "https://choir-ip.com/api".into(),
            token: String::new(),
            allowed_apps: vec![],
            blocked_apps: Some(
                default_blocked_apps(platform)
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
            ),
            speed: instant(),
            gate_password: Some(String::new()),
        }
    }

    pub fn is_configured(&self) -> bool {
        !self.server_url.trim().is_empty() && !self.token.trim().is_empty()
    }

    /// The server base without a trailing slash.
    pub fn base_url(&self) -> String {
        self.server_url.trim().trim_end_matches('/').to_string()
    }

    pub fn blocked(&self, platform: Platform) -> Vec<String> {
        self.blocked_apps.clone().unwrap_or_else(|| {
            default_blocked_apps(platform)
                .iter()
                .map(|s| s.to_string())
                .collect()
        })
    }
}

/// Shells, system settings and credential stores, by the id each platform
/// reports for an app: an exe name or AppUserModelID on Windows, a .desktop
/// id on Linux.
pub fn default_blocked_apps(platform: Platform) -> &'static [&'static str] {
    match platform {
        Platform::Macos => &[
            "com.apple.keychainaccess",
            "com.apple.systempreferences",
            "com.apple.Settings",
            "com.apple.Terminal",
            "com.googlecode.iterm2",
            "com.apple.Passwords",
        ],
        Platform::Windows => &[
            "cmd.exe",
            "powershell.exe",
            "pwsh.exe",
            "windowsterminal.exe",
            "wt.exe",
            "regedit.exe",
            "mmc.exe",
            "taskmgr.exe",
            "systemsettings.exe",
            "credentialuibroker.exe",
            "consent.exe",
            "securityhealthsystray.exe",
            "1password.exe",
            "bitwarden.exe",
            "keepass.exe",
            "keepassxc.exe",
        ],
        Platform::Linux => &[
            "org.gnome.Terminal",
            "org.gnome.Console",
            "org.kde.konsole",
            "xfce4-terminal",
            "org.gnome.Settings",
            "systemsettings",
            "org.gnome.seahorse.Application",
            "org.kde.kwalletmanager5",
            "org.keepassxc.KeePassXC",
            "1password",
            "bitwarden",
        ],
        // The agent's own desktop has no credentials of the person's to protect.
        Platform::Sandbox => &[],
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Refuse(String),
}

/// May the helper act while this app is in front?
pub fn app(app_id: Option<&str>, config: &HelperConfig, platform: Platform) -> Decision {
    let Some(id) = app_id else {
        return if config.allowed_apps.is_empty() {
            Decision::Allow
        } else {
            Decision::Refuse("the frontmost app is unknown".into())
        };
    };
    let matches = |list: &[String]| list.iter().any(|entry| entry.eq_ignore_ascii_case(id));
    if matches(&config.blocked(platform)) {
        return Decision::Refuse(format!("{id} is blocked on this computer"));
    }
    if !config.allowed_apps.is_empty() && !matches(&config.allowed_apps) {
        return Decision::Refuse(format!("{id} is not in this computer's allowed apps"));
    }
    Decision::Allow
}

/// Checks a batch before any action runs.
pub fn batch(frame_id: &str, actions: &[Action], current_frame_id: Option<&str>) -> Decision {
    let refuse = |s: &str| Decision::Refuse(s.to_string());
    if actions.is_empty() {
        return refuse("no actions");
    }
    if actions.len() > MAX_ACTIONS_PER_BATCH {
        return Decision::Refuse(format!("at most {MAX_ACTIONS_PER_BATCH} actions per batch"));
    }
    let aims = actions
        .iter()
        .any(|a| a.element_ref().is_some() || a.uses_point());
    if aims && Some(frame_id) != current_frame_id {
        return refuse("stale frame: observe again");
    }
    for action in actions {
        match action {
            Action::Click {
                r#ref, x, y, count, ..
            } => {
                if r#ref.is_none() && (x.is_none() || y.is_none()) {
                    return refuse("click needs a ref or x and y");
                }
                if !(1..=3).contains(count) {
                    return refuse("click count must be 1 to 3");
                }
            }
            Action::Scroll { dx, dy, .. } => {
                if dx.abs() > MAX_SCROLL_LINES || dy.abs() > MAX_SCROLL_LINES {
                    return refuse("scroll at most 50 lines at a time");
                }
            }
            Action::OpenApp { name, bundle_id } => {
                if name.as_deref().unwrap_or("").is_empty()
                    && bundle_id.as_deref().unwrap_or("").is_empty()
                {
                    return refuse("open_app needs a name or bundle_id");
                }
            }
            Action::Wait { ms } => {
                if *ms < 0 {
                    return refuse("wait must not be negative");
                }
            }
            Action::Type { text } => {
                if text.is_empty() {
                    return refuse("type needs text");
                }
            }
            Action::Key { combo } => {
                if keys::parse(combo).is_none() {
                    return Decision::Refuse(format!("unknown key {combo}"));
                }
            }
        }
    }
    Decision::Allow
}

/// The wait an action may take, given what the batch has already waited.
pub fn clamped_wait(ms: i64, already_waited_ms: i64) -> i64 {
    ms.min(MAX_WAIT_PER_ACTION_MS)
        .min(MAX_WAIT_PER_BATCH_MS - already_waited_ms)
        .max(0)
}

/// Trimmed, on one line, at most [`MAX_TEXT_CHARS`] characters; None when empty.
pub fn truncate(s: Option<&str>) -> Option<String> {
    let s = s?.trim().replace('\n', " ");
    if s.is_empty() {
        return None;
    }
    if s.chars().count() > MAX_TEXT_CHARS {
        return Some(s.chars().take(MAX_TEXT_CHARS - 1).collect::<String>() + "…");
    }
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn click_ref() -> Action {
        Action::Click {
            r#ref: Some("e1".into()),
            x: None,
            y: None,
            button: Default::default(),
            count: 1,
        }
    }

    #[test]
    fn blocks_and_allows_apps_case_insensitively() {
        let mut config = HelperConfig::template(Platform::Windows);
        assert_eq!(
            app(Some("PowerShell.exe"), &config, Platform::Windows),
            Decision::Refuse("PowerShell.exe is blocked on this computer".into())
        );
        assert_eq!(
            app(Some("notepad.exe"), &config, Platform::Windows),
            Decision::Allow
        );
        assert_eq!(app(None, &config, Platform::Windows), Decision::Allow);
        config.allowed_apps = vec!["notepad.exe".into()];
        assert!(matches!(
            app(Some("chrome.exe"), &config, Platform::Windows),
            Decision::Refuse(_)
        ));
        assert!(matches!(
            app(None, &config, Platform::Windows),
            Decision::Refuse(_)
        ));
        // A config without the field gets the platform's defaults.
        config.blocked_apps = None;
        assert!(matches!(
            app(Some("cmd.exe"), &config, Platform::Windows),
            Decision::Refuse(_)
        ));
    }

    #[test]
    fn checks_a_batch_before_it_runs() {
        assert_eq!(batch("f1", &[click_ref()], Some("f1")), Decision::Allow);
        assert_eq!(
            batch("f0", &[click_ref()], Some("f1")),
            Decision::Refuse("stale frame: observe again".into())
        );
        // Typing needs no frame.
        assert_eq!(
            batch("f0", &[Action::Type { text: "hi".into() }], None),
            Decision::Allow
        );
        assert!(matches!(batch("f1", &[], Some("f1")), Decision::Refuse(_)));
        assert!(matches!(
            batch("f1", &vec![Action::Wait { ms: 1 }; 21], Some("f1")),
            Decision::Refuse(_)
        ));
        assert!(matches!(
            batch(
                "f1",
                &[Action::Key {
                    combo: "hyper+x".into()
                }],
                Some("f1")
            ),
            Decision::Refuse(_)
        ));
        assert!(matches!(
            batch(
                "f1",
                &[Action::OpenApp {
                    name: None,
                    bundle_id: Some(String::new())
                }],
                Some("f1")
            ),
            Decision::Refuse(_)
        ));
        assert!(matches!(
            batch(
                "f1",
                &[Action::Click {
                    r#ref: Some("e1".into()),
                    x: None,
                    y: None,
                    button: Default::default(),
                    count: 4
                }],
                Some("f1")
            ),
            Decision::Refuse(_)
        ));
    }

    #[test]
    fn clamps_waits_and_truncates() {
        assert_eq!(clamped_wait(9_000, 0), 5_000);
        assert_eq!(clamped_wait(5_000, 12_000), 3_000);
        assert_eq!(clamped_wait(1_000, 20_000), 0);
        assert_eq!(truncate(Some("  a\nb ")), Some("a b".into()));
        assert_eq!(truncate(Some("   ")), None);
        assert_eq!(
            truncate(Some(&"x".repeat(100))).unwrap().chars().count(),
            MAX_TEXT_CHARS
        );
    }
}
