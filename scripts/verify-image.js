#!/usr/bin/env node
/**
 * Judge a photo from the command line.
 *
 *   node scripts/verify-image.js path/to/photo.jpg
 *   node scripts/verify-image.js photo.jpg --task leaf-two-fingers
 *   node scripts/verify-image.js photo.jpg --json
 *
 * This is the Phase 1 harness: it exercises the whole verification path with
 * no extension, no phone and no server, so the model's judgment can be
 * checked on its own.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { judgeStaged } from '../server/gemma.js';
import { TASKS, pickTask } from '../server/tasks.js';

const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1] ?? true;
}

const wantJson = args.includes('--json');
const files = args.filter((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--task');

if (args.includes('--list-tasks')) {
  for (const t of TASKS) console.log(`${t.id.padEnd(22)} ${t.text}`);
  process.exit(0);
}

if (files.length === 0) {
  console.error(`Judge a photo with Gemma, locally.

Usage:
  node scripts/verify-image.js <image...> [--task <id>] [--json]
  node scripts/verify-image.js --list-tasks

Options:
  --task <id>   Use a specific task (default: random)
  --json        Print the raw verdict as JSON
`);
  process.exit(1);
}

const taskId = flag('task');
const task = taskId
  ? TASKS.find((t) => t.id === taskId) ?? (console.error(`Unknown task: ${taskId}`), process.exit(1))
  : pickTask();

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { dim: '', red: '', green: '', yellow: '', bold: '', off: '' };

let anyFailed = false;

for (const file of files) {
  let buf;
  try {
    buf = await readFile(file);
  } catch (err) {
    console.error(`${C.red}Cannot read ${file}${C.off}: ${err.message}`);
    anyFailed = true;
    continue;
  }

  if (!wantJson) {
    console.log(`\n${C.bold}${basename(file)}${C.off} ${C.dim}(${(buf.length / 1024).toFixed(0)} KB)${C.off}`);
    console.log(`${C.dim}task:${C.off} ${task.text}`);
    process.stdout.write(`${C.dim}judging...${C.off}`);
  }

  const started = Date.now();
  const v = await judgeStaged({
    imageB64: buf.toString('base64'),
    task,
    onProgress: wantJson ? undefined : (stage) => {
      process.stdout.write(`\r\x1b[K${C.dim}checking ${stage}...${C.off}`);
    },
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (wantJson) {
    console.log(JSON.stringify({ file, task: task.id, elapsedSec: Number(elapsed), ...v }, null, 2));
  } else {
    process.stdout.write('\r\x1b[K');
    const badge = v.ok ? `${C.green}PASS${C.off}` : `${C.red}FAIL${C.off}`;
    console.log(`${badge} ${C.dim}${elapsed}s${C.off}${v.stage && !v.ok ? ` ${C.dim}(failed at: ${v.stage})${C.off}` : ''}`);
    console.log(`  outdoor=${mark(v.outdoor)} glass=${mark(!v.through_glass)} screen=${mark(!v.screen_photo)} task=${mark(v.task_done)}`);
    console.log(`  ${C.dim}${v.reason}${C.off}`);
  }

  if (!v.ok) anyFailed = true;
}

function mark(good) {
  return good ? `${C.green}y${C.off}` : `${C.yellow}n${C.off}`;
}

process.exit(anyFailed ? 2 : 0);
