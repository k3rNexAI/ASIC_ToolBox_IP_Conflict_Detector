import assert from 'node:assert/strict';
import { analyzeIpObservations, normalizeMac, serialNumberOf } from '../ip-conflicts.js';

assert.equal(normalizeMac('AA-BB-CC-DD-EE-FF'), 'aa:bb:cc:dd:ee:ff');
assert.equal(normalizeMac('invalid'), '');
assert.equal(serialNumberOf({ serial_number: ' SN-01 ' }), 'SN-01');

const distinctSerials = analyzeIpObservations([
  {
    ip: '10.0.0.7',
    online: true,
    identity: { serialNumber: 'SN-01', model: 'S19' },
    mac: '00:11:22:33:44:55',
  },
  {
    ip: '10.0.0.7',
    online: true,
    identity: { serialNumber: 'SN-02', model: 'S19' },
    mac: '00:11:22:33:44:55',
  },
]);
assert.equal(distinctSerials[0].status, 'confirmed');
assert.equal(distinctSerials[0].serialNumbers.length, 2);

const differentMacs = analyzeIpObservations([
  {
    ip: '10.0.0.8',
    online: true,
    identity: { model: 'S19', version: '26.08' },
    mac: '00:11:22:33:44:55',
  },
  {
    ip: '10.0.0.8',
    online: true,
    identity: { model: 'S19', version: '26.08' },
    mac: '00:11:22:33:44:66',
  },
]);
assert.equal(differentMacs[0].status, 'confirmed');

const differentHardware = analyzeIpObservations([
  {
    ip: '10.0.0.9',
    online: true,
    identity: { model: 'S19', version: '26.08', boardModel: 'BM1362' },
  },
  {
    ip: '10.0.0.9',
    online: true,
    identity: { model: 'S21', version: '26.09', boardModel: 'BM1370' },
  },
]);
assert.equal(differentHardware[0].status, 'possible');

const sameDevice = analyzeIpObservations([
  {
    ip: '10.0.0.10',
    online: true,
    identity: { serialNumber: 'SN-03', model: 'S19' },
    mac: '00:11:22:33:44:77',
  },
  {
    ip: '10.0.0.10',
    online: true,
    identity: { serialNumber: 'SN-03', model: 'S19' },
    mac: '00:11:22:33:44:77',
  },
]);
assert.equal(sameDevice[0].status, 'clear');

const offlineIgnored = analyzeIpObservations([
  { ip: '10.0.0.11', online: false, identity: { serialNumber: '—' } },
  { ip: '10.0.0.11', online: true, identity: { serialNumber: 'SN-04', model: 'S19' } },
]);
assert.equal(offlineIgnored[0].status, 'clear');
console.log('IP conflict detector tests passed.');
