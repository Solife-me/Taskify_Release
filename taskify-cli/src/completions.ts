// Shell completion scripts for taskify CLI.
// Generated programmatically — do NOT use a completion library.

import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

function readBoardNames(): string[] {
  try {
    const configPath = join(homedir(), ".taskify-cli", "config.json");
    const raw = readFileSync(configPath, "utf-8");
    const cfg = JSON.parse(raw);
    return (cfg.boards ?? []).map((b: { name: string }) => b.name);
  } catch {
    return [];
  }
}

export function zshCompletion(): string {
  const boards = readBoardNames();
  const boardList = boards.length > 0
    ? boards.map((n) => `'${n.replace(/'/g, "'\\''")}'`).join(" ")
    : "";
  const boardComplete = boardList
    ? `    local boards=(${boardList})\n    _describe 'board' boards`
    : `    # no boards configured`;

  return `#compdef taskify
# taskify zsh completion
# Install: taskify completions --shell zsh > ~/.zsh/completions/_taskify

_taskify() {
  local state
  typeset -A opt_args

  _arguments -C \\
    '(-h --help)'{-h,--help}'[Show help]' \\
    '(-V --version)'{-V,--version}'[Show version]' \\
    '1: :->command' \\
    '*:: :->args'

  case $state in
    command)
      local commands
      commands=(
        'board:Manage boards'
        'boards:List configured boards'
        'list:List tasks'
        'show:Show full task details'
        'search:Search tasks by title or note'
        'add:Create a new task'
        'done:Mark a task as done'
        'reopen:Reopen a completed task'
        'update:Update task fields'
        'reorder:Reorder a task'
        'delete:Delete a task'
        'subtask:Toggle a subtask done/incomplete'
        'remind:Set device-local reminders on a task'
        'relay:Manage relay connections'
        'cache:Manage task cache'
        'trust:Manage trusted npubs'
        'config:Manage CLI config'
        'completions:Generate shell completions'
      )
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
        board)
          _taskify_board
          ;;
        list)
          _arguments \\
            '--board[Filter by board]:board:_taskify_boards' \\
            '--status[Filter status]:status:(open done any)' \\
            '--column[Filter by column]:column:' \\
            '--refresh[Bypass cache and fetch live]' \\
            '--json[Output as JSON]'
          ;;
        show)
          _arguments \\
            '1:task id:_taskify_cached_task_ids' \\
            '--board[Board to search in]:board:_taskify_boards' \\
            '--json[Output as JSON]'
          ;;
        search)
          _arguments \\
            '1:search query:' \\
            '--board[Limit to board]:board:_taskify_boards' \\
            '--json[Output as JSON]'
          ;;
        add)
          _arguments \\
            '1:task title:' \\
            '--board[Board to add to]:board:_taskify_boards' \\
            '--due[Due date (YYYY-MM-DD)]:date:' \\
            '--priority[Priority]:priority:(1 2 3)' \\
            '--note[Note text]:note:' \\
            '--subtask[Add subtask (repeatable)]:subtask:' \\
            '--json[Output as JSON]'
          ;;
        done)
          _arguments \\
            '1:task id:_taskify_cached_task_ids' \\
            '--board[Board]:board:_taskify_boards' \\
            '--json[Output as JSON]'
          ;;
        reopen)
          _arguments \\
            '1:task id:_taskify_cached_task_ids' \\
            '--board[Board]:board:_taskify_boards' \\
            '--json[Output as JSON]'
          ;;
        reorder)
          _arguments \\
            '1:task id:_taskify_cached_task_ids' \\
            '2:position:' \\
            '--board[Board]:board:_taskify_boards' \\
            '--in[Board/List]:location:' \\
            '--column[Column]:column:' \\
            '--human[Readable output]' \\
            '--json[Output as JSON]'
          ;;
        update)
          _arguments \\
            '1:task id:_taskify_cached_task_ids' \\
            '--board[Board]:board:_taskify_boards' \\
            '--order[Task order]:order:' \\
            '--title[New title]:title:' \\
            '--due[New due date]:date:' \\
            '--priority[New priority]:priority:(1 2 3)' \\
            '--note[New note]:note:' \\
            '--json[Output as JSON]'
          ;;
        delete)
          _arguments \\
            '1:task id:_taskify_cached_task_ids' \\
            '--board[Board]:board:_taskify_boards' \\
            '--force[Skip confirmation]' \\
            '--json[Output deleted task as JSON]'
          ;;
        subtask)
          _arguments \\
            '1:task id:_taskify_cached_task_ids' \\
            '2:subtask ref (index or title):' \\
            '--board[Board]:board:_taskify_boards' \\
            '--done[Mark completed]' \\
            '--reopen[Mark incomplete]' \\
            '--json[Output as JSON]'
          ;;
        remind)
          _arguments \\
            '1:task id:_taskify_cached_task_ids' \\
            '*:preset:(0h 5m 15m 30m 1h 1d 1w)' \\
            '--board[Board]:board:_taskify_boards'
          ;;
        relay)
          _taskify_relay
          ;;
        cache)
          _taskify_cache
          ;;
        trust)
          _taskify_trust
          ;;
        config)
          _taskify_config
          ;;
        completions)
          _arguments \\
            '--shell[Shell type]:shell:(zsh bash fish)'
          ;;
      esac
      ;;
  esac
}

_taskify_board() {
  local state
  _arguments -C \\
    '1: :->subcommand' \\
    '*:: :->args'
  case $state in
    subcommand)
      local subcommands
      subcommands=(
        'list:List configured boards'
        'join:Join a board by UUID'
        'leave:Remove a board from config'
        'sync:Sync board metadata from Nostr'
        'columns:Show cached columns for all boards'
      )
      _describe 'board subcommand' subcommands
      ;;
    args)
      case $words[1] in
        join)
          _arguments \\
            '1:board UUID:' \\
            '--name[Board name]:name:' \\
            '--relay[Relay URL]:url:'
          ;;
        leave)
          _arguments '1:board id:_taskify_boards'
          ;;
        sync)
          _arguments '1:board id or name:_taskify_boards'
          ;;
      esac
      ;;
  esac
}

_taskify_relay() {
  local state
  _arguments -C \\
    '1: :->subcommand' \\
    '*:: :->args'
  case $state in
    subcommand)
      local subcommands
      subcommands=(
        'status:Show NDK pool relay connection status'
        'list:Show configured relays with live check'
        'add:Add a relay URL to config'
        'remove:Remove a relay URL from config'
      )
      _describe 'relay subcommand' subcommands
      ;;
    args)
      case $words[1] in
        add|remove)
          _arguments '1:relay url:'
          ;;
      esac
      ;;
  esac
}

_taskify_cache() {
  local state
  _arguments -C \\
    '1: :->subcommand' \\
    '*:: :->args'
  case $state in
    subcommand)
      local subcommands
      subcommands=(
        'clear:Delete the task cache file'
        'status:Show per-board cache age and task count'
      )
      _describe 'cache subcommand' subcommands
      ;;
  esac
}

_taskify_trust() {
  local state
  _arguments -C \\
    '1: :->subcommand' \\
    '*:: :->args'
  case $state in
    subcommand)
      local subcommands
      subcommands=('add:Add trusted npub' 'remove:Remove trusted npub' 'list:List trusted npubs')
      _describe 'trust subcommand' subcommands
      ;;
  esac
}

_taskify_config() {
  local state
  _arguments -C \\
    '1: :->subcommand' \\
    '*:: :->args'
  case $state in
    subcommand)
      local subcommands
      subcommands=('set:Set config values' 'show:Show current config')
      _describe 'config subcommand' subcommands
      ;;
  esac
}

_taskify_boards() {
${boardComplete}
}

# Complete open task IDs from local cache (reads ~/.config/taskify/cache.json at completion time)
_taskify_cached_task_ids() {
  local cache_file="\${HOME}/.config/taskify/cache.json"
  [[ -f "\${cache_file}" ]] || return
  local -a tasks
  local raw
  raw=\$(node -e "
try {
  const fs=require('fs');
  const c=JSON.parse(fs.readFileSync(process.env.HOME+'/.config/taskify/cache.json','utf8'));
  const now=Date.now();
  Object.values(c.boards||{}).forEach(b=>{
    if(now-b.fetchedAt<300000){
      (b.tasks||[]).forEach(t=>{
        if(t.status==='open'){
          const title=(t.title||'').replace(/[:\\n]/g,' ').slice(0,60);
          process.stdout.write(t.id.slice(0,8)+':'+title+'\\n');
        }
      });
    }
  });
}catch(e){}" 2>/dev/null)
  [[ -n "\${raw}" ]] || return
  tasks=(\${(f)raw})
  _describe 'task id' tasks
}

_taskify
`;
}

export function bashCompletion(): string {
  const boards = readBoardNames();
  const boardList = boards.map((n) => `"${n.replace(/"/g, '\\"')}"`).join(" ");

  return `# taskify bash completion
# Install: taskify completions --shell bash > ~/.bash_completion.d/taskify
#          source ~/.bash_completion.d/taskify

_taskify_boards() {
  local boards=(${boardList})
  COMPREPLY=(\$(compgen -W "\${boards[*]}" -- "\${cur}"))
}

_taskify_cached_task_ids() {
  local cache_file="\${HOME}/.config/taskify/cache.json"
  [[ -f "\${cache_file}" ]] || return
  local raw
  raw=\$(node -e "
try {
  const fs=require('fs');
  const c=JSON.parse(fs.readFileSync(process.env.HOME+'/.config/taskify/cache.json','utf8'));
  const now=Date.now();
  Object.values(c.boards||{}).forEach(b=>{
    if(now-b.fetchedAt<300000){
      (b.tasks||[]).forEach(t=>{
        if(t.status==='open') process.stdout.write(t.id.slice(0,8)+'\\n');
      });
    }
  });
}catch(e){}" 2>/dev/null)
  COMPREPLY=(\$(compgen -W "\${raw}" -- "\${cur}"))
}

_taskify() {
  local cur prev words cword
  _init_completion 2>/dev/null || {
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    words=("\${COMP_WORDS[@]}")
    cword=\$COMP_CWORD
  }

  local commands="board boards list show search add done reopen update reorder delete subtask remind relay cache trust config completions"
  local board_subcmds="list join leave sync columns"
  local relay_subcmds="status list add remove"
  local cache_subcmds="clear status"
  local trust_subcmds="add remove list"

  # If completing the first argument
  if [[ \$cword -eq 1 ]]; then
    COMPREPLY=(\$(compgen -W "\$commands" -- "\$cur"))
    return
  fi

  local cmd="\${words[1]}"

  case "\$cmd" in
    board)
      if [[ \$cword -eq 2 ]]; then
        COMPREPLY=(\$(compgen -W "\$board_subcmds" -- "\$cur"))
        return
      fi
      local subcmd="\${words[2]}"
      case "\$subcmd" in
        join)
          case "\$prev" in
            --name|--relay) return ;;
          esac
          COMPREPLY=(\$(compgen -W "--name --relay" -- "\$cur"))
          ;;
        leave|sync)
          _taskify_boards
          ;;
      esac
      ;;
    list)
      case "\$prev" in
        --board) _taskify_boards ; return ;;
        --status) COMPREPLY=(\$(compgen -W "open done any" -- "\$cur")) ; return ;;
        --column) return ;;
      esac
      COMPREPLY=(\$(compgen -W "--board --status --column --refresh --json" -- "\$cur"))
      ;;
    show)
      if [[ \$cword -eq 2 ]]; then _taskify_cached_task_ids ; return ; fi
      case "\$prev" in
        --board) _taskify_boards ; return ;;
      esac
      COMPREPLY=(\$(compgen -W "--board --json" -- "\$cur"))
      ;;
    search)
      case "\$prev" in
        --board) _taskify_boards ; return ;;
      esac
      COMPREPLY=(\$(compgen -W "--board --json" -- "\$cur"))
      ;;
    add)
      case "\$prev" in
        --board) _taskify_boards ; return ;;
        --priority) COMPREPLY=(\$(compgen -W "1 2 3" -- "\$cur")) ; return ;;
        --due|--note|--subtask) return ;;
      esac
      COMPREPLY=(\$(compgen -W "--board --due --priority --note --subtask --json" -- "\$cur"))
      ;;
    done|reopen)
      if [[ \$cword -eq 2 ]]; then _taskify_cached_task_ids ; return ; fi
      case "\$prev" in
        --board) _taskify_boards ; return ;;
      esac
      COMPREPLY=(\$(compgen -W "--board --json" -- "\$cur"))
      ;;
    reorder)
      COMPREPLY=(\$(compgen -W "--board --in --column --json --human" -- "\$cur"))
      ;;
    update)
      if [[ \$cword -eq 2 ]]; then _taskify_cached_task_ids ; return ; fi
      case "\$prev" in
        --board) _taskify_boards ; return ;;
        --priority) COMPREPLY=(\$(compgen -W "1 2 3" -- "\$cur")) ; return ;;
        --title|--due|--note) return ;;
      esac
      COMPREPLY=(\$(compgen -W "--board --title --due --priority --note --order --json" -- "\$cur"))
      ;;
    delete)
      if [[ \$cword -eq 2 ]]; then _taskify_cached_task_ids ; return ; fi
      case "\$prev" in
        --board) _taskify_boards ; return ;;
      esac
      COMPREPLY=(\$(compgen -W "--board --force --json" -- "\$cur"))
      ;;
    subtask)
      if [[ \$cword -eq 2 ]]; then _taskify_cached_task_ids ; return ; fi
      case "\$prev" in
        --board) _taskify_boards ; return ;;
      esac
      COMPREPLY=(\$(compgen -W "--board --done --reopen --json" -- "\$cur"))
      ;;
    remind)
      if [[ \$cword -eq 2 ]]; then _taskify_cached_task_ids ; return ; fi
      case "\$prev" in
        --board) _taskify_boards ; return ;;
        remind) return ;; # task id
      esac
      if [[ \$cword -gt 2 ]]; then
        COMPREPLY=(\$(compgen -W "0h 5m 15m 30m 1h 1d 1w --board" -- "\$cur"))
      fi
      ;;
    relay)
      if [[ \$cword -eq 2 ]]; then
        COMPREPLY=(\$(compgen -W "\$relay_subcmds" -- "\$cur"))
      fi
      ;;
    cache)
      if [[ \$cword -eq 2 ]]; then
        COMPREPLY=(\$(compgen -W "\$cache_subcmds" -- "\$cur"))
      fi
      ;;
    trust)
      if [[ \$cword -eq 2 ]]; then
        COMPREPLY=(\$(compgen -W "\$trust_subcmds" -- "\$cur"))
      fi
      ;;
    completions)
      case "\$prev" in
        --shell) COMPREPLY=(\$(compgen -W "zsh bash fish" -- "\$cur")) ; return ;;
      esac
      COMPREPLY=(\$(compgen -W "--shell" -- "\$cur"))
      ;;
  esac
}

complete -F _taskify taskify
`;
}

export function fishCompletion(): string {
  const boards = readBoardNames();
  const boardCompletions = boards
    .map((n) => `complete -c taskify -n '__taskify_using_board_opt' -a '${n.replace(/'/g, "\\'")}' -d 'Board'`)
    .join("\n");

  return `# taskify fish completion
# Install: taskify completions --shell fish > ~/.config/fish/completions/taskify.fish

function __taskify_no_subcommand
  set -l cmd (commandline -poc)
  set -e cmd[1]
  for c in $cmd
    if string match -qr '^[^-]' -- $c
      return 1
    end
  end
  return 0
end

function __taskify_subcommand_is
  set -l cmd (commandline -poc)
  set -e cmd[1]
  for c in $cmd
    if string match -qr '^[^-]' -- $c
      test "$c" = "$argv[1]"
      return
    end
  end
  return 1
end

function __taskify_board_subcommand_is
  set -l cmd (commandline -poc)
  set -e cmd[1]
  set -l saw_board 0
  for c in $cmd
    if string match -qr '^[^-]' -- $c
      if test $saw_board -eq 0
        if test "$c" = "board"
          set saw_board 1
        else
          return 1
        end
      else
        test "$c" = "$argv[1]"
        return
      end
    end
  end
  return 1
end

function __taskify_using_board_opt
  set -l cmd (commandline -poc)
  string match -q -- '--board' $cmd[-1]
end

# Top-level subcommands
complete -c taskify -f -n '__taskify_no_subcommand' -a board       -d 'Manage boards'
complete -c taskify -f -n '__taskify_no_subcommand' -a boards      -d 'List configured boards'
complete -c taskify -f -n '__taskify_no_subcommand' -a list        -d 'List tasks'
complete -c taskify -f -n '__taskify_no_subcommand' -a show        -d 'Show full task details'
complete -c taskify -f -n '__taskify_no_subcommand' -a search      -d 'Search tasks'
complete -c taskify -f -n '__taskify_no_subcommand' -a add         -d 'Create a new task'
complete -c taskify -f -n '__taskify_no_subcommand' -a done        -d 'Mark a task as done'
complete -c taskify -f -n '__taskify_no_subcommand' -a reopen      -d 'Reopen a completed task'
complete -c taskify -f -n '__taskify_no_subcommand' -a update      -d 'Update task fields'
complete -c taskify -f -n '__taskify_no_subcommand' -a delete      -d 'Delete a task'
complete -c taskify -f -n '__taskify_no_subcommand' -a subtask     -d 'Toggle a subtask'
complete -c taskify -f -n '__taskify_no_subcommand' -a remind      -d 'Set reminders on a task'
complete -c taskify -f -n '__taskify_no_subcommand' -a relay       -d 'Manage relay connections'
complete -c taskify -f -n '__taskify_no_subcommand' -a cache       -d 'Manage task cache'
complete -c taskify -f -n '__taskify_no_subcommand' -a trust       -d 'Manage trusted npubs'
complete -c taskify -f -n '__taskify_no_subcommand' -a config      -d 'Manage CLI config'
complete -c taskify -f -n '__taskify_no_subcommand' -a completions -d 'Generate shell completions'

# board subcommands
complete -c taskify -f -n '__taskify_subcommand_is board' -a list    -d 'List configured boards'
complete -c taskify -f -n '__taskify_subcommand_is board' -a join    -d 'Join a board by UUID'
complete -c taskify -f -n '__taskify_subcommand_is board' -a leave   -d 'Remove a board from config'
complete -c taskify -f -n '__taskify_subcommand_is board' -a sync    -d 'Sync board metadata from Nostr'
complete -c taskify -f -n '__taskify_subcommand_is board' -a columns -d 'Show cached columns'

# relay subcommands
complete -c taskify -f -n '__taskify_subcommand_is relay' -a status  -d 'Show NDK pool relay status'
complete -c taskify -f -n '__taskify_subcommand_is relay' -a list    -d 'Show configured relays'
complete -c taskify -f -n '__taskify_subcommand_is relay' -a add     -d 'Add a relay URL'
complete -c taskify -f -n '__taskify_subcommand_is relay' -a remove  -d 'Remove a relay URL'

# cache subcommands
complete -c taskify -f -n '__taskify_subcommand_is cache' -a clear   -d 'Delete the task cache'
complete -c taskify -f -n '__taskify_subcommand_is cache' -a status  -d 'Show cache status'

# board join options
complete -c taskify -f -n '__taskify_board_subcommand_is join' -l name  -d 'Board name'
complete -c taskify -f -n '__taskify_board_subcommand_is join' -l relay -d 'Relay URL'

# board sync / leave — complete board names
${boardCompletions || "# (no boards configured)"}

# list options
complete -c taskify -n '__taskify_subcommand_is list' -l board    -d 'Filter by board'
complete -c taskify -n '__taskify_subcommand_is list' -l status   -d 'Filter status' -a 'open done any'
complete -c taskify -n '__taskify_subcommand_is list' -l column   -d 'Filter by column'
complete -c taskify -n '__taskify_subcommand_is list' -l refresh  -d 'Bypass cache'
complete -c taskify -n '__taskify_subcommand_is list' -l json     -d 'Output as JSON'

# show options
complete -c taskify -n '__taskify_subcommand_is show' -l board -d 'Board to search in'
complete -c taskify -n '__taskify_subcommand_is show' -l json  -d 'Output as JSON'

# search options
complete -c taskify -n '__taskify_subcommand_is search' -l board -d 'Limit to board'
complete -c taskify -n '__taskify_subcommand_is search' -l json  -d 'Output as JSON'

# add options
complete -c taskify -n '__taskify_subcommand_is add' -l board    -d 'Board to add to'
complete -c taskify -n '__taskify_subcommand_is add' -l due      -d 'Due date (YYYY-MM-DD)'
complete -c taskify -n '__taskify_subcommand_is add' -l priority -d 'Priority' -a '1 2 3'
complete -c taskify -n '__taskify_subcommand_is add' -l note     -d 'Note text'
complete -c taskify -n '__taskify_subcommand_is add' -l subtask  -d 'Add subtask (repeatable)'
complete -c taskify -n '__taskify_subcommand_is add' -l json     -d 'Output as JSON'

# done options
complete -c taskify -n '__taskify_subcommand_is done' -l board -d 'Board'
complete -c taskify -n '__taskify_subcommand_is done' -l json  -d 'Output as JSON'

# reopen options
complete -c taskify -n '__taskify_subcommand_is reopen' -l board -d 'Board'
complete -c taskify -n '__taskify_subcommand_is reopen' -l json  -d 'Output as JSON'

complete -c taskify -f -n '__taskify_no_subcommand' -a reorder -d 'Reorder a task'
complete -c taskify -n '__taskify_subcommand_is reorder' -l board -d 'Board'
complete -c taskify -n '__taskify_subcommand_is reorder' -l in -d 'Board/List'
complete -c taskify -n '__taskify_subcommand_is reorder' -l column -d 'Column'
complete -c taskify -n '__taskify_subcommand_is reorder' -l json -d 'Output as JSON'
complete -c taskify -n '__taskify_subcommand_is reorder' -l human -d 'Readable output'
complete -c taskify -n '__taskify_subcommand_is update' -l order -d 'Task order'

# update options
complete -c taskify -n '__taskify_subcommand_is update' -l board    -d 'Board'
complete -c taskify -n '__taskify_subcommand_is update' -l title    -d 'New title'
complete -c taskify -n '__taskify_subcommand_is update' -l due      -d 'New due date'
complete -c taskify -n '__taskify_subcommand_is update' -l priority -d 'New priority' -a '1 2 3'
complete -c taskify -n '__taskify_subcommand_is update' -l note     -d 'New note'
complete -c taskify -n '__taskify_subcommand_is update' -l json     -d 'Output as JSON'

# delete options
complete -c taskify -n '__taskify_subcommand_is delete' -l board -d 'Board'
complete -c taskify -n '__taskify_subcommand_is delete' -l force -d 'Skip confirmation'
complete -c taskify -n '__taskify_subcommand_is delete' -l json  -d 'Output deleted task as JSON'

# subtask options
complete -c taskify -n '__taskify_subcommand_is subtask' -l board  -d 'Board'
complete -c taskify -n '__taskify_subcommand_is subtask' -l done   -d 'Mark completed'
complete -c taskify -n '__taskify_subcommand_is subtask' -l reopen -d 'Mark incomplete'
complete -c taskify -n '__taskify_subcommand_is subtask' -l json   -d 'Output as JSON'

# remind options
complete -c taskify -n '__taskify_subcommand_is remind' -l board -d 'Board'
complete -c taskify -f -n '__taskify_subcommand_is remind' -a '0h 5m 15m 30m 1h 1d 1w' -d 'Reminder preset'

# trust subcommands
complete -c taskify -f -n '__taskify_subcommand_is trust' -a add    -d 'Add trusted npub'
complete -c taskify -f -n '__taskify_subcommand_is trust' -a remove -d 'Remove trusted npub'
complete -c taskify -f -n '__taskify_subcommand_is trust' -a list   -d 'List trusted npubs'

# completions options
complete -c taskify -n '__taskify_subcommand_is completions' -l shell -d 'Shell type' -a 'zsh bash fish'
`;
}
