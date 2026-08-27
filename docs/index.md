---
layout: home
hero:
  name: 'ntfy-mcp'
  text: 'Notifications your MCP client can send, read back and correct'
  tagline: 'An MCP server for ntfy: publish notifications, read back what was sent, revise one in place while a job runs, and administer accounts and topic access.'
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Tools reference
      link: /reference/tools
    - theme: alt
      text: GitHub
      link: https://github.com/ni-c/ntfy-mcp
# Four cards, not three and not five. VitePress picks the grid from the array
# length: four fill a row, while five and seven both fall into grid-4 and leave a
# ragged orphan row. If a fifth is worth having, fold two existing ones together.
#
# NEVER write ": " inside an unquoted details value. YAML reads it as a mapping and
# the VitePress build dies with "incomplete explicit mapping pair", pointing at a
# column rather than at the cause. Use an em dash — or quote the whole value, as
# every card below does.
features:
  - title: 'A progress report stays one notification'
    details: 'The id publish_message returns is also the sequence id of the notification, and update_message replaces its content in place. Subscribers watch one notification change from "building" to "deployed" instead of collecting five.'
  - title: 'NTFY_TOPICS is the fence'
    details: 'On ntfy a topic name is a bearer credential — knowing it is often the whole of the access control. One variable names the topics this server may touch and supplies the default when a tool omits one, so the name stays out of the tool arguments and every read and write is bounded by the same list.'
  - title: 'Only the tools you want'
    details: 'NTFY_READ_ONLY=true registers the read tools and nothing else. NTFY_ALLOW_TOOLS cuts finer — essential for a curated six, your own comma-separated list, or a whole family with list_* — and NTFY_DENY_TOOLS subtracts. Whatever is filtered out does not exist on the protocol rather than failing when called, and a name that matches no tool stops the server at startup instead of quietly going missing.'
  - title: 'Careful with what it hands back'
    details: 'Deleting anything needs a server-issued confirmation token bound to the exact target, notification content is marked as untrusted data, access tokens are stripped out of get_account, and a click or action URL must be http or https because the recipient device is what opens it.'
---
