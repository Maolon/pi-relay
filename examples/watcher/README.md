# Watchers

Register an explicit owner-approved durable schema and use `connectChannel` to publish observed facts with stable IDs. A watcher's inactivity is not failure or completion. Do not use a timeout to invent a completion event, and do not tie a long-lived source to one subscriber's attachment. A new subscriber starts at the membership cut, not the source's untrusted `occurredAt` timestamp.
