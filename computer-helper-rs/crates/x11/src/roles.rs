//! AT-SPI roles (by their readable names, as `atspi::Role::name` gives them)
//! mapped onto the shared `ComputerRole` vocabulary, and which of them the
//! element list keeps.

/// The shared role for an AT-SPI role name; "other" when there is none.
pub fn shared(native: &str) -> &'static str {
    match native {
        "button" | "push button menu" | "spin button" | "arrow" | "color chooser" => "button",
        "toggle button" => "switch",
        "check box" | "check menu item" => "checkbox",
        "radio button" | "radio menu item" => "radio",
        "entry" | "password text" | "spin box" => "textfield",
        "text" | "document text" | "terminal" => "textarea",
        "combo box" => "combobox",
        "menu" | "popup menu" | "menu bar" => "menu",
        "menu item" | "tearoff menu item" => "menuitem",
        "link" => "link",
        "page tab" => "tab",
        "list" | "list box" | "tree" | "tree table" | "table" => "list",
        "list item" | "tree item" => "listitem",
        "table row" => "row",
        "table cell"
        | "column header"
        | "row header"
        | "table column header"
        | "table row header" => "cell",
        "slider" | "scroll bar" | "dial" => "slider",
        "label" | "static" | "paragraph" | "caption" | "status bar" => "text",
        "heading" => "heading",
        "image" | "icon" | "desktop icon" => "image",
        _ => "other",
    }
}

/// Roles the model can act on: kept whether or not they carry text.
pub fn actionable(native: &str) -> bool {
    matches!(
        native,
        "button"
            | "push button menu"
            | "toggle button"
            | "check box"
            | "check menu item"
            | "radio button"
            | "radio menu item"
            | "entry"
            | "password text"
            | "text"
            | "document text"
            | "terminal"
            | "combo box"
            | "menu"
            | "menu item"
            | "link"
            | "page tab"
            | "slider"
            | "spin button"
            | "list item"
            | "tree item"
    )
}

/// Roles kept only when they carry text, so the model can read the screen.
pub fn textual(native: &str) -> bool {
    matches!(
        native,
        "label"
            | "static"
            | "paragraph"
            | "heading"
            | "table cell"
            | "table row"
            | "image"
            | "caption"
            | "status bar"
    )
}

/// Roles a single left click on a ref runs through the element's own action
/// (DoAction) rather than a pointer click, as the macOS helper presses
/// buttons with AXPress.
pub fn pressable(native: &str) -> bool {
    matches!(
        native,
        "button"
            | "push button menu"
            | "toggle button"
            | "check box"
            | "check menu item"
            | "radio button"
            | "radio menu item"
            | "menu item"
            | "link"
            | "page tab"
    )
}

/// The action names that mean "press" on AT-SPI elements.
pub fn is_press_action(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "click" | "press" | "activate" | "jump" | "toggle" | "select" | "switch"
    )
}

/// Never read a password field's value.
pub fn is_secret(native: &str) -> bool {
    native == "password text"
}

#[cfg(test)]
mod tests {
    use super::*;
    use computer_core::protocol::ROLES;

    const NATIVE: &[&str] = &[
        "button",
        "push button menu",
        "spin button",
        "arrow",
        "color chooser",
        "toggle button",
        "check box",
        "check menu item",
        "radio button",
        "radio menu item",
        "entry",
        "password text",
        "spin box",
        "text",
        "document text",
        "terminal",
        "combo box",
        "menu",
        "popup menu",
        "menu bar",
        "menu item",
        "tearoff menu item",
        "link",
        "page tab",
        "list",
        "list box",
        "tree",
        "tree table",
        "table",
        "list item",
        "tree item",
        "table row",
        "table cell",
        "column header",
        "row header",
        "table column header",
        "table row header",
        "slider",
        "scroll bar",
        "dial",
        "label",
        "static",
        "paragraph",
        "caption",
        "status bar",
        "heading",
        "image",
        "icon",
        "desktop icon",
        "frame",
        "panel",
        "filler",
    ];

    #[test]
    fn every_mapping_is_a_shared_role() {
        for native in NATIVE {
            assert!(ROLES.contains(&shared(native)), "{native}");
        }
        assert_eq!(shared("push button menu"), "button");
        assert_eq!(shared("password text"), "textfield");
        assert_eq!(shared("panel"), "other");
    }

    #[test]
    fn keeps_controls_and_text_and_hides_secrets() {
        assert!(actionable("entry") && actionable("link"));
        assert!(!actionable("panel") && !actionable("label"));
        assert!(textual("label") && !textual("filler"));
        assert!(pressable("button") && !pressable("entry"));
        assert!(is_press_action("Click") && is_press_action("jump") && !is_press_action("menu"));
        assert!(is_secret("password text") && !is_secret("entry"));
    }
}
