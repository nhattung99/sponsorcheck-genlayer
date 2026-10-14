import { parseGenToWei, formatWeiToGen, sanitizeGenInput, readWei } from '../money.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function runUnitConversionTests() {
  console.log('Starting precision unit conversion tests...');

  const smallestWei = parseGenToWei('0.000000000000000001');
  assert(smallestWei === 1n, `smallest wei expected 1n, got ${smallestWei}`);
  assert(formatWeiToGen(1n) === '0.000000000000000001', `smallest format got ${formatWeiToGen(1n)}`);

  const pointOneWei = parseGenToWei('0.1');
  assert(pointOneWei === 100000000000000000n, `0.1 wei got ${pointOneWei}`);
  assert(formatWeiToGen(100000000000000000n) === '0.1', '0.1 format');

  const millionWei = parseGenToWei('1000000');
  assert(millionWei === 1000000000000000000000000n, `million got ${millionWei}`);
  assert(formatWeiToGen(1000000000000000000000000n) === '1000000', 'million format');

  const testValues = ['1', '0.5', '100.25', '0.000001', '30000'];
  for (const val of testValues) {
    const wei = parseGenToWei(val);
    const formatted = formatWeiToGen(wei);
    assert(formatted === val, `round-trip failed for ${val}: got ${formatted}`);
  }

  assert(parseGenToWei('') === 0n, 'empty should be 0n');
  assert(parseGenToWei('abc') === 0n, 'invalid should be 0n');
  assert(parseGenToWei('1.2.3') === 0n, 'extra dot should be 0n');
  assert(formatWeiToGen(0n) === '0', 'zero format');
  assert(formatWeiToGen('1000000000000000000') === '1', 'string wei formats exactly');
  assert(sanitizeGenInput('12.3abc4') === '12.34', 'sanitize strips letters');
  assert(readWei('1000') === 1000n, 'digit string wei');
  assert(readWei(1.5) === 0n, 'js number is refused');
  assert(readWei(1000n) === 1000n, 'bigint passthrough');

  console.log('All precision unit conversion tests passed.');
}

runUnitConversionTests();
