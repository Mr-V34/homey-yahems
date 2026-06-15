#!/usr/bin/env node
'use strict';

// Aggregated self-test runner. Discovers every module in ../lib that exports a
// selfTest() function and runs it. selfTest() must return { pass: boolean, fails: string[] }.
// Exit code 0 = all green, 1 = any failure. This is the canonical TBV gate (`npm test`).

const fs = require('fs');
const path = require('path');

const libDir = path.join(__dirname, '..', 'lib');
let totalFails = 0;
let ran = 0;

const files = fs.existsSync(libDir)
  ? fs.readdirSync(libDir).filter((f) => f.endsWith('.js')).sort()
  : [];

for (const file of files) {
  let mod;
  try {
    mod = require(path.join(libDir, file));
  } catch (err) {
    console.error(`✗ ${file} — failed to load: ${err.message}`);
    totalFails++;
    continue;
  }
  if (typeof mod.selfTest !== 'function') continue;

  ran++;
  let result;
  try {
    result = mod.selfTest();
  } catch (err) {
    console.error(`✗ ${file}.selfTest() threw: ${err.message}`);
    totalFails++;
    continue;
  }

  const fails = (result && result.fails) || [];
  if (result && result.pass && fails.length === 0) {
    console.log(`✓ ${file} — PASS`);
  } else {
    console.error(`✗ ${file} — FAIL`);
    for (const f of fails) console.error(`    - ${f}`);
    totalFails += Math.max(1, fails.length);
  }
}

if (ran === 0) {
  console.error('No lib module exported selfTest() — nothing verified.');
  process.exit(1);
}

console.log(`\n${ran} module(s) tested, ${totalFails} failure(s).`);
process.exit(totalFails === 0 ? 0 : 1);
