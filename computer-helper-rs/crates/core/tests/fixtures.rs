//! The shared fixtures in packages/contracts/fixtures/computers decode into
//! the core's types and encode back to the same JSON.

use std::path::PathBuf;

use computer_core::protocol::{Action, Command, CommandResult, Heartbeat};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

fn fixture(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/contracts/fixtures/computers")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn round_trip<T: DeserializeOwned + Serialize>(name: &str) -> T {
    let text = fixture(name);
    let value: T = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{name}: {e}"));
    let expected: Value = serde_json::from_str(&text).unwrap();
    let mut encoded = serde_json::to_value(&value).unwrap();
    // Defaults the fixture leaves out (button, count, dx) are written back; compare what the fixture says.
    prune_to(&mut encoded, &expected);
    assert_eq!(encoded, expected, "{name} does not round-trip");
    value
}

/// Drop object keys `actual` has and `expected` lacks, recursively, and
/// take the fixture's spelling of numbers that are equal.
fn prune_to(actual: &mut Value, expected: &Value) {
    match (actual, expected) {
        (Value::Object(a), Value::Object(e)) => {
            a.retain(|k, _| e.contains_key(k));
            for (k, v) in a.iter_mut() {
                prune_to(v, &e[k]);
            }
        }
        (Value::Array(a), Value::Array(e)) => {
            for (x, y) in a.iter_mut().zip(e) {
                prune_to(x, y);
            }
        }
        // 1120.0 and 1120 are the same JSON number.
        (Value::Number(a), Value::Number(e)) if a.as_f64() == e.as_f64() => *a = e.clone(),
        _ => {}
    }
}

#[test]
fn commands() {
    let observe: Command = round_trip("observe-command.json");
    assert!(matches!(
        observe,
        Command::Observe {
            screenshot: true,
            max_elements: 80,
            ..
        }
    ));
    let act: Command = round_trip("act-command.json");
    let Command::Act { actions, .. } = act else {
        panic!("not an act")
    };
    assert_eq!(actions.len(), 8);
    assert!(matches!(actions[1], Action::Click { count: 2, .. }));
}

#[test]
fn results() {
    assert!(matches!(
        round_trip::<CommandResult>("observation-result.json"),
        CommandResult::Observation { .. }
    ));
    assert!(matches!(
        round_trip::<CommandResult>("act-result.json"),
        CommandResult::Act { .. }
    ));
    assert!(matches!(
        round_trip::<CommandResult>("error-result.json"),
        CommandResult::Error { .. }
    ));
}

#[test]
fn heartbeat() {
    let beat: Heartbeat = round_trip("heartbeat.json");
    assert_eq!(beat.helper_version.as_deref(), Some("0.1.0"));
}
