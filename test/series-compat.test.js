import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCanonical } from '../src/canonical.js';
import { buildNeodbNdjson } from '../src/targets/neodb-ndjson.js';
import { buildNeodb } from '../src/targets/neodb.js';
import { buildLetterboxd } from '../src/targets/letterboxd.js';
import { buildGoodreads } from '../src/targets/goodreads.js';
import { FIXTURE } from './helpers.js';
test('canonical 1.4 optional series cannot add ratings, records or change any platform export',()=>{
  const before=loadCanonical(FIXTURE), after=loadCanonical(FIXTURE);
  for(const records of Object.values(after)) if(Array.isArray(records)) for(const record of records) record.canonical_version='canonical/1.4';
  for(const subject of after.subjects) for(const revision of subject.revisions) revision.fields.series={
    kind:'douban_same_series',source:'embedded_config',scope:'unknown',claimed_total:2,
    items:[{medium:'movie',id:'99999999',title:'Related work, never a personal rating'}],future:{extra:true}};
  for(const build of [buildNeodbNdjson,buildNeodb,buildLetterboxd,buildGoodreads]) assert.deepEqual(build(after),build(before),build.name);
});
