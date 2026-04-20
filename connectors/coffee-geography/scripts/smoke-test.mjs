#!/usr/bin/env node
/**
 * Smoke test for Coffee Geography MCP server
 * Exercises both tools via stdio JSON-RPC
 */

import { spawn } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';

function jsonRpc(method, params = {}) {
  return JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 9999), method, params }) + "\n";
}

const tests = [
  { name: "Brazil", call: ["check_coffee_production", { country: "Brazil" }], expect: /yes/i },
  { name: "France", call: ["check_coffee_production", { country: "France" }], expect: /no/i },
  { name: "Côte d'Ivoire", call: ["check_coffee_production", { country: "Côte d'Ivoire" }], expect: /yes/i },
  { name: "Ivory Coast", call: ["check_coffee_production", { country: "Ivory Coast" }], expect: /yes/i },
  { name: "Timor-Leste", call: ["check_coffee_production", { country: "Timor-Leste" }], expect: /yes/i },
  { name: "DRC", call: ["check_coffee_production", { country: "DRC" }], expect: /yes/i },
  { name: "Japan", call: ["check_coffee_production", { country: "Japan" }], expect: /no/i },
  { name: "Myanmar", call: ["check_coffee_production", { country: "Myanmar" }], expect: /yes/i },
  { name: "UK", call: ["check_coffee_production", { country: "UK" }], expect: /no/i },
  { name: "list_coffee_countries", call: ["list_coffee_countries", {}], expect: /brazil.*vietnam.*colombia/is },
];

async function run() {
  const proc = spawn("node", ["dist/index.js"], {
    cwd: "/Users/harry/mcp-servers/coffee-geography-mcp",
    stdio: ["pipe", "pipe", "pipe"],
  });

  let output = "";
  proc.stdout.on("data", (d) => { output += d.toString(); });
  proc.stderr.on("data", (d) => { console.log("[server stderr]", d.toString()); });

  await sleep(200);

  let passed = 0;
  for (const t of tests) {
    const id = Math.floor(Math.random() * 99999);
    output = ""; // reset for this call
    proc.stdin.write(jsonRpc("tools/call", { name: t.call[0], arguments: t.call[1] }) + "\n");

    // Wait for response
    let result = "";
    for (let i = 0; i < 40; i++) {
      await sleep(50);
      const lines = output.trim().split("\n").filter(Boolean);
      const last = lines[lines.length - 1] || "";
      try {
        const p = JSON.parse(last);
        if (p.id === id || (p.result && p.result.content)) {
          result = p.result?.content?.[0]?.text || "(empty)";
          break;
        }
      } catch { /* not json yet */ }
    }

    const ok = t.expect.test(result);
    console.log(`${ok ? "✅" : "❌"} ${t.name}\n   → ${result.replace(/\n/g, " ").slice(0, 100)}`);
    if (ok) passed++;
  }

  console.log(`\n${passed}/${tests.length} passed`);
  proc.kill();
  process.exit(passed === tests.length ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
