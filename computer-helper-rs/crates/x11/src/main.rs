//! `computer-helper-x11`: connects an X11 desktop to chat. See the crate
//! docs and `config` for its settings.

#[cfg(target_os = "linux")]
fn main() {
    use std::time::Duration;

    let (config, platform) = match computer_x11::config::load(|k| std::env::var(k).ok()) {
        Ok(c) => c,
        Err(why) => {
            eprintln!("computer-helper-x11: {why}");
            std::process::exit(2);
        }
    };
    let mut backend = match computer_x11::X11Backend::new(config.clone(), platform) {
        Ok(b) => b,
        Err(why) => {
            eprintln!("computer-helper-x11: {why}");
            std::process::exit(1);
        }
    };
    let control = computer_client::Control::new();
    {
        // Log each status change, never the settings themselves.
        let control = control.clone();
        std::thread::spawn(move || {
            let mut last = None;
            loop {
                let status = control.status();
                if last.as_ref() != Some(&status) {
                    eprintln!("computer-helper-x11: {status}");
                    last = Some(status);
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        });
    }
    computer_client::run(
        &config,
        &mut backend,
        control,
        Some(env!("CARGO_PKG_VERSION").to_string()),
    );
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("computer-helper-x11 runs on Linux only.");
    std::process::exit(1);
}
