// Smoke test: spawn the MCP server over stdio and exercise a few tools.
// Usage: node test-mcp.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));
const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
const pending = new Map();

child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const r = pending.get(msg.id);
    if (r) {
      pending.delete(msg.id);
      r(msg);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => process.stderr.write('[server] ' + c));

let id = 0;
function rpc(method, params, timeout = 30000) {
  const rid = ++id;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout: ' + method)), timeout);
    pending.set(rid, (m) => {
      clearTimeout(t);
      resolve(m);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n');
  });
}

const text = (m) => (m.result ? (m.result.content || []).map((c) => c.text).join('\n') : JSON.stringify(m.error));

await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'smoke-test', version: '0' },
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const tl = await rpc('tools/list', {});
console.log(`tools (${tl.result.tools.length}): ` + tl.result.tools.map((t) => t.name).join(', '));

const status = await rpc('tools/call', { name: 'clash_status', arguments: {} });
console.log('\n--- clash_status ---\n' + text(status));

const traffic = await rpc('tools/call', { name: 'clash_traffic', arguments: { duration_ms: 1500 } });
console.log('\n--- clash_traffic ---\n' + text(traffic));

child.stdin.end();
await new Promise((r) => child.on('exit', r));
