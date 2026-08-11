# pi-agent-setup

Personal [pi](https://github.com/earendil-works/pi-mono) extensions.

```bash
git clone https://github.com/enzofrasca/pi-agent-setup.git /tmp/pi-agent-setup
cp -R /tmp/pi-agent-setup/extensions/* ~/.pi/agent/extensions/
pi install npm:@ff-labs/pi-fff
pi install npm:pi-mcp-adapter
cp /tmp/pi-agent-setup/.env.example ~/.pi/agent/.env  # fill keys
```

| Extension | Role |
|-----------|------|
| `defaults` | FFF override, MCP gate (tools + conditional skill), lean prompt |
| `search-web` | Exa + Firecrawl |
| `subagents` | scout / planner / worker / reviewer / oracle + project `.pi/agents/*.md` (cwd; highest precedence) |
| `ui` | footer + titlebar |
