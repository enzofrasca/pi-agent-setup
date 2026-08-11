# lean-pi

Minimal personal harness for the [pi](https://github.com/earendil-works/pi-mono) coding agent.

```bash
git clone https://github.com/enzofrasca/lean-pi.git /tmp/lean-pi
cp -R /tmp/lean-pi/extensions/* ~/.pi/agent/extensions/
pi install npm:pi-mcp-adapter
# Do NOT install npm:@ff-labs/pi-fff — use the lean local package instead:
# settings.json → "packages": ["extensions/fff", …]
cp /tmp/lean-pi/.env.example ~/.pi/agent/.env  # fill keys
```

| Extension | Role |
|-----------|------|
| `defaults` | FFF override env, MCP gate (tools + conditional skill), lean prompt |
| `fff` | Lean FFF `find`/`grep` (override mode, no guidelines; package via `settings.packages`) |
| `search-web` | Exa + Firecrawl |
| `ui` | footer + titlebar |
