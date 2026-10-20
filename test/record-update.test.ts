import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { parseRecord, endIncomplete } from '../src/shared/record';
import { RecordPublisher, applyRecordUpdate } from '../src/shared/record-update';

function fixture() { return parseRecord(fs.readFileSync('examples/mock.tltrace.json', 'utf8')); }

test('streamed metadata, stages, terminal states and logs reconstruct the complete record', () => {
  const record = fixture();
  const publisher = new RecordPublisher();
  const initial = publisher.next(record);
  assert.equal(initial.type, 'record');
  let received = structuredClone(record);
  const sync = () => {
    const message = structuredClone(publisher.next(record));
    assert.equal(message.type, 'record-update');
    if (message.type !== 'record-update') throw new Error('expected delta');
    received = applyRecordUpdate(received, message.update)!;
    assert.deepEqual(received, record);
    return message.update;
  };
  record.logs.push({ timestamp: new Date().toISOString(), stream: 'stdout', text: 'new log' });
  const logUpdate = sync();
  assert.equal(logUpdate.kernels.flatMap(kernel => kernel.stages).length, 0);
  assert.equal(logUpdate.logs.length, 1);
  assert.ok(!JSON.stringify(logUpdate).includes('beforeText'));
  const kernel = record.kernels[0];
  kernel.stages[0] = { ...kernel.stages[0], afterText: 'updated IR', status: 'running' };
  assert.equal(sync().kernels.flatMap(kernel => kernel.stages).length, 1);
  endIncomplete(record, 'cancelled');
  assert.equal(sync().kernels.flatMap(kernel => kernel.stages).length, 1);
  const added = { ...kernel.stages[0], id: 'new-stage', sequence: 10000, parentId: null, depth: 0 };
  kernel.stages.push(added);
  record.kernels.push({ id: 'new-kernel', name: 'main', symbol: 'main', status: 'running', cache: 'unknown', stages: [] });
  sync();
  assert.equal(publisher.next(structuredClone(record)).type, 'record', 'replacement records reset the baseline');
});

test('receiver rejects stale or missing baselines so the view can request a snapshot', () => {
  const record = fixture();
  const publisher = new RecordPublisher();
  publisher.reset(record);
  record.logs.push({ timestamp: new Date().toISOString(), stream: 'stdout', text: 'new log' });
  const message = publisher.next(record);
  if (message.type !== 'record-update') throw new Error('expected delta');
  assert.equal(applyRecordUpdate(null, message.update), null);
  assert.equal(applyRecordUpdate({ ...record, id: 'other' }, message.update), null);
  assert.equal(applyRecordUpdate(record, message.update), null, 'already applied log batch');
});


test('source loading resets the snapshot even when the record object is unchanged', () => {
  const record = fixture();
  const publisher = new RecordPublisher();
  publisher.reset(record);
  record.entry.source = '# source loaded after the first notification';
  assert.equal(publisher.next(record).type, 'record');
  assert.equal(publisher.next(record).type, 'record-update');
});
