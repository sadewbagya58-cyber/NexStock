import { spawn } from 'node:child_process';
import console from 'node:console';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

console.log('========================================================');
console.log(' Starting NexStock Full-Stack Local Development Preview');
console.log('========================================================\n');

// 1. Build all packages first to ensure latest dist output
console.log('[Dev Runner] Building all packages & apps...');
const buildProcess = spawn('corepack', ['pnpm', '-r', 'run', 'build'], {
  cwd: ROOT_DIR,
  stdio: 'inherit',
  shell: true,
});

buildProcess.on('exit', (code) => {
  if (code !== 0) {
    console.error(`[Dev Runner] Build failed with exit code ${code}. Aborting start.`);
    process.exit(code ?? 1);
  }

  console.log('\n[Dev Runner] Build succeeded. Starting API (port 4000) and Web UI (port 3000)...\n');

  // 2. Start API Server
  const apiProcess = spawn('node', ['apps/api/dist/src/server.js'], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    env: { ...process.env, PORT: '4000' },
    shell: true,
  });

  // 3. Start Web UI Server
  const webProcess = spawn('node', ['apps/web/dist/src/server.js'], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    env: { ...process.env, WEB_PORT: '3000' },
    shell: true,
  });

  const cleanup = () => {
    console.log('\n[Dev Runner] Shutting down servers...');
    apiProcess.kill();
    webProcess.kill();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
});
