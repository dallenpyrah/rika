# Execution control

Users may steer text into the active Execution, cancel durable work, and answer permission or tool-approval waits. Steering is an active-Execution action; steering a Pending Turn removes it from the queue, and queued image input cannot be converted to steering.

Interrupt-and-send first admits a replacement prompt durably, then cancels the active Turn and promotes the replacement. If admission fails, the active Turn continues.

Relay owns cancellation and wait resolution. Permission choices are allow, deny, or always allow; for a tool-approval wait, both allow choices approve that request. Control requests report failure instead of pretending the action succeeded, and unresolved actionable waits keep the Turn in `waiting` so they can resume after reconnect or restart.
