#!/usr/bin/env node
// Runs Vitest from a working directory spelt the way the disk spells it.
//
// On Windows, Vitest collects no tests at all - every file fails with "Cannot read
// properties of undefined (reading 'config')" - when it is started from a path whose
// drive letter is lowercase. It matches modules to the project by comparing path strings,
// and "d:\Code" is not "D:\Code". VS Code's terminal starts in "d:\..." as often as not,
// so without this `npm test` passes or fails depending on which window it was typed into.
// (It cost this project three unexplained all-red runs before it was pinned down.)
//
// Fixing the directory inside this process is not enough: by the time this file runs, its
// own URL - and so everything it imports - already carries the wrong spelling. So Vitest
// gets a fresh process in which every path agrees from the start.
//
// Arguments pass straight through:  npm test -- tests/rf.test.ts

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

const root = realpathSync.native(process.cwd());
const passed = process.argv.slice(2);
// `vitest` alone would start the watcher; `npm test` means run once and report.
const args = passed.some((a) => !a.startsWith('-')) ? passed : ['run', ...passed];

const result = spawnSync(process.execPath, [join(root, 'node_modules', 'vitest', 'vitest.mjs'), ...args], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
