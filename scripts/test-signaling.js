'use strict';
// Exercises the password-protected signaling layer on localhost:
// wrong password is rejected, right password joins, messages flow both ways.
const assert = require('assert');
const { SignalHost, SignalClient } = require('../lib/signaling');

const PORT = 47899;
const wait = (emitter, event) => new Promise((resolve) => emitter.once(event, resolve));

(async () => {
  const host = new SignalHost({ port: PORT, password: 'secret123', name: 'HostPC' });
  host.on('log', (l) => console.log('  host:', l));
  await host.start();

  console.log('1. wrong password');
  const bad = new SignalClient({ address: '127.0.0.1', port: PORT, password: 'nope', name: 'Intruder' });
  bad.on('log', (l) => console.log('  bad :', l));
  const badFail = wait(bad, 'auth-failed');
  const hostSawFail = wait(host, 'auth-failed');
  bad.start();
  const [f1, f2] = await Promise.all([badFail, hostSawFail]);
  assert.strictEqual(f1.why, 'wrong password');
  assert.strictEqual(f2.why, 'wrong password');
  assert.strictEqual(host.peers.size, 0);

  console.log('2. right password');
  const good = new SignalClient({ address: '127.0.0.1', port: PORT, password: 'secret123', name: 'Laptop' });
  good.on('log', (l) => console.log('  good:', l));
  const joined = wait(host, 'peer-joined');
  const connected = wait(good, 'connected');
  good.start();
  const [pj, c] = await Promise.all([joined, connected]);
  assert.strictEqual(pj.name, 'Laptop');
  assert.strictEqual(c.name, 'HostPC');
  assert.strictEqual(host.peers.size, 1);

  console.log('3. messages both ways');
  const toHost = wait(host, 'message');
  good.send({ t: 'sdp', description: { type: 'offer', sdp: 'v=0\r\n'.repeat(400) } });
  const m1 = await toHost;
  assert.strictEqual(m1.id, pj.id);
  assert.strictEqual(m1.msg.description.type, 'offer');
  const toClient = wait(good, 'message');
  host.send(pj.id, { t: 'ice', candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host' } });
  const m2 = await toClient;
  assert.strictEqual(m2.msg.t, 'ice');

  console.log('4. tampered envelope is dropped');
  const peer = host.peers.get(pj.id);
  const left = wait(host, 'peer-left');
  peer.ws.emit('message', Buffer.from(JSON.stringify({ t: 'e', iv: 'AAAAAAAAAAAAAAAA', d: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })));
  const l = await left;
  assert.strictEqual(l.id, pj.id);

  console.log('5. client retries after the host drops it, then stop');
  const reconnected = wait(host, 'peer-joined');
  await reconnected;
  good.stop();
  host.stop();
  console.log('all signaling checks passed');
  process.exit(0);
})().catch((err) => { console.error('FAILED:', err); process.exit(1); });
