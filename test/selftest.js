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

// =============================================================================
// BUILD-TIME GUARD: single-chokepoint invariant for HomeyAPI device writes
// =============================================================================
// Structural check: the HomeyAPI form `devices.setCapabilityValue` (which writes
// to a DOWNSTREAM device, not the controller's own capability) must appear ONLY
// inside the `_write(` method body in drivers/controller/device.js. If it appears
// anywhere else, a future caller bypassed the safety chokepoint — that is a
// structural bug, not just a style issue. This test fails the build if found.
//
// Own-capability writes use `this.setCapabilityValue(...)` (no `devices.` prefix)
// and are NOT checked — those are not actuation.
// =============================================================================
{
  ran++; // count this as a test module
  const deviceFile = path.join(__dirname, '..', 'drivers', 'controller', 'device.js');
  let guardPass = true;
  const guardFails = [];

  let src;
  try {
    src = fs.readFileSync(deviceFile, 'utf8');
  } catch (e) {
    console.error(`✗ chokepoint-guard — could not read device.js: ${e.message}`);
    totalFails++;
    guardPass = false;
  }

  if (src) {
    const TARGET = 'devices.setCapabilityValue';

    // Strip comments from source before scanning, so occurrences in JSDoc / line
    // comments do not trigger false positives. We blank them out character-for-
    // character to preserve original byte offsets for line-number reporting.
    //
    // Handles: /* ... */ block comments (including /** JSDoc */) and // line comments.
    // String literals are not parsed (we trust the author not to hide calls in strings).
    function stripComments(s) {
      const out = s.split('');
      let i = 0;
      while (i < out.length) {
        // Block comment
        if (out[i] === '/' && out[i + 1] === '*') {
          out[i] = ' '; out[i + 1] = ' ';
          i += 2;
          while (i < out.length) {
            if (out[i] === '*' && out[i + 1] === '/') {
              out[i] = ' '; out[i + 1] = ' ';
              i += 2;
              break;
            }
            if (out[i] !== '\n') out[i] = ' ';
            i++;
          }
        // Line comment
        } else if (out[i] === '/' && out[i + 1] === '/') {
          while (i < out.length && out[i] !== '\n') {
            out[i] = ' ';
            i++;
          }
        } else {
          i++;
        }
      }
      return out.join('');
    }

    const stripped = stripComments(src);

    // Find all positions of the target string in comment-stripped source.
    const occurrences = [];
    let pos = 0;
    while ((pos = stripped.indexOf(TARGET, pos)) !== -1) {
      occurrences.push(pos);
      pos += TARGET.length;
    }

    if (occurrences.length === 0) {
      // No code-level occurrences — acceptable (method body defined but call not
      // yet made; the _write() skeleton is present, guard is satisfied).
    } else {
      // Find the extent of the `_write(` method body in stripped source.
      // Strategy: locate `async _write(`, then walk forward to find its matching
      // closing brace. All occurrences of TARGET must fall within that range.
      const WRITE_SIG = 'async _write(';
      const writeStart = stripped.indexOf(WRITE_SIG);
      let writeBodyEnd = -1;

      if (writeStart === -1) {
        guardFails.push(
          `devices.setCapabilityValue found ${occurrences.length} time(s) in code but _write() method not found in device.js`,
        );
        guardPass = false;
      } else {
        // Walk from writeStart to find the opening brace, then match it.
        let braceDepth = 0;
        let foundOpen = false;
        for (let i = writeStart; i < stripped.length; i++) {
          if (stripped[i] === '{') {
            braceDepth++;
            foundOpen = true;
          } else if (stripped[i] === '}') {
            braceDepth--;
            if (foundOpen && braceDepth === 0) {
              writeBodyEnd = i;
              break;
            }
          }
        }

        if (writeBodyEnd === -1) {
          guardFails.push('_write() method body extent could not be determined (unbalanced braces?)');
          guardPass = false;
        } else {
          // Verify every code occurrence of TARGET is within [writeStart, writeBodyEnd].
          for (const occ of occurrences) {
            if (occ < writeStart || occ > writeBodyEnd) {
              const lineNo = src.slice(0, occ).split('\n').length;
              guardFails.push(
                `devices.setCapabilityValue at line ~${lineNo} is OUTSIDE _write() — single-chokepoint violated`,
              );
              guardPass = false;
            }
          }
        }
      }
    }

    if (guardPass && guardFails.length === 0) {
      console.log('✓ chokepoint-guard — PASS (devices.setCapabilityValue confined to _write)');
    } else {
      console.error('✗ chokepoint-guard — FAIL');
      for (const f of guardFails) console.error(`    - ${f}`);
      totalFails += Math.max(1, guardFails.length);
    }
  }
}

console.log(`\n${ran} module(s) tested, ${totalFails} failure(s).`);
process.exit(totalFails === 0 ? 0 : 1);
