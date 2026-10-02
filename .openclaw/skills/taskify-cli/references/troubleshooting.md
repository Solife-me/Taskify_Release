# Taskify CLI Troubleshooting

## `taskify` command not found

Use local entrypoint from repo:

```bash
cd /Users/openclaw/.openclaw/workspace/Taskify_Release/taskify-cli
npm install
npm run build
node dist/index.js --help
```

Optional global link:

```bash
npm link
taskify --help
```

## Auth/key issues

Set key:

```bash
taskify config set nsec          # prompts without echoing; never put the key on the command line
# or, without storing it (read -s keeps it out of shell history):
read -rs TASKIFY_NSEC && export TASKIFY_NSEC
```

Check config:

```bash
taskify config show
```

## Relay/connectivity issues

```bash
taskify relay list
taskify relay status
taskify board sync
```

## Ambiguous task target

Always resolve with search JSON first:

```bash
taskify search "<query>" --status any --json
```
