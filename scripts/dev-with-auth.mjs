import { spawn } from 'node:child_process'

const npmExecPath = process.env.npm_execpath
const npm = npmExecPath ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm'
const children = []
let shuttingDown = false

function start(name, args) {
  const npmArgs = npmExecPath ? [npmExecPath, ...args] : args
  const child = spawn(npm, npmArgs, {
    stdio: 'inherit',
    env: process.env,
    shell: !npmExecPath && process.platform === 'win32',
    windowsHide: true,
  })
  children.push({ name, child })

  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    shuttingDown = true
    const reason = signal ? `${name} stopped by ${signal}` : `${name} exited with code ${code ?? 0}`
    console.log(`\n${reason}; stopping dev services...`)
    stopChildren(child)
    process.exit(code ?? 0)
  })

  return child
}

function stopChildren(except) {
  for (const { child } of children) {
    if (child === except || child.killed) continue
    child.kill()
  }
}

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  stopChildren()
}

process.on('SIGINT', () => {
  shutdown()
  process.exit(130)
})

process.on('SIGTERM', () => {
  shutdown()
  process.exit(143)
})

const viteArgs = process.argv.slice(2)

start('auth bridge', ['--prefix', 'server', 'run', 'dev'])
start('vite', viteArgs.length > 0 ? ['run', 'dev:frontend', '--', ...viteArgs] : ['run', 'dev:frontend'])
