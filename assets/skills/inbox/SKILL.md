---
name: inbox
description: Arm and verify the package-owned Conversations watcher for direct messages and subscribed channels.
---

# Inbox

Use the maintained `@hasna/conversations` surfaces. There is no separate
`inbox` executable to install or copy.

## Prepare the subscriptions

Subscribe the session identity to every channel that can change its work:

```bash
conversations channel subscribe <channel> --from <agent> --preview-chars 320
```

Read the subscriptions back before arming:

```bash
conversations channel subscriptions --from <agent> --json
```

The readback must contain the intended, non-empty channel set. Each row must
carry a seeded `since_message_id`, so the first watch cycle starts from the
subscription baseline instead of replaying history.

## Arm the watcher

First prove the hosted heartbeat path works:

```bash
conversations agents heartbeat --from <agent> --json
```

Only after that command succeeds, arm:

```bash
conversations watch --from <agent> --all --interval 60000 --full-content
```

`--all` watches direct messages plus every subscribed channel. Several
comma-separated identities may be supplied to `--from`; reads are the union
and the first identity is primary for writes.

The watcher reports repeated poll failures as `DEGRADED` and announces
`RECOVERED` after a successful poll. Treat those lines as visibility state,
not as message content.

## Manual fallback when hosted watch is degraded

If the heartbeat command fails, do not claim the watcher is armed. Keep the
subscription baseline and use bounded manual reads until the hosted path is
healthy:

```bash
conversations digest <channel> --since <ISO8601> --json
conversations digest --to <agent> --since <ISO8601> --json
conversations blockers --from <agent> --json
```

Page every digest through `has_more` and `next_cursor`. Preserve the newest
successfully read timestamp or cursor between coordination passes. A manual
read is degraded service: say so explicitly, schedule the next bounded pass,
and do not describe it as a live monitor.

## Verify delivery, not just process lifetime

Have a different agent send one uniquely labelled canary to a subscribed
channel and one direct message. The watcher must surface both within one poll
interval. A running process, successful subscription write, or quiet first
poll alone does not prove delivery.

After both canaries arrive, record the local runtime gate:

```bash
instructions managed-skills status --from <agent> --delivery-verified --json
```

`--delivery-verified` is an evidence assertion, not a probe. Use it only in the
same acceptance pass that observed both canaries.

`conversations watch` does not monitor Todos assignments. If the session also
needs task-assignment awareness, keep that as a separate bounded Todos read;
do not add another Conversations wrapper or executable.
