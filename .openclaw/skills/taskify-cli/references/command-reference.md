# Taskify CLI Command Reference

## Core task lifecycle

```bash
taskify list --status any --json
taskify add "Ship release notes" --board "Work" --priority 2
taskify search "release notes" --status any --json
taskify update <taskId> --due "2026-03-15" --column "In Progress"
taskify done <taskId>
taskify reopen <taskId>
taskify delete <taskId> --force
```

## Inbox

```bash
taskify inbox list --board "Work"
taskify inbox add "Follow up with design" --board "Work"
taskify inbox triage <taskId> --board "Work" --column "Backlog" --priority 2 --yes
```

## Boards

```bash
taskify boards --json
taskify board list
taskify board columns "Work"
taskify board create "Sprint 12" --kind lists --columns "To do, Doing, Done"
taskify board sync
```

## Import/export

```bash
taskify export --board "Work" --format json --output /tmp/work-tasks.json
taskify import /tmp/work-tasks.json --board "Work" --dry-run
taskify import /tmp/work-tasks.json --board "Work" --yes
```

## Profiles

```bash
taskify profile list
taskify profile add cody
taskify profile use cody
taskify list --profile cody --json
```
