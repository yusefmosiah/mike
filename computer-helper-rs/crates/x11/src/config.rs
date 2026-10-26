//! The helper's settings, from a JSON file (`COMPUTER_HELPER_CONFIG`, the
//! same shape as the other helpers' config) or from the environment, which
//! is how the sandbox's container gets them.

use computer_core::policy::HelperConfig;
use computer_core::protocol::Platform;

/// The settings, and which platform this helper reports.
pub fn load(env: impl Fn(&str) -> Option<String>) -> Result<(HelperConfig, Platform), String> {
    let set = |name: &str| {
        env(name)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let platform = match set("COMPUTER_PLATFORM").as_deref() {
        None | Some("sandbox") => Platform::Sandbox,
        Some("linux") => Platform::Linux,
        Some(other) => {
            return Err(format!(
                "COMPUTER_PLATFORM must be sandbox or linux, not {other}"
            ));
        }
    };
    let mut config = match set("COMPUTER_HELPER_CONFIG") {
        Some(path) => {
            let text =
                std::fs::read_to_string(&path).map_err(|e| format!("cannot read {path}: {e}"))?;
            serde_json::from_str(&text)
                .map_err(|e| format!("{path} is not a helper config: {e}"))?
        }
        None => HelperConfig::template(platform),
    };
    if let Some(url) = set("COMPUTER_SERVER_URL") {
        config.server_url = url;
    }
    if let Some(token) = set("COMPUTER_DEVICE_TOKEN") {
        config.token = token;
    }
    if let Some(password) = set("COMPUTER_GATE_PASSWORD") {
        config.gate_password = Some(password);
    }
    if !config.is_configured() {
        return Err(
            "set COMPUTER_SERVER_URL and COMPUTER_DEVICE_TOKEN, or COMPUTER_HELPER_CONFIG".into(),
        );
    }
    Ok((config, platform))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k| map.get(k).cloned()
    }

    #[test]
    fn reads_the_environment() {
        let (config, platform) = load(env(&[
            ("COMPUTER_SERVER_URL", "http://localhost:3001/api"),
            ("COMPUTER_DEVICE_TOKEN", " t "),
            ("COMPUTER_GATE_PASSWORD", "g"),
        ]))
        .unwrap();
        assert_eq!(platform, Platform::Sandbox);
        assert_eq!(config.server_url, "http://localhost:3001/api");
        assert_eq!(config.token, "t");
        assert_eq!(config.gate_password.as_deref(), Some("g"));
        assert!(config.blocked(platform).is_empty());
    }

    #[test]
    fn a_linux_session_keeps_the_default_blocked_apps() {
        let (config, platform) = load(env(&[
            ("COMPUTER_PLATFORM", "linux"),
            ("COMPUTER_DEVICE_TOKEN", "t"),
        ]))
        .unwrap();
        assert_eq!(platform, Platform::Linux);
        assert!(!config.blocked(platform).is_empty());
    }

    #[test]
    fn reads_a_file_and_refuses_bad_settings() {
        let path = std::env::temp_dir().join(format!("helper-config-{}.json", std::process::id()));
        std::fs::write(
            &path,
            r#"{"server_url":"https://x/api","token":"from-file"}"#,
        )
        .unwrap();
        let file = path.to_string_lossy().into_owned();
        let (config, _) = load(env(&[("COMPUTER_HELPER_CONFIG", &file)])).unwrap();
        assert_eq!(config.token, "from-file");
        std::fs::write(&path, "nope").unwrap();
        assert!(load(env(&[("COMPUTER_HELPER_CONFIG", &file)])).is_err());
        std::fs::remove_file(&path).unwrap();
        assert!(load(env(&[])).is_err());
        assert!(
            load(env(&[
                ("COMPUTER_PLATFORM", "macos"),
                ("COMPUTER_DEVICE_TOKEN", "t")
            ]))
            .is_err()
        );
    }
}
