# Computer protocol fixtures

One JSON file per wire shape of the "Computers" protocol in `../../index.d.ts`.
The Swift helper (`computer-helper/Tests`) and the Rust core
(`computer-helper-rs/crates/core/tests`) decode each one and encode it back
to the same JSON, so a field renamed in one place fails both suites.
