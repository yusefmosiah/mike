//! The device endpoints over HTTPS, as the Swift helper's `Transport.swift`:
//! a bearer token on every request, and a one-time sign-in through a
//! shared-password gate (staging) when one answers instead of the API.

use std::sync::Mutex;
use std::time::Duration;

use computer_core::policy::HelperConfig;
use computer_core::protocol::{Command, CommandResult, Heartbeat};
use ureq::Agent;
use ureq::http::Response;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportError {
    TokenRejected,
    GatePasswordWrong,
    GateLocked,
    Http(u16),
    BadResponse(String),
    Offline(String),
}

impl TransportError {
    /// A rejected token or gate will not fix itself soon: check again slowly.
    pub fn is_lasting(&self) -> bool {
        matches!(
            self,
            Self::TokenRejected | Self::GatePasswordWrong | Self::GateLocked
        )
    }
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TokenRejected => write!(f, "Token rejected"),
            Self::GatePasswordWrong => write!(f, "Gate password rejected (not retried)"),
            Self::GateLocked => write!(f, "Server gate needs gate_password in config"),
            Self::Http(code) => write!(f, "Server answered {code}"),
            Self::BadResponse(why) => write!(f, "Unexpected server response: {why}"),
            Self::Offline(why) => write!(f, "Offline: {why}"),
        }
    }
}

#[derive(Default)]
enum Gate {
    #[default]
    Untried,
    Passed,
    Failed,
}

pub struct Transport {
    base: String,
    token: String,
    gate_password: Option<String>,
    agent: Agent,
    gate: Mutex<Gate>,
}

struct Reply {
    status: u16,
    json: bool,
    body: String,
}

impl Transport {
    pub fn new(config: &HelperConfig) -> Self {
        let agent: Agent = Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(40)))
            .http_status_as_error(false)
            // The gate answers its sign-in with a redirect; its cookie is all we need.
            .max_redirects(0)
            .build()
            .into();
        Self {
            base: config.base_url(),
            token: config.token.trim().to_string(),
            gate_password: config.gate_password.clone().filter(|p| !p.is_empty()),
            agent,
            gate: Mutex::new(Gate::Untried),
        }
    }

    fn read(mut response: Response<ureq::Body>) -> Result<Reply, TransportError> {
        let status = response.status().as_u16();
        let json = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.contains("json"));
        let body = response
            .body_mut()
            .with_config()
            .limit(16 * 1024 * 1024)
            .read_to_string()
            .map_err(|e| TransportError::Offline(e.to_string()))?;
        Ok(Reply { status, json, body })
    }

    fn exchange(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Result<Reply, TransportError> {
        let url = format!("{}{}", self.base, path);
        let auth = format!("Bearer {}", self.token);
        let response = match (method, body) {
            ("GET", _) => self
                .agent
                .get(&url)
                .header("Authorization", &auth)
                .header("Accept", "application/json")
                .call(),
            (_, body) => self
                .agent
                .post(&url)
                .header("Authorization", &auth)
                .header("Accept", "application/json")
                .content_type("application/json")
                .send(body.unwrap_or("{}")),
        }
        .map_err(|e| TransportError::Offline(e.to_string()))?;
        Self::read(response)
    }

    /// The gate answers 401 with an empty, non-JSON body; the API answers with JSON.
    fn is_gate_refusal(reply: &Reply) -> bool {
        reply.status == 401 && reply.body.is_empty() && !reply.json
    }

    fn send(&self, method: &str, path: &str, body: Option<&str>) -> Result<Reply, TransportError> {
        let mut reply = self.exchange(method, path, body)?;
        if Self::is_gate_refusal(&reply) {
            self.pass_gate()?;
            reply = self.exchange(method, path, body)?;
        }
        if reply.status == 401 {
            return Err(if Self::is_gate_refusal(&reply) {
                TransportError::GateLocked
            } else {
                TransportError::TokenRejected
            });
        }
        Ok(reply)
    }

    /// Sign in through the gate once per launch: five wrong passwords ban the address for a day.
    fn pass_gate(&self) -> Result<(), TransportError> {
        let Some(password) = &self.gate_password else {
            return Err(TransportError::GateLocked);
        };
        let mut gate = self.gate.lock().unwrap();
        match *gate {
            Gate::Failed => return Err(TransportError::GatePasswordWrong),
            Gate::Passed => return Ok(()),
            Gate::Untried => {}
        }
        let origin = origin_of(&self.base)
            .ok_or_else(|| TransportError::BadResponse("server_url has no origin".into()))?;
        let response = self
            .agent
            .post(format!("{origin}/__gate"))
            .send_form([("password", password.as_str()), ("next", "/robots.txt")])
            .map_err(|e| TransportError::Offline(e.to_string()))?;
        if response.status().as_u16() == 401 {
            *gate = Gate::Failed;
            return Err(TransportError::GatePasswordWrong);
        }
        *gate = Gate::Passed;
        Ok(())
    }

    /// Waits up to `wait_seconds` for the next command; None when none came.
    pub fn next(&self, wait_seconds: u32) -> Result<Option<Command>, TransportError> {
        let reply = self.send(
            "GET",
            &format!("/computers/device/next?wait={wait_seconds}"),
            None,
        )?;
        match reply.status {
            204 => Ok(None),
            200 => serde_json::from_str(&reply.body)
                .map(Some)
                .map_err(|e| TransportError::BadResponse(e.to_string())),
            code => Err(TransportError::Http(code)),
        }
    }

    /// A 404/409/410 means the command already ended server-side: nothing to do.
    pub fn post_result(&self, id: &str, result: &CommandResult) -> Result<(), TransportError> {
        let body = serde_json::to_string(result)
            .map_err(|e| TransportError::BadResponse(e.to_string()))?;
        let reply = self.send(
            "POST",
            &format!("/computers/device/results/{}", path_segment(id)),
            Some(&body),
        )?;
        if reply.status >= 500 {
            return Err(TransportError::Http(reply.status));
        }
        Ok(())
    }

    pub fn heartbeat(&self, heartbeat: &Heartbeat) -> Result<(), TransportError> {
        let body = serde_json::to_string(heartbeat)
            .map_err(|e| TransportError::BadResponse(e.to_string()))?;
        let reply = self.send("POST", "/computers/device/heartbeat", Some(&body))?;
        if !(200..300).contains(&reply.status) {
            return Err(TransportError::Http(reply.status));
        }
        Ok(())
    }
}

/// "https://example.com/api" → "https://example.com".
fn origin_of(base: &str) -> Option<String> {
    let scheme_end = base.find("://")? + 3;
    let host_end = base[scheme_end..]
        .find('/')
        .map_or(base.len(), |i| scheme_end + i);
    Some(base[..host_end].to_string())
}

/// Command ids are UUIDs; anything else is escaped so it stays one path segment.
fn path_segment(id: &str) -> String {
    id.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_origin_and_escapes_ids() {
        assert_eq!(
            origin_of("https://example.com/api").as_deref(),
            Some("https://example.com")
        );
        assert_eq!(
            origin_of("http://localhost:3001").as_deref(),
            Some("http://localhost:3001")
        );
        assert_eq!(origin_of("example.com"), None);
        assert_eq!(path_segment("4f7c-ab_1.x"), "4f7c-ab_1.x");
        assert_eq!(path_segment("a/b c"), "a%2Fb%20c");
    }
}
