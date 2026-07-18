# Terminal lifecycle

The OpenTUI renderer is owned by a scope: startup acquires it once, normal exit releases input handlers and renderables, and shutdown restores terminal state. External editor use and terminal suspension pause interactive rendering without discarding the Thread view.

The application inherits the terminal's default transparent background and never paints an application background. Cursor focus and blinking follow the active composer or overlay and stop during teardown.
