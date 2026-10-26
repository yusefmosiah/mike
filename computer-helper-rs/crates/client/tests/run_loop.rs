//! The run loop against a fake API: commands collected, batches checked,
//! results posted, heartbeats sent, the staging gate passed once, and a
//! rejected token reported.

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use computer_client::{Backend, Control, Status, Transport, TransportError, run};
use computer_core::policy::HelperConfig;
use computer_core::protocol::{
    ActResult, Action, ActionOutcome, Capabilities, Coordinates, Observation, Platform,
    SecureInput, Takeover,
};
use serde_json::{Value, json};
use tiny_http::{Header, Response, Server};

struct FakeBackend {
    frame: Option<String>,
    acted: Arc<Mutex<Vec<Action>>>,
}

impl Backend for FakeBackend {
    fn platform(&self) -> Platform {
        Platform::Sandbox
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            coordinates: Coordinates::Screen,
            takeover: Takeover::None,
            secure_input: SecureInput::BestEffort,
        }
    }
    fn current_frame_id(&self) -> Option<String> {
        self.frame.clone()
    }
    fn observe(&mut self, _screenshot: bool, _max: u32) -> Result<Observation, String> {
        self.frame = Some("f1".into());
        Ok(Observation {
            frame_id: "f1".into(),
            app: None,
            window_title: Some("Desk".into()),
            elements: vec![],
            elements_note: None,
            screenshot: None,
            screenshot_note: None,
        })
    }
    fn act(&mut self, actions: &[Action], _control: &Control) -> ActResult {
        self.acted.lock().unwrap().extend(actions.iter().cloned());
        ActResult {
            outcomes: (0..actions.len())
                .map(|index| ActionOutcome {
                    index,
                    ok: true,
                    error: None,
                })
                .collect(),
            stopped_reason: None,
        }
    }
}

fn json_response(status: u16, body: &Value) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(body.to_string())
        .with_status_code(status)
        .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
}

fn config(port: u16, token: &str, gate: Option<&str>) -> HelperConfig {
    let mut config = HelperConfig::template(Platform::Sandbox);
    config.server_url = format!("http://127.0.0.1:{port}/api");
    config.token = token.into();
    config.gate_password = gate.map(str::to_string);
    config
}

fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
    let start = Instant::now();
    while !done() {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "timed out waiting for {what}"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn collects_commands_checks_batches_and_posts_results() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    let results = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
    let beats = Arc::new(Mutex::new(Vec::<Value>::new()));
    let gate_posts = Arc::new(Mutex::new(0));
    {
        let (results, beats, gate_posts) = (results.clone(), beats.clone(), gate_posts.clone());
        thread::spawn(move || {
            let mut queue = vec![
                json!({"id": "c1", "type": "observe", "screenshot": false, "max_elements": 10}),
                json!({"id": "c2", "type": "act", "frame_id": "old", "actions": [{"type": "click", "ref": "e1"}]}),
                json!({"id": "c3", "type": "act", "frame_id": "f1", "actions": [{"type": "key", "combo": "cmd+s"}]}),
            ];
            queue.reverse();
            for mut request in server.incoming_requests() {
                let passed = request
                    .headers()
                    .iter()
                    .any(|h| h.field.equiv("Cookie") && h.value.as_str().contains("gate=ok"));
                let url = request.url().to_string();
                if url == "/__gate" {
                    *gate_posts.lock().unwrap() += 1;
                    let mut body = String::new();
                    request.as_reader().read_to_string(&mut body).unwrap();
                    assert!(body.contains("password=hunter2"));
                    let _ = request.respond(
                        Response::from_string("")
                            .with_status_code(303)
                            .with_header(Header::from_bytes("Location", "/robots.txt").unwrap())
                            .with_header(
                                Header::from_bytes("Set-Cookie", "gate=ok; Path=/").unwrap(),
                            ),
                    );
                    continue;
                }
                if !passed {
                    let _ = request.respond(Response::from_string("").with_status_code(401));
                    continue;
                }
                let auth_ok = request.headers().iter().any(|h| {
                    h.field.equiv("Authorization") && h.value.as_str() == "Bearer cmp_good"
                });
                assert!(auth_ok, "every device request carries the token");
                let mut body = String::new();
                request.as_reader().read_to_string(&mut body).unwrap();
                if url.starts_with("/api/computers/device/next") {
                    match queue.pop() {
                        Some(command) => drop(request.respond(json_response(200, &command))),
                        None => {
                            thread::sleep(Duration::from_millis(50));
                            let _ =
                                request.respond(Response::from_string("").with_status_code(204));
                        }
                    }
                } else if let Some(id) = url.strip_prefix("/api/computers/device/results/") {
                    results
                        .lock()
                        .unwrap()
                        .push((id.to_string(), serde_json::from_str(&body).unwrap()));
                    let _ = request.respond(Response::from_string("").with_status_code(204));
                } else if url == "/api/computers/device/heartbeat" {
                    beats
                        .lock()
                        .unwrap()
                        .push(serde_json::from_str(&body).unwrap());
                    let _ = request.respond(json_response(200, &json!({"name": "Desk"})));
                } else {
                    panic!("unexpected {url}");
                }
            }
        });
    }

    let acted = Arc::new(Mutex::new(vec![]));
    let control = Control::new();
    let runner = {
        let (control, acted) = (control.clone(), acted.clone());
        thread::spawn(move || {
            let mut backend = FakeBackend { frame: None, acted };
            run(
                &config(port, "cmp_good", Some("hunter2")),
                &mut backend,
                control,
                Some("0.1.0".into()),
            );
        })
    };
    wait_for("three results", || results.lock().unwrap().len() == 3);
    wait_for("a heartbeat", || !beats.lock().unwrap().is_empty());
    control.quit();
    runner.join().unwrap();

    let results = results.lock().unwrap();
    assert_eq!(results[0].0, "c1");
    assert_eq!(results[0].1["observation"]["frame_id"], "f1");
    assert_eq!(
        results[1].1["act"]["stopped_reason"],
        "stale frame: observe again"
    );
    assert_eq!(results[2].1["act"]["outcomes"][0]["ok"], true);
    assert_eq!(acted.lock().unwrap().len(), 1, "only the fresh batch ran");
    assert_eq!(beats.lock().unwrap()[0]["platform"], "sandbox");
    assert_eq!(*gate_posts.lock().unwrap(), 1, "the gate is signed in once");
}

#[test]
fn reports_a_rejected_token_and_never_retries_a_wrong_gate_password() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    let gate_posts = Arc::new(Mutex::new(0));
    {
        let gate_posts = gate_posts.clone();
        thread::spawn(move || {
            for request in server.incoming_requests() {
                let token = request
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("Authorization"))
                    .map(|h| h.value.to_string());
                if request.url() == "/__gate" {
                    *gate_posts.lock().unwrap() += 1;
                    let _ = request.respond(Response::from_string("").with_status_code(401));
                } else if token.as_deref() == Some("Bearer cmp_gated") {
                    let _ = request.respond(Response::from_string("").with_status_code(401));
                } else {
                    let _ = request.respond(json_response(
                        401,
                        &json!({"detail": "Device token not recognised"}),
                    ));
                }
            }
        });
    }
    let rejected = Transport::new(&config(port, "cmp_bad", None));
    assert_eq!(rejected.next(0), Err(TransportError::TokenRejected));

    let gated = Transport::new(&config(port, "cmp_gated", Some("wrong")));
    assert_eq!(gated.next(0), Err(TransportError::GatePasswordWrong));
    assert_eq!(gated.next(0), Err(TransportError::GatePasswordWrong));
    assert_eq!(*gate_posts.lock().unwrap(), 1);

    let no_password = Transport::new(&config(port, "cmp_gated", None));
    assert_eq!(no_password.next(0), Err(TransportError::GateLocked));

    let control = Control::new();
    let mut backend = FakeBackend {
        frame: None,
        acted: Default::default(),
    };
    let unconfigured = config(port, "", None);
    run(&unconfigured, &mut backend, control.clone(), None);
    assert_eq!(control.status(), Status::NotConfigured);
}
