# Transport adapters

Normalize an upstream connection once into authorized Source/Channel identities. Multiplexed channel IDs must come from authenticated transport context, not arbitrary payload claims. Commit capture before acknowledging an upstream protocol that supports replay/ack. A target's model acknowledgment is not an upstream acknowledgment for every subscriber.

No network ingress, stdin WritePort or assistant-to-source forwarding is implemented. Receive, wake and egress are separate authorities; do not construct an implicit agent feedback loop. A source-host reconnect may retain a channel identity only when it actually continues the same authorized upstream work.
