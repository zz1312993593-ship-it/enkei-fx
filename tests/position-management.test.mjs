import assert from 'node:assert/strict'; import test from 'node:test'; import { decidePositionManagement } from './.build/position-management.js';
const p=(action_bias,confidence=75,market_regime='trend')=>({action_bias,confidence,market_regime});
test('single opposite signal is a pullback',()=>assert.equal(decidePositionManagement(p('short'),null,['long']).action,'hold'));
test('confirmed structural reversal exits',()=>assert.equal(decidePositionManagement(p('short'),p('short',65),['long']).action,'close-all'));
test('range reversal is not mechanical exit',()=>assert.equal(decidePositionManagement(p('short',90,'range'),p('short',90,'range'),['long']).classification,'pullback'));
test('explicit confident exit closes',()=>assert.equal(decidePositionManagement(p('close',70),null,['long']).classification,'explicit-exit'));
