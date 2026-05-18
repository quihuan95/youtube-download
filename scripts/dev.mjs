import { spawn } from 'node:child_process';

const isWin = process.platform === 'win32';

function run(cmd, args, label) {
  const child = spawn(cmd, args, {
    stdio: 'inherit',
    shell: isWin,
    env: process.env,
  });
  child.on('exit', (code) => {
    if (code && code !== 0) console.error(`[dev] ${label} thoát với mã ${code}`);
  });
  return child;
}

console.log('[dev] Khởi động server + Tailwind...\n');

const css = run('npx', ['tailwindcss', '-i', './src/input.css', '-o', './public/styles.css', '--watch'], 'CSS');
const api = run('node', ['server.js'], 'API');

function shutdown() {
  css.kill('SIGTERM');
  api.kill('SIGTERM');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

api.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    console.error('\n[dev] Server dừng — kiểm tra cổng 3008: npm run stop');
    css.kill('SIGTERM');
    process.exit(code);
  }
});
