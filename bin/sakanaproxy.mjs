#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const entry = join(__dirname, '..', 'src', 'index.ts')

const args = process.argv.slice(2)
const child = spawn('npx', ['tsx', entry, ...args], {
  stdio: 'inherit',
  env: process.env,
})

child.on('exit', code => process.exit(code ?? 0))
