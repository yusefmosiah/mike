use computer_client::{Control, run_batch};
use computer_core::protocol::Action;

fn key(combo: &str) -> Action {
    Action::Key {
        combo: combo.into(),
    }
}

#[test]
fn runs_each_action_and_stops_at_the_first_failure() {
    let control = Control::new();
    let mut ran = Vec::new();
    let actions = [key("a"), Action::Wait { ms: 10 }, key("b"), key("c")];
    let result = run_batch(&actions, &control, |action| {
        ran.push(action.clone());
        match action {
            Action::Key { combo } if combo == "b" => Err("no b".into()),
            _ => Ok(()),
        }
    });
    assert_eq!(ran, vec![key("a"), key("b")]);
    assert_eq!(result.outcomes.len(), 3);
    assert!(result.outcomes[1].ok);
    assert_eq!(result.outcomes[2].error.as_deref(), Some("no b"));
    assert_eq!(
        result.stopped_reason.as_deref(),
        Some("action 2 failed: no b")
    );
}

#[test]
fn a_stop_interrupts_before_the_next_action_and_during_a_wait() {
    let control = Control::new();
    control.stop_now();
    let result = run_batch(&[key("a")], &control, |_| Ok(()));
    assert!(result.outcomes.is_empty());
    assert_eq!(
        result.stopped_reason.as_deref(),
        Some("stopped from the helper's menu")
    );

    let control = Control::new();
    let stopper = control.clone();
    let result = run_batch(&[key("a"), key("b")], &control, |_| {
        stopper.stop_now();
        Ok(())
    });
    assert_eq!(result.outcomes.len(), 1);
    assert!(result.stopped_reason.is_some());

    let control = Control::new();
    let stopper = control.clone();
    let thread = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(100));
        stopper.stop_now();
    });
    let result = run_batch(&[Action::Wait { ms: 5_000 }], &control, |_| Ok(()));
    thread.join().unwrap();
    assert!(!result.outcomes[0].ok);
}

#[test]
fn a_clean_batch_has_no_stopped_reason() {
    let result = run_batch(&[key("a"), key("b")], &Control::new(), |_| Ok(()));
    assert!(result.outcomes.iter().all(|o| o.ok));
    assert_eq!(result.stopped_reason, None);
}
