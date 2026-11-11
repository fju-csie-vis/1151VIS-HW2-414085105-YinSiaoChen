const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const d3 = require('../dist/vendor/d3.v7.min.js');
const M = require('../dist/data-model.js');
const csv = fs.readFileSync(path.join(__dirname,'../dist/data/aqi-2025.csv'),'utf8').replace(/^\uFEFF/,'');
const rows = M.normalizeRows(d3.csvParse(csv));
const ids = ['15','24','31','42','56','63'];


test('missing markers are not coerced into zero; actual zero remains valid',()=>{
  for(const value of ['', '  ', null, undefined, 'NaN', '-1', 'invalid']) assert.equal(M.numberOrNull(value),null);
  assert.equal(M.numberOrNull('0'),0);assert.equal(M.numberOrNull('52'),52);
});

test('complete six-station daily grid preserves the official missing date',()=>{
  assert.equal(rows.length,2190);
  assert.equal(new Set(rows.map(d=>`${d.siteId}/${d.date}`)).size,2190);
  assert.equal(rows.filter(d=>Number.isFinite(d.aqi)).length,2184);
  const missing=rows.filter(d=>d.aqi===null);
  assert.equal(missing.length,6);
  assert.deepEqual([...new Set(missing.map(d=>d.date))],['2025-02-02']);
  for(const id of ids){const r=rows.filter(d=>d.siteId===id);assert.equal(r.length,365);assert.equal(r[0].date,'2025-01-01');assert.equal(r.at(-1).date,'2025-12-31');}
});

test('annual summaries match independently verified official records',()=>{
  const s=M.summarize(rows,M.dateMs('2025-01-01'),M.dateMs('2025-12-31'),ids);
  assert.equal(s.days,365);assert.equal(s.valid,2184);assert.equal(s.expected,2190);assert.equal(s.above,146);
  assert.equal(s.ratio,146/2184);
  assert.deepEqual(s.stations.map(d=>d.median),[55,52,54,61,64,38]);
  assert.deepEqual(s.stations.map(d=>d.above),[17,20,18,44,42,5]);
});

test('a range with only missing data reports unknown ratios, not a misleading 0%',()=>{
  const day=M.dateMs('2025-02-02'),s=M.summarize(rows,day,day,ids);
  assert.equal(s.days,1);assert.equal(s.valid,0);assert.equal(s.coverage,0);assert.equal(s.ratio,null);
  for(const station of s.stations){assert.equal(station.median,null);assert.equal(station.ratio,null);assert.equal(station.missing,1);}
});

test('one-day ranges include the date and preserve the documented 2025-04-29 event',()=>{
  const day=M.dateMs('2025-04-29'),s=M.summarize(rows,day,day,ids);
  assert.deepEqual(s.stations.map(d=>d.median),[52,129,90,164,166,93]);
  assert.equal(s.valid,6);assert.equal(s.above,3);assert.equal(s.ratio,.5);
  const selected=M.summarize(rows,day,day,['56','63']);
  assert.equal(selected.valid,2);assert.deepEqual(selected.stations.map(d=>d.median),[166,93]);
});

test('normalization rejects duplicate keys and impossible dates',()=>{
  const row={date:'2025-04-29',siteId:'56',siteName:'前金',aqi:'166'};
  assert.throws(()=>M.normalizeRows([row,row]),/重複/);
  assert.throws(()=>M.normalizeRows([{...row,date:'2025-02-31'}]),/日期/);
});
