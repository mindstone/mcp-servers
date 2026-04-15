# 🍴 FruitNinja MCP

An MCP server that tells you the optimal way to cut any piece of fruit. Static dataset — no API key or internet connection required.

## Tools

| Tool | Description |
|------|-------------|
| `get_cutting_guide` | Full step-by-step guide for cutting a specific fruit |
| `list_fruits` | List all supported fruits |
| `compare_fruits` | Compare difficulty/technique across 2–5 fruits |

## Supported Fruits

🍎 apple · 🥑 avocado · 🥭 mango · 🍍 pineapple · 🍉 watermelon · 🍓 strawberry · 🥝 kiwi · 🍋 lemon/lime · 🍌 banana · 🍑 peach/nectarine

## Setup

```bash
npm install
npm run build
```

No `.env` needed — this server requires no credentials.

## Rebel Configuration

```json
{
  "name": "FruitNinja",
  "command": "node",
  "args": ["~/mcp-servers/fruitninja-mcp/dist/index.js"]
}
```
