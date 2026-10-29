// Dev runner: starts Vite, waits for it, then starts Electron with
// ELECTRON_RENDERER_URL pointing at it. Kill this process and both
// children go with it.
const { spawn } = require('node:child_process');
const http = require('node:http');

const root = require('node:path').join(__dirname, '..');
let vite = null;
let electron = null;

function stop() {
  if (electron) electron.kill();
  if (vite) vite.kill();
}

process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });

vite = spawn('npx', ['vite', '--port', '5173', '--strictPort'], { cwd: root, stdio: 'inherit' });

function waitForVite(tries) {
  if (tries <= 0) {
    console.error('Vite did not start in time');
    stop();
    process.exit(1);
  }
  const req = http.get('http://localhost:5173/', (res) => {
    res.resume();
    startElectron();
  });
  req.on('error', () => setTimeout(() => waitForVite(tries - 1), 500));
}

function startElectron() {
  // This VM runs as root, and Electron refuses root without --no-sandbox.
  // On a normal user account (e.g. the user's Mac) the flag is omitted.
  const args = ['electron', '.'];
  if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  electron = spawn('npx', args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RENDERER_URL: 'http://localhost:5173/' },
  });
  electron.on('exit', () => { stop(); process.exit(0); });
}

waitForVite(60);
