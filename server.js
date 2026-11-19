const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');

const ROOT = __dirname;
const VM_DIR = path.join(ROOT, 'vms');
const VM_FILE = path.join(ROOT, 'vms.json');
fs.mkdirSync(VM_DIR, { recursive: true });

function findBin(name) {
  try {
    const cmd = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim().split(/\r?\n/)[0];
    if (out && fs.existsSync(out)) return out;
  } catch (e) {}
  if (process.platform === 'win32') {
    const cands = [
      'C:\\Program Files\\qemu\\' + name + '.exe',
      'C:\\Program Files\\qemu\\' + name,
    ];
    for (const c of cands) if (fs.existsSync(c)) return c;
  }
  return name;
}

const QEMU = findBin('qemu-system-x86_64');
const QEMU_IMG = findBin('qemu-img');

function accel() {
  if (process.platform === 'linux') {
    try { fs.accessSync('/dev/kvm'); return 'kvm'; } catch (e) { return 'tcg'; }
  }
  if (process.platform === 'win32') {
    try {
      execSync(`"${QEMU}" -accel whpx -machine none -nographic`, { timeout: 5000, stdio: 'ignore' });
      return 'whpx';
    } catch (e) {
      return 'tcg';
    }
  }
  return 'tcg';
}
const ACCEL = accel();

let gpuName = '';
let gpuAvailable = false;
try {
  const cmd = process.platform === 'win32'
    ? 'powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"'
    : "lspci | grep -i vga";
  const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
  const names = out.split(/\r?\n/).map(s=>s.trim()).filter(Boolean).filter(s=>!/^Name$/i.test(s));
  const real = names.filter(n => !/Microsoft|Basic|Remote|Meta|Virtual|Generic|Parsec/i.test(n));
  if (real.length) { gpuName = real[0]; gpuAvailable = true; }
} catch (e) {}
function detectSpecs() {
  const cpus = os.cpus();
  return {
    cpuName: cpus.length ? cpus[0].model.trim() : 'Unknown CPU',
    maxVcpu: cpus.length || 1,
    maxRamGB: Math.floor(os.totalmem() / (1024 ** 3)),
    gpuName,
    gpuAvailable,
  };
}
const SPECS = detectSpecs();

function loadVms() {
  try { return JSON.parse(fs.readFileSync(VM_FILE, 'utf8')); } catch (e) { return []; }
}
function saveVms() {
  fs.writeFileSync(VM_FILE, JSON.stringify(vms, null, 2));
}
let vms = loadVms();
// reset stale pids
vms.forEach(v => { v.status = 'stopped'; v.pid = null; });
saveVms();

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

function allocatePort() {
  const used = new Set(vms.map(v=>v.sshPort));
  let p = 2222;
  while (used.has(p)) p++;
  return p;
}

function clamp(v, max) { return Math.min(v, max); }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url);
    return;
  }
  // static
  let filePath = path.join(ROOT, decodeURIComponent(url.pathname));
  if (filePath.endsWith(path.sep)) filePath += 'index.html';
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) filePath = path.join(ROOT, 'index.html');
    fs.readFile(filePath, (e, data) => {
      if (e) { res.writeHead(404); res.end('Not found'); return; }
      const ext = path.extname(filePath).toLowerCase();
      const mime = {'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8'};
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
});

function handleApi(req, res, url) {
  const json = (o, code=200) => { res.writeHead(code, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(o)); };

  if (url.pathname === '/api/health') return json({ ok:true, host: os.hostname(), port: server.address().port, specs: SPECS, qemu: QEMU, accel: ACCEL });
  if (url.pathname === '/api/specs') return json(SPECS);

  if (url.pathname === '/api/vms' && req.method === 'GET') {
    // refresh statuses
    vms.forEach(v => { if (v.status === 'running' && !isAlive(v.pid)) { v.status = 'stopped'; v.pid = null; } });
    saveVms();
    return json(vms);
  }

  const m = url.pathname.match(/^\/api\/vms\/([^/]+)(\/(start|stop|console))?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const action = m[3];
    const vm = vms.find(v => v.id === id);
    if (!vm) return json({ error: 'not found' }, 404);

    if (!action && req.method === 'DELETE') {
      if (vm.status === 'running') return json({ error: 'stop first' }, 400);
      vms = vms.filter(v => v.id !== id);
      saveVms();
      try { fs.rmSync(path.join(VM_DIR, id), { recursive: true, force: true }); } catch (e) {}
      return json({ ok: true });
    }

    if (action === 'start' && req.method === 'POST') {
      if (vm.status === 'running' && isAlive(vm.pid)) return json({ error: 'already running' }, 400);
      const args = [
        '-name', vm.name,
        '-m', String(vm.ram),
        '-smp', String(vm.cpu),
        '-drive', `file=${vm.disk},format=qcow2,if=virtio`,
        '-netdev', `user,id=net0,hostfwd=tcp::${vm.sshPort}-:22`,
        '-device', 'virtio-net-pci,netdev=net0',
        '-accel', ACCEL,
        '-display', 'none',
        '-serial', `file:${vm.logFile}`,
      ];
      if (vm.iso) args.push('-cdrom', vm.iso, '-boot', 'd');
      if (vm.cidata && !vm.iso) args.push('-cdrom', vm.cidata);
      else if (vm.cidata) args.push('-drive', `file=${vm.cidata},media=cdrom,format=raw`);
      if (vm.backingImage && /uefi/i.test(vm.backingImage)) {
        args.push('-bios', 'C:\\\\Program Files\\\\qemu\\\\share\\\\edk2-x86_64-code.fd');
      }
      try {
        const proc = spawn(QEMU, args, { detached: true, stdio: 'ignore' });
        proc.unref();
        vm.pid = proc.pid;
        vm.status = 'running';
        vm.startedAt = new Date().toISOString();
        saveVms();
        return json(vm);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if (action === 'stop' && req.method === 'POST') {
      if (vm.pid) {
        try {
          if (process.platform === 'win32') {
            execSync(`taskkill /PID ${vm.pid} /T /F`, { stdio: 'ignore' });
          } else {
            process.kill(-vm.pid, 'SIGTERM');
          }
        } catch (e) {}
      }
      vm.status = 'stopped';
      vm.pid = null;
      saveVms();
      return json(vm);
    }

    if (action === 'console' && req.method === 'GET') {
      try {
        const data = fs.readFileSync(vm.logFile, 'utf8');
        const lines = data.split(/\r?\n/).slice(-40);
        return json({ lines });
      } catch (e) {
        return json({ lines: [] });
      }
    }
  }

  if (url.pathname === '/api/vms' && req.method === 'POST') {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      try {
        const b = JSON.parse(data || '{}');
        const name = (b.name || 'vm').replace(/[^a-zA-Z0-9_-]/g, '');
        let ram = parseInt(b.ram, 10) || 1024;
        let cpu = parseInt(b.cpu, 10) || 1;
        const diskGB = parseInt(b.diskGB, 10) || 8;
        ram = clamp(ram, 4096);
        cpu = clamp(cpu, 4);
        const id = 'vm-' + Date.now();
        const dir = path.join(VM_DIR, id);
        fs.mkdirSync(dir, { recursive: true });
        const disk = path.join(dir, 'disk.qcow2');
        let iso = b.iso || null;
        let cidata = null;
        const isImage = iso && /\.(qcow2|img|raw|vmdk)$/i.test(iso);
        if (isImage) {
          // overlay on top of backing image (instant boot, keeps base clean)
          execSync(`"${QEMU_IMG}" create -f qcow2 -b "${iso}" -F qcow2 "${disk}"`, { stdio: 'ignore' });
          // generate cidata ISO for cloud-init
          cidata = path.join(dir, 'cidata.iso');
          try {
            execSync(`python "${path.join(ROOT, 'make-cidata.py')}" "${cidata}" "${name || 'vm'}"`, { stdio: 'ignore' });
          } catch (e) { cidata = null; }
          iso = null;
        } else {
          execSync(`"${QEMU_IMG}" create -f qcow2 "${disk}" ${diskGB}G`, { stdio: 'ignore' });
        }
        const vm = {
          id, name: name || 'vm', ram, cpu, diskGB, disk,
          iso: iso,
          cidata: cidata,
          backingImage: isImage ? (b.iso || null) : null,
          status: 'stopped', pid: null,
          sshPort: allocatePort(),
          createdAt: new Date().toISOString(),
          logFile: path.join(dir, 'console.log'),
        };
        vms.push(vm);
        saveVms();
        json(vm);
      } catch (e) {
        json({ error: e.message }, 500);
      }
    });
    return;
  }

  json({ error: 'not found' }, 404);
}

const PORTS = [8080, 8090, 8765, 9000, 9090, 3000, 5000, 7000, 4000];
function tryListen(i) {
  if (i >= PORTS.length) {
    server.once('error', (e) => { console.error(e); process.exit(1); });
    server.listen(0, () => done(server.address().port));
    return;
  }
  const p = PORTS[i];
  const onErr = (e) => {
    if (e.code === 'EADDRINUSE') {
      server.removeListener('listening', onListen);
      server.removeListener('error', onErr);
      tryListen(i + 1);
    } else {
      console.error(e); process.exit(1);
    }
  };
  const onListen = () => {
    server.removeListener('error', onErr);
    done(p);
  };
  server.once('listening', onListen);
  server.once('error', onErr);
  server.listen(p);
}
function done(port) {
  try { fs.writeFileSync(path.join(ROOT, 'port.txt'), String(port)); } catch (e) {}
  console.log('');
  console.log('  InstaBox Local server running');
  console.log('  Local:   http://localhost:' + port);
  console.log('  Specs:   ' + JSON.stringify(SPECS));
  console.log('  QEMU:    ' + QEMU);
  console.log('  Accel:   ' + ACCEL);
  console.log('');
  console.log('  Remote API:');
  console.log('    GET  /api/health  /api/specs  /api/vms');
  console.log('    POST /api/vms  {name,ram,cpu,diskGB,iso}');
  console.log('    POST /api/vms/:id/start|stop');
  console.log('    DELETE /api/vms/:id');
  console.log('');
}
function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) for (const n of nets[name]) if (n.family === 'IPv4' && !n.internal) return n.address;
  return null;
}

tryListen(0);
server.on('error', (e) => { console.error(e); process.exit(1); });
