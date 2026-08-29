# vhs script for the demo GIF: `vhs docs/demo.tape` writes public/demo.gif
#
# Prerequisites:
#   * vhs installed (https://github.com/charmbracelet/vhs)
#   * docker, to run the throwaway ntfy the tape records against
#   * the server built (npm run build)
#   * run from the repository root, not from docs/
#
# NO real ntfy instance is involved. The Hide block below starts a disposable
# container on port 18080 with an empty cache, so the recording is reproducible
# by anyone and the write tools have nothing of value to touch. The MCP server
# under demonstration runs unmodified; only the ntfy behind it is disposable.
#
# Traps, all of which have cost time before:
#   1. vhs starts its own shell — exported variables do not arrive. And the MCP
#      Inspector's stdio transport passes only an allowlisted environment to the
#      spawned server, so NTFY_* must be handed over with explicit `-e` flags,
#      which the wrapper function below does.
#   2. `-e` must come AFTER the server command: `--cli -e K=V node dist/index.js`
#      makes the inspector lose the target ("No servers found in config file").
#   3. Inside a Hide block use vhs's own `Sleep`, never the shell's — a shell
#      sleep blocks and the tape ends before any output is recorded.
#   4. The sequence id in beat 3 is read back out of beat 2's response rather
#      than hard-coded: ntfy generates it, so a pasted id makes the tape a
#      one-shot recording that fails on every rerun.
#   5. vhs's parser does not accept escaped double quotes inside a Type string —
#      it stops at the backslash and reports the remainder as an invalid
#      command. Keep every inner quote single.

Output docs/public/demo.gif

Set FontSize 16
Set Width 1200
Set Height 700
Set Padding 20
Set Theme "Catppuccin Mocha"

Hide
Sleep 1s
Type "clear" Enter
Sleep 500ms
Type "docker rm -f ntfy-demo >/dev/null 2>&1; docker run -d --name ntfy-demo -p 18080:80 -e NTFY_BASE_URL=http://127.0.0.1:18080 -e NTFY_CACHE_FILE=/tmp/cache.db binwiederhier/ntfy:latest serve >/dev/null 2>&1" Enter
Sleep 6s
Type 'mcp() { npx -y @modelcontextprotocol/inspector --cli node dist/index.js -e "NTFY_URL=http://127.0.0.1:18080" -e "NTFY_TOPICS=deploys" "$@" 2>/dev/null; }' Enter
Sleep 500ms
Type "clear" Enter
Sleep 500ms
Show

Type "# mcp() = the MCP Inspector CLI against ./dist/index.js, config via -e" Enter
Sleep 2s
Type "# 1. what does the server expose?" Enter
Sleep 1s
Type "mcp --method tools/list | jq -r '.tools[].name' | column" Enter
Sleep 8s
Type "# 2. send a notification — the id that comes back is the sequence id" Enter
Sleep 1500ms
Type "mcp --method tools/call --tool-name publish_message --tool-arg title=deploy --tool-arg message='Build 412 started' | tee /tmp/ntfy-demo-pub.json | jq -r '.content[0].text'" Enter
Sleep 8s
Type "# 3. the job finished: revise that same notification instead of sending a second one" Enter
Sleep 2s
Type "SEQ=$(jq -r '.content[0].text | fromjson | .results[0].sequence_id' /tmp/ntfy-demo-pub.json)" Enter
Sleep 3s
Type "mcp --method tools/call --tool-name update_message --tool-arg sequence_id=$SEQ --tool-arg title=deploy --tool-arg message='Build 412 deployed' | jq -r '.content[0].text'" Enter
Sleep 8s
Type "# subscribers see one notification change, not two arrive." Enter
Sleep 3s

Hide
Type "docker rm -f ntfy-demo >/dev/null 2>&1" Enter
Sleep 2s
