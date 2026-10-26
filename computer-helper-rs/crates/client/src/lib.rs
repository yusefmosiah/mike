//! The API side of a computer helper. A platform implements [`Backend`]
//! (observe the screen, run a batch of actions); [`run`] does the rest the
//! same way everywhere: long-poll for commands, check each batch against the
//! policy, post results, and beat every 15 s on its own thread so a long
//! batch never makes the computer look offline.

pub mod transport;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use computer_core::policy::{self, Decision, HelperConfig};
use computer_core::protocol::{
    ActResult, Action, Capabilities, Command, CommandResult, Heartbeat, Observation, Platform,
};
pub use transport::{Transport, TransportError};

pub const POLL_WAIT_SECONDS: u32 = 25;
pub const HEARTBEAT_EVERY: Duration = Duration::from_secs(15);

/// One platform's half of the helper.
pub trait Backend: Send {
    fn platform(&self) -> Platform;
    fn capabilities(&self) -> Capabilities;
    /// The frame id of the latest observation, if any.
    fn current_frame_id(&self) -> Option<String>;
    fn observe(&mut self, screenshot: bool, max_elements: u32) -> Result<Observation, String>;
    /// Run a batch that already passed [`policy::batch`]. Check
    /// [`Control::interrupted`] between actions; stop at the first failure.
    fn act(&mut self, actions: &[Action], control: &Control) -> ActResult;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    NotConfigured,
    Connecting,
    Connected,
    Paused,
    Acting,
    Error(String),
}

impl std::fmt::Display for Status {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Status::NotConfigured => write!(f, "Not configured"),
            Status::Connecting => write!(f, "Connecting"),
            Status::Connected => write!(f, "Connected"),
            Status::Paused => write!(f, "Paused"),
            Status::Acting => write!(f, "Acting"),
            Status::Error(why) => write!(f, "{why}"),
        }
    }
}

/// Shared between the run loop and the tray: status, Pause, Stop now, Quit.
#[derive(Default)]
pub struct Control {
    paused: AtomicBool,
    stop: AtomicBool,
    quit: AtomicBool,
    status: Mutex<Option<Status>>,
}

impl Control {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    pub fn status(&self) -> Status {
        self.status
            .lock()
            .unwrap()
            .clone()
            .unwrap_or(Status::Connecting)
    }
    pub fn set_status(&self, status: Status) {
        *self.status.lock().unwrap() = Some(status);
    }
    /// Pausing stops polling and beating, so the server marks the computer offline.
    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
        if paused {
            self.stop_now();
        }
    }
    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }
    /// Ends the running batch at its next action.
    pub fn stop_now(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
    pub fn quit(&self) {
        self.quit.store(true, Ordering::SeqCst);
        self.stop_now();
    }
    pub fn should_quit(&self) -> bool {
        self.quit.load(Ordering::SeqCst)
    }
    /// Why a batch must stop now, if it must.
    pub fn interrupted(&self) -> Option<&'static str> {
        if self.stop.load(Ordering::SeqCst) {
            Some("stopped from the helper's menu")
        } else {
            None
        }
    }
    fn begin_batch(&self) {
        self.stop.store(false, Ordering::SeqCst);
    }
}

/// Answer one command.
pub fn handle(backend: &mut dyn Backend, command: &Command, control: &Control) -> CommandResult {
    match command {
        Command::Observe {
            screenshot,
            max_elements,
            ..
        } => match backend.observe(*screenshot, (*max_elements).clamp(1, policy::MAX_ELEMENTS)) {
            Ok(observation) => CommandResult::observation(observation),
            Err(error) => CommandResult::error(error),
        },
        Command::Act {
            frame_id, actions, ..
        } => {
            if let Decision::Refuse(reason) =
                policy::batch(frame_id, actions, backend.current_frame_id().as_deref())
            {
                return CommandResult::act(ActResult {
                    outcomes: vec![],
                    stopped_reason: Some(reason),
                });
            }
            control.begin_batch();
            CommandResult::act(backend.act(actions, control))
        }
    }
}

fn sleep_unless_quit(control: &Control, total: Duration) {
    let step = Duration::from_millis(100);
    let mut slept = Duration::ZERO;
    while slept < total && !control.should_quit() {
        thread::sleep(step);
        slept += step;
    }
}

/// Run until [`Control::quit`]. Blocks the calling thread; the heartbeat runs on its own.
pub fn run(
    config: &HelperConfig,
    backend: &mut dyn Backend,
    control: Arc<Control>,
    version: Option<String>,
) {
    if !config.is_configured() {
        control.set_status(Status::NotConfigured);
        return;
    }
    let transport = Arc::new(Transport::new(config));
    let heartbeat = Heartbeat {
        platform: backend.platform(),
        capabilities: backend.capabilities(),
        helper_version: version,
    };
    let beat = {
        let (transport, control) = (transport.clone(), control.clone());
        thread::spawn(move || {
            while !control.should_quit() {
                if !control.is_paused() {
                    let _ = transport.heartbeat(&heartbeat);
                }
                sleep_unless_quit(&control, HEARTBEAT_EVERY);
            }
        })
    };
    let mut backoff = Duration::from_secs(1);
    while !control.should_quit() {
        if control.is_paused() {
            control.set_status(Status::Paused);
            sleep_unless_quit(&control, Duration::from_secs(1));
            continue;
        }
        match transport.next(POLL_WAIT_SECONDS) {
            Ok(None) => {
                control.set_status(Status::Connected);
                backoff = Duration::from_secs(1);
            }
            Ok(Some(command)) => {
                control.set_status(Status::Acting);
                let result = handle(backend, &command, &control);
                match transport.post_result(command.id(), &result) {
                    Ok(()) => control.set_status(Status::Connected),
                    Err(error) => control.set_status(Status::Error(error.to_string())),
                }
                backoff = Duration::from_secs(1);
            }
            Err(error) => {
                let wait = if error.is_lasting() {
                    Duration::from_secs(60)
                } else {
                    backoff
                };
                control.set_status(Status::Error(error.to_string()));
                sleep_unless_quit(&control, wait);
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
        }
    }
    let _ = beat.join();
}
