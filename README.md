# pi-agent-setup

Personal [pi](https://github.com/earendil-works/pi-mono) extensions.

```bash
git clone https://github.com/enzofrasca/pi-agent-setup.git /tmp/pi-agent-setup
cp -R /tmp/pi-agent-setup/extensions/* ~/.pi/agent/extensions/
pi install npm:pi-mcp-adapter
# Do NOT install npm:@ff-labs/pi-fff — use the lean local package instead:
# settings.json → "packages": ["extensions/fff", …]
cp /tmp/pi-agent-setup/.env.example ~/.pi/agent/.env  # fill keys
```

| Extension | Role |
|-----------|------|
| `defaults` | FFF override env, MCP gate (tools + conditional skill), lean prompt |
| `fff` | Lean FFF `find`/`grep` (override mode, no guidelines; package via `settings.packages`) |
| `search-web` | Exa + Firecrawl |
| `ui` | footer + titlebar |
