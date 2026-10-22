#!/usr/bin/env node
/**
 * Clash-Verge-MCP
 * Clash Verge Rev / mihomo 的零依赖 MCP 服务器（stdio）。
 *
 * 原理：新版 Clash Verge Rev 默认不开放 TCP external-controller，
 * 而是把 mihomo 的 REST API 挂在 Windows 命名管道上（Verge 自己也是这么连内核的）。
 * 本服务用 Node 内置 http 的 socketPath 直连该管道，不开端口、不改 Verge 配置。
 *
 * 用法：
 *   node server.mjs            # 以 MCP stdio 服务运行
 *   node server.mjs --check    # 自检：打印发现结果与内核版本后退出
 *
 * 环境变量（一般不需要）：
 *   CLASH_VERGE_DIR   指定 Clash Verge 数据目录
 *   CLASH_PIPE        指定命名管道，如 \\.\pipe\verge-mihomo
 *   CLASH_SECRET      指定 secret
 *   CLASH_USE_TCP=1   改用 TCP external-controller
 *   CLASH_CONTROLLER  TCP 地址 host:port
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const SERVER_NAME = 'clash-verge';
const SERVER_VERSION = '1.0.0';
const log = (...a) => process.stderr.write('[clash-mcp] ' + a.join(' ') + '\n');

/* ------------------------------------------------------------------ *
 * 发现 Clash Verge Rev 数据目录 / 控制器通道 / secret
 * ------------------------------------------------------------------ */

const state = {
  dir: null,
  channel: null, // 'pipe' | 'tcp'
  pipe: null,
  host: '127.0.0.1',
  port: 9097,
  secret: '',
};

function candidateDirs() {
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return [
    process.env.CLASH_VERGE_DIR,
    path.join(roaming, 'io.github.clash-verge-rev.clash-verge-rev'),
    path.join(roaming, 'clash-verge-rev'),
    path.join(roaming, 'clash-verge'),
    path.join(local, 'io.github.clash-verge-rev.clash-verge-rev'),
    path.join(os.homedir(), '.config', 'clash-verge'),
  ].filter(Boolean);
}

/** 从极简 YAML 文本里取顶层键值 */
function yamlValue(text, key) {
  const m = text.match(new RegExp('^' + key + '\\s*:\\s*(.*)$', 'm'));
  if (!m) return null;
  let v = m[1].trim();
  if (v === '') return '';
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    v = v.slice(1, -1);
  }
  return v;
}

function findDataDir() {
  for (const d of candidateDirs()) {
    try {
      if (fs.existsSync(path.join(d, 'clash-verge.yaml')) || fs.existsSync(path.join(d, 'config.yaml'))) {
        return d;
      }
    } catch { /* ignore */ }
  }
  return null;
}

/** 枚举 \\.\pipe\ 下与 mihomo / verge 相关的管道名 */
function listMihomoPipes() {
  try {
    return fs
      .readdirSync('\\\\.\\pipe\\')
      .filter((n) => /^verge-mihomo/i.test(n) || /^mihomo/i.test(n) || /^clash/i.test(n))
      .map((n) => '\\\\.\\pipe\\' + n);
  } catch {
    return [];
  }
}

function readVergeFiles(dir) {
  const out = { pipe: null, secret: null, controller: null };
  for (const name of ['clash-verge.yaml', 'config.yaml']) {
    if (!dir) break;
    const p = path.join(dir, name);
    let txt;
    try {
      txt = fs.readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    if (out.pipe == null) {
      const v = yamlValue(txt, 'external-controller-pipe');
      if (v) out.pipe = v;
    }
    if (out.secret == null) {
      const v = yamlValue(txt, 'secret');
      if (v != null) out.secret = v;
    }
    if (out.controller == null) {
      const v = yamlValue(txt, 'external-controller');
      if (v) out.controller = v;
    }
    if (out.pipe && out.secret != null && out.controller != null) break;
  }
  return out;
}

async function rawRequest(opts) {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null;
        try {
          json = buf ? JSON.parse(buf) : null;
        } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, body: buf, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(opts.timeout || 15000, () => {
      req.destroy(new Error('timeout'));
    });
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function buildOpts(method, apiPath, body, timeout) {
  const headers = { Host: 'localhost', Connection: 'close' };
  if (state.secret) headers['Authorization'] = 'Bearer ' + state.secret;
  let payload;
  if (body !== undefined && body !== null) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  const opts = { method, path: apiPath, headers, timeout: timeout || 15000 };
  if (state.channel === 'pipe') opts.socketPath = state.pipe;
  else {
    opts.host = state.host;
    opts.port = state.port;
  }
  if (payload !== undefined) opts.body = payload;
  return opts;
}

/** 探测一个候选通道是否可用 */
async function probeChannel(channel, target, secret) {
  const headers = { Host: 'localhost', Connection: 'close' };
  if (secret) headers['Authorization'] = 'Bearer ' + secret;
  const opts = { method: 'GET', path: '/version', headers, timeout: 4000 };
  if (channel === 'pipe') opts.socketPath = target;
  else {
    const [h, p] = target.split(':');
    opts.host = h;
    opts.port = Number(p);
  }
  try {
    const r = await rawRequest(opts);
    return r.status === 200;
  } catch {
    return false;
  }
}

async function discover(force = false) {
  if (state.channel && !force) return state;

  const dir = findDataDir();
  const files = readVergeFiles(dir);
  const secret = process.env.CLASH_SECRET ?? files.secret ?? '';

  // 1) 显式指定 TCP
  if (process.env.CLASH_USE_TCP === '1' || process.env.CLASH_CONTROLLER) {
    const target = process.env.CLASH_CONTROLLER || files.controller || '127.0.0.1:9097';
    const [h, p] = target.split(':');
    Object.assign(state, { dir, channel: 'tcp', host: h, port: Number(p), secret });
    if (await probeChannel('tcp', target, secret)) return state;
    throw new Error(`TCP 控制器不可用：${target}`);
  }

  // 2) 显式指定管道
  const pipeCandidates = [];
  if (process.env.CLASH_PIPE) pipeCandidates.push(process.env.CLASH_PIPE);
  if (files.pipe) pipeCandidates.push(files.pipe);
  // 枚举活管道优先（配置里的名字可能带 build 通道，与实际运行的不一致）
  const live = listMihomoPipes();
  live.sort((a, b) => {
    const score = (s) => (/production/i.test(s) ? 0 : /release/i.test(s) ? 1 : 2);
    return score(a) - score(b);
  });
  for (const p of live) if (!pipeCandidates.includes(p)) pipeCandidates.push(p);

  for (const pipe of pipeCandidates) {
    if (await probeChannel('pipe', pipe, secret)) {
      Object.assign(state, { dir, channel: 'pipe', pipe, secret });
      return state;
    }
  }

  // 3) 退回到 TCP 配置
  if (files.controller) {
    const [h, p] = files.controller.split(':');
    if (await probeChannel('tcp', files.controller, secret)) {
      Object.assign(state, { dir, channel: 'tcp', host: h, port: Number(p), secret });
      return state;
    }
  }

  throw new Error(
    '找不到可用的 mihomo 控制器。请确认 Clash Verge Rev 正在运行；' +
      '若已停止，请先启动。可用 CLASH_PIPE / CLASH_CONTROLLER 手动指定。'
  );
}

/** 带一次重连重试的 API 调用 */
async function api(method, apiPath, body, timeoutMs) {
  await discover();
  try {
    return await rawRequest(buildOpts(method, apiPath, body, timeoutMs));
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ECONNREFUSED' || e.code === 'EPIPE')) {
      await discover(true); // 内核重启后管道名可能变化
      return await rawRequest(buildOpts(method, apiPath, body, timeoutMs));
    }
    throw e;
  }
}

/** 读取 Verge 自身状态（TUN / 系统代理 / 当前订阅） */
function vergeSnapshot() {
  const dir = state.dir || findDataDir();
  const snap = { tun: null, sysproxy: null, mixedPort: null, profile: null };
  if (!dir) return snap;
  try {
    const v = fs.readFileSync(path.join(dir, 'verge.yaml'), 'utf8');
    const tun = yamlValue(v, 'enable_tun_mode');
    const sys = yamlValue(v, 'enable_system_proxy');
    const mp = yamlValue(v, 'verge_mixed_port');
    snap.tun = tun === 'true';
    snap.sysproxy = sys === 'true';
    snap.mixedPort = mp ? Number(mp) : null;
  } catch { /* ignore */ }
  try {
    const p = fs.readFileSync(path.join(dir, 'profiles.yaml'), 'utf8');
    const cur = yamlValue(p, 'current');
    if (cur) {
      const blocks = p.split(/^- uid:/m).slice(1);
      for (const b of blocks) {
        const uid = b.split('\n')[0].trim();
        if (uid === cur) {
          const nm = b.match(/^\s*name:\s*(.+)$/m);
          snap.profile = nm ? nm[1].trim().replace(/^['"]|['"]$/g, '') : cur;
          break;
        }
      }
      if (!snap.profile) snap.profile = cur;
    }
  } catch { /* ignore */ }
  return snap;
}

/* ------------------------------------------------------------------ *
 * 工具实现
 * ------------------------------------------------------------------ */

const enc = encodeURIComponent;

async function toolStatus() {
  const st = await discover(true);
  const ver = await api('GET', '/version');
  const cfg = await api('GET', '/configs');
  const proxies = await api('GET', '/proxies');
  const snap = vergeSnapshot();

  const v = ver.json || {};
  const c = cfg.json || {};
  const px = (proxies.json && proxies.json.proxies) || {};
  const groups = Object.values(px).filter((p) => p.all);
  const nodes = Object.values(px).filter((p) => !p.all);

  const lines = [
    `内核：${v.version || '未知'}${v.meta ? '（mihomo）' : ''}`,
    `模式：${c.mode || '未知'}   混合端口：${c['mixed-port'] ?? snap.mixedPort ?? '未知'}`,
    `控制器：${
      st.channel === 'pipe' ? `命名管道 ${st.pipe}` : `TCP ${st.host}:${st.port}`
    }`,
    `策略组：${groups.length} 个   节点：${nodes.length} 个`,
  ];
  if (snap.tun !== null) lines.push(`TUN 模式：${snap.tun ? '开启' : '关闭'}`);
  if (snap.sysproxy !== null) lines.push(`系统代理：${snap.sysproxy ? '开启' : '关闭'}`);
  if (snap.profile) lines.push(`当前订阅：${snap.profile}`);
  if (c['allow-lan'] !== undefined) lines.push(`局域网代理：${c['allow-lan'] ? '允许' : '禁止'}`);
  return lines.join('\n');
}

async function toolProxies({ group, include_all_nodes } = {}) {
  const r = await api('GET', '/proxies');
  const px = (r.json && r.json.proxies) || {};
  const groups = Object.values(px).filter((p) => Array.isArray(p.all));

  if (group) {
    const g = px[group];
    if (!g) {
      const hit = groups.find((x) => x.name.toLowerCase() === String(group).toLowerCase());
      if (!hit) throw new Error(`找不到策略组：${group}`);
      group = hit.name;
    }
    const gd = px[group];
    const lines = [`策略组：${gd.name}`, `类型：${gd.type}`, `当前选择：${gd.now || '(无)'}`, ``, `成员：`];
    for (const n of gd.all) {
      const d = px[n];
      const hist = d && d.history && d.history.length ? d.history[d.history.length - 1] : null;
      const delay = hist ? (hist.delay > 0 ? `${hist.delay}ms` : '超时') : '-';
      lines.push(`  ${n === gd.now ? '▶' : ' '} ${n}  [${(d && d.type) || '?'}]  ${delay}`);
    }
    return lines.join('\n');
  }

  const lines = [`共 ${groups.length} 个策略组：`];
  for (const g of groups) {
    const delay = g.history && g.history.length ? g.history[g.history.length - 1].delay : null;
    lines.push(
      `  ${g.name}  [${g.type}]  当前：${g.now || '(无)'}  成员 ${g.all.length} 个` +
        (delay != null ? `  ${delay > 0 ? delay + 'ms' : '超时'}` : '')
    );
  }
  if (include_all_nodes) {
    const nodes = Object.values(px).filter((p) => !Array.isArray(p.all));
    lines.push('', `全部节点（${nodes.length}）：`);
    for (const n of nodes) {
      const hist = n.history && n.history.length ? n.history[n.history.length - 1] : null;
      lines.push(`  ${n.name}  [${n.type}]` + (hist ? `  ${hist.delay > 0 ? hist.delay + 'ms' : '超时'}` : ''));
    }
  }
  return lines.join('\n');
}

async function toolSelect({ group, node }) {
  if (!group || !node) throw new Error('需要同时提供 group 与 node');
  const r = await api('PUT', `/proxies/${enc(group)}`, { name: node });
  if (r.status === 204 || r.status === 200) {
    return `已切换：${group} → ${node}`;
  }
  throw new Error(`切换失败（HTTP ${r.status}）：${r.body || ''}${pickMessage(r.json)}`);
}

function pickMessage(json) {
  if (json && typeof json === 'object' && json.message) return ' ' + json.message;
  return '';
}

async function toolDelay({ name, group, url, timeout } = {}) {
  const q = new URLSearchParams();
  q.set('url', url || 'http://www.gstatic.com/generate_204');
  q.set('timeout', String(timeout || 5000));

  if (group) {
    const r = await api('GET', `/group/${enc(group)}/delay?${q.toString()}`, undefined, (timeout || 5000) + 8000);
    if (r.status !== 200) throw new Error(`测速失败（HTTP ${r.status}）：${r.body || ''}`);
    // mihomo 的整组测速返回 { "节点名": 毫秒 } 或 { "节点名": { delay } }，失败时是 { message }
    const map = r.json || {};
    const delayOf = (v) => {
      if (typeof v === 'number') return v > 0 ? v : null;
      if (v && typeof v.delay === 'number') return v.delay > 0 ? v.delay : null;
      return null;
    };
    const rows = Object.entries(map).sort((a, b) => (delayOf(a[1]) ?? 1e9) - (delayOf(b[1]) ?? 1e9));
    const lines = [`策略组 ${group} 延迟（${url || 'gstatic/generate_204'}）：`];
    for (const [n, v] of rows) {
      const d = delayOf(v);
      const failMsg = v && typeof v === 'object' && v.message ? ' ' + v.message : '';
      lines.push(`  ${n}: ${d != null ? d + 'ms' : '超时' + failMsg}`);
    }
    return lines.join('\n');
  }

  if (!name) throw new Error('需要 name 或 group');
  const r = await api('GET', `/proxies/${enc(name)}/delay?${q.toString()}`, undefined, (timeout || 5000) + 8000);
  if (r.status !== 200) throw new Error(`测速失败（HTTP ${r.status}）：${r.body || ''}`);
  const d = r.json && r.json.delay;
  return `${name}: ${typeof d === 'number' && d > 0 ? d + 'ms' : '超时/不可用'}`;
}

async function toolMode({ mode } = {}) {
  if (!mode) {
    const r = await api('GET', '/configs');
    return `当前模式：${(r.json && r.json.mode) || '未知'}`;
  }
  const m = String(mode).toLowerCase();
  if (!['rule', 'global', 'direct'].includes(m)) throw new Error('mode 只能是 rule / global / direct');
  const r = await api('PATCH', '/configs', { mode: m });
  if (r.status === 204 || r.status === 200) return `已切换代理模式：${m}`;
  throw new Error(`切换失败（HTTP ${r.status}）：${r.body || ''}${pickMessage(r.json)}`);
}

async function toolConfigs({ patch } = {}) {
  if (!patch) {
    const r = await api('GET', '/configs');
    return JSON.stringify(r.json, null, 2);
  }
  const r = await api('PATCH', '/configs', patch);
  if (r.status === 204 || r.status === 200) return `已更新配置：${JSON.stringify(patch)}`;
  throw new Error(`更新失败（HTTP ${r.status}）：${r.body || ''}${pickMessage(r.json)}`);
}

async function toolConnections({ limit } = {}) {
  const r = await api('GET', '/connections');
  const data = r.json || {};
  const list = data.connections || [];
  const max = Math.min(Number(limit) || 20, 200);
  const lines = [
    `活动连接：${list.length} 条（下行累计 ${fmtBytes(data.downloadTotal)}，上行累计 ${fmtBytes(data.uploadTotal)}）`,
  ];
  for (const c of list.slice(0, max)) {
    const meta = c.metadata || {};
    lines.push(
      `  ${c.id.slice(0, 8)}  ${meta.host || meta.destinationIP || '?'}${meta.destinationPort ? ':' + meta.destinationPort : ''}` +
        `  → ${c.chains ? c.chains.join(' ← ') : '?'}  ${fmtBytes(c.download)} / ${fmtBytes(c.upload)}` +
        `  ${meta.network || ''}`
    );
  }
  if (list.length > max) lines.push(`  … 其余 ${list.length - max} 条已省略`);
  return lines.join('\n');
}

function fmtBytes(n) {
  if (!n) return '0B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return v.toFixed(v >= 100 ? 0 : 1) + u[i];
}

async function toolCloseConnections({ id } = {}) {
  if (id) {
    const r = await api('DELETE', `/connections/${enc(id)}`);
    if (r.status === 204 || r.status === 200) return `已断开连接 ${id}`;
    throw new Error(`断开失败（HTTP ${r.status}）：${r.body || ''}`);
  }
  const r = await api('DELETE', '/connections');
  if (r.status === 204 || r.status === 200) return '已断开全部活动连接';
  throw new Error(`断开失败（HTTP ${r.status}）：${r.body || ''}`);
}

async function toolRules({ keyword } = {}) {
  const r = await api('GET', '/rules');
  const rules = (r.json && r.json.rules) || [];
  const kw = keyword ? String(keyword).toLowerCase() : null;
  const hit = kw
    ? rules.filter(
        (x) =>
          String(x.payload || '').toLowerCase().includes(kw) ||
          String(x.proxy || '').toLowerCase().includes(kw) ||
          String(x.type || '').toLowerCase().includes(kw)
      )
    : rules;
  const lines = [`规则总数 ${rules.length}${kw ? `，匹配 "${keyword}" 的 ${hit.length} 条` : ''}：`];
  for (const x of hit.slice(0, 120)) {
    lines.push(`  [${x.type}] ${x.payload}${x.size ? ' (' + x.size + ')' : ''} → ${x.proxy}`);
  }
  if (hit.length > 120) lines.push(`  … 其余 ${hit.length - 120} 条已省略`);
  return lines.join('\n');
}

async function toolProviders({ action, name, kind } = {}) {
  const act = action || 'list';
  const base = kind === 'rule' ? '/providers/rules' : '/providers/proxies';

  if (act === 'list') {
    const r = await api('GET', base);
    const provs = (r.json && r.json.providers) || {};
    const lines = [`${kind === 'rule' ? '规则' : '代理'}提供者 ${Object.keys(provs).length} 个：`];
    for (const p of Object.values(provs)) {
      const si = p.subscriptionInfo || {};
      const used = Number(si.Upload || 0) + Number(si.Download || 0);
      const total = Number(si.Total || 0);
      lines.push(
        `  ${p.name}  [${p.vehicleType || p.type}]  节点 ${(p.proxies || []).length}` +
          (total ? `  流量 ${fmtBytes(used)}/${fmtBytes(total)}` : '') +
          (si.Expire ? `  到期 ${new Date(Number(si.Expire) * 1000).toLocaleDateString('zh-CN')}` : '')
      );
    }
    return lines.join('\n');
  }

  if (!name) throw new Error('需要提供 name');
  if (act === 'update') {
    const r = await api('PUT', `${base}/${enc(name)}`);
    if (r.status === 204 || r.status === 200) return `已触发更新：${name}`;
    throw new Error(`更新失败（HTTP ${r.status}）：${r.body || ''}${pickMessage(r.json)}`);
  }
  if (act === 'healthcheck') {
    const r = await api('GET', `${base}/${enc(name)}/healthcheck`, undefined, 30000);
    if (r.status === 204 || r.status === 200) return `已触发健康检查：${name}`;
    throw new Error(`健康检查失败（HTTP ${r.status}）：${r.body || ''}${pickMessage(r.json)}`);
  }
  throw new Error('action 只能是 list / update / healthcheck');
}

/** 采样流式接口（/traffic、/logs）一段时间 */
function sampleStream(apiPath, durationMs) {
  return new Promise((resolve, reject) => {
    const opts = buildOpts('GET', apiPath, undefined, durationMs + 3000);
    const lines = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        req.destroy();
      } catch { /* ignore */ }
      resolve(lines);
    };
    const req = http.request(opts, (res) => {
      if (res.statusCode !== 200) {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${b}`)));
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try {
            lines.push(JSON.parse(line));
          } catch {
            lines.push(line);
          }
        }
      });
    });
    req.on('error', (e) => {
      if (!settled) reject(e);
    });
    req.end();
    setTimeout(finish, durationMs);
  });
}

async function toolTraffic({ duration_ms } = {}) {
  await discover();
  const ms = Math.min(Math.max(Number(duration_ms) || 2000, 500), 8000);
  const samples = await sampleStream('/traffic', ms);
  const snaps = samples.filter((s) => s && typeof s.down === 'number');
  if (!snaps.length) return `在 ${ms}ms 内没有采集到流量数据`;
  const avgDown = snaps.reduce((a, s) => a + s.down, 0) / snaps.length;
  const avgUp = snaps.reduce((a, s) => a + s.up, 0) / snaps.length;
  return [
    `采样 ${ms}ms，共 ${snaps.length} 个点：`,
    `  下行：${fmtBytes(avgDown)}/s（峰值 ${fmtBytes(Math.max(...snaps.map((s) => s.down)))}/s）`,
    `  上行：${fmtBytes(avgUp)}/s（峰值 ${fmtBytes(Math.max(...snaps.map((s) => s.up)))}/s）`,
  ].join('\n');
}

async function toolLogs({ level, duration_ms } = {}) {
  await discover();
  const ms = Math.min(Math.max(Number(duration_ms) || 2000, 500), 8000);
  const p = level ? `/logs?level=${enc(level)}` : '/logs';
  const samples = await sampleStream(p, ms);
  if (!samples.length) return `在 ${ms}ms 内没有新的日志`;
  return samples
    .slice(-80)
    .map((s) => (typeof s === 'string' ? s : `[${s.type || 'info'}] ${s.payload || JSON.stringify(s)}`))
    .join('\n');
}

async function toolFakeipFlush() {
  const r = await api('POST', '/cache/fakeip/flush');
  if (r.status === 204 || r.status === 200) return '已清空 fake-ip 缓存';
  throw new Error(`清空失败（HTTP ${r.status}）：${r.body || ''}`);
}

async function toolRaw({ method, path: apiPath, body }) {
  if (!method || !apiPath) throw new Error('需要 method 与 path');
  const r = await api(String(method).toUpperCase(), apiPath, body);
  const head = `HTTP ${r.status}`;
  return r.json ? `${head}\n${JSON.stringify(r.json, null, 2)}` : `${head}\n${r.body}`;
}

/* ------------------------------------------------------------------ *
 * MCP 协议层
 * ------------------------------------------------------------------ */

const TOOLS = [
  {
    name: 'clash_status',
    description: '查看 Clash Verge Rev / mihomo 运行状态：内核版本、代理模式、控制器通道、TUN 与系统代理开关、当前订阅。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'clash_proxies',
    description: '列出策略组；传 group 时列出该组的成员节点与当前选择，传 include_all_nodes 时附带全部节点。',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '策略组名称（可选）' },
        include_all_nodes: { type: 'boolean', description: '是否附带全部节点列表' },
      },
    },
  },
  {
    name: 'clash_select',
    description: '切换某个策略组当前使用的节点。',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '策略组名称' },
        node: { type: 'string', description: '目标节点名称' },
      },
      required: ['group', 'node'],
    },
  },
  {
    name: 'clash_delay',
    description: '测试节点或整个策略组的延迟，结果按延迟升序。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '单个节点名称' },
        group: { type: 'string', description: '策略组名称（测整组）' },
        url: { type: 'string', description: '测速 URL，默认 gstatic/generate_204' },
        timeout: { type: 'number', description: '超时毫秒，默认 5000' },
      },
    },
  },
  {
    name: 'clash_mode',
    description: '查看或切换代理模式（rule / global / direct）。',
    inputSchema: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['rule', 'global', 'direct'], description: '目标模式' } },
    },
  },
  {
    name: 'clash_configs',
    description: '读取 mihomo 运行配置；传 patch 则按字段更新（如 allow-lan、ipv6 等）。',
    inputSchema: {
      type: 'object',
      properties: { patch: { type: 'object', description: '要更新的配置字段' } },
    },
  },
  {
    name: 'clash_connections',
    description: '查看当前活动连接及累计流量。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '最多显示条数，默认 20' } },
    },
  },
  {
    name: 'clash_close_connections',
    description: '断开指定连接；不传 id 时断开全部连接。',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: '连接 id（前 8 位即可）' } } },
  },
  {
    name: 'clash_rules',
    description: '查看路由规则，可按关键字过滤。',
    inputSchema: { type: 'object', properties: { keyword: { type: 'string', description: '过滤关键字' } } },
  },
  {
    name: 'clash_providers',
    description: '订阅/规则提供者：list 列表、update 更新订阅、healthcheck 健康检查。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'update', 'healthcheck'], description: '操作' },
        name: { type: 'string', description: '提供者名称' },
        kind: { type: 'string', enum: ['proxy', 'rule'], description: '代理或规则提供者，默认 proxy' },
      },
    },
  },
  {
    name: 'clash_traffic',
    description: '采样实时上下行速率。',
    inputSchema: {
      type: 'object',
      properties: { duration_ms: { type: 'number', description: '采样时长毫秒，默认 2000' } },
    },
  },
  {
    name: 'clash_logs',
    description: '采集一段内核实时日志。',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', description: '日志级别过滤' },
        duration_ms: { type: 'number', description: '采样时长毫秒，默认 2000' },
      },
    },
  },
  {
    name: 'clash_fakeip_flush',
    description: '清空 fake-ip DNS 缓存。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'clash_request',
    description: '逃生舱：直接请求任意 mihomo 控制器端点（如 GET /memory）。',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'HTTP 方法' },
        path: { type: 'string', description: '端点路径，如 /configs' },
        body: { type: 'object', description: '请求体（可选）' },
      },
      required: ['method', 'path'],
    },
  },
];

const HANDLERS = {
  clash_status: toolStatus,
  clash_proxies: toolProxies,
  clash_select: toolSelect,
  clash_delay: toolDelay,
  clash_mode: toolMode,
  clash_configs: toolConfigs,
  clash_connections: toolConnections,
  clash_close_connections: toolCloseConnections,
  clash_rules: toolRules,
  clash_providers: toolProviders,
  clash_traffic: toolTraffic,
  clash_logs: toolLogs,
  clash_fakeip_flush: toolFakeipFlush,
  clash_request: toolRaw,
};

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function processMessage(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  try {
    if (method === 'initialize') {
      const pv = (params && params.protocolVersion) || '2024-11-05';
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: pv,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      });
      return;
    }
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'notifications/cancelled') return;
    if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }
    if (method === 'tools/call') {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const fn = HANDLERS[name];
      if (!fn) {
        send({ jsonrpc: '2.0', id, error: { code: -32602, message: '未知工具：' + name } });
        return;
      }
      try {
        const text = await fn(args);
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: String(text) }], isError: false },
        });
      } catch (e) {
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: '错误：' + (e && e.message ? e.message : String(e)) }], isError: true },
        });
      }
      return;
    }
    if (isNotification) return;
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: '不支持的方法：' + method } });
  } catch (e) {
    if (!isNotification) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: e && e.message ? e.message : String(e) } });
    }
  }
}

function runMcp() {
  let buf = '';
  let queue = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log('无法解析的输入行，已忽略');
        continue;
      }
      queue = queue.then(() => processMessage(msg)).catch((e) => log('处理失败：' + e.message));
    }
  });
  process.stdin.on('end', () => process.exit(0));
  log(`${SERVER_NAME} v${SERVER_VERSION} 已启动（stdio）`);
}

async function check() {
  try {
    const st = await discover(true);
    const ver = await api('GET', '/version');
    console.log('[clash-mcp] 数据目录：' + st.dir);
    console.log('[clash-mcp] 通道：' + (st.channel === 'pipe' ? st.pipe : `${st.host}:${st.port}`));
    console.log('[clash-mcp] 内核：' + JSON.stringify(ver.json));
    console.log('[clash-mcp] 状态：\n' + (await toolStatus()));
    process.exit(0);
  } catch (e) {
    console.error('[clash-mcp] 自检失败：' + e.message);
    process.exit(1);
  }
}

if (process.argv.includes('--check')) {
  await check();
} else {
  runMcp();
}
