// SCRUM-67 / SI-03: HFU list (ÖGK) by UID only. On the list -> VALID,
// not on the list -> NOT_FOUND ("not on the HFU list"), service down -> UNAVAILABLE.
//
// The answers copy the format of the AGH web service 3.0. The UIDs are the
// published test data of the ÖGK test system (agh-ws-tt), not real companies.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRequest, createHfuAdapter, normaliseUid, parseResponse, viennaDate } from '../src/adapters/hfu.js';

// DI-04: the real endpoint is configuration, so the tests use a made-up one.
const env = { HFU_URL: 'https://hfu.test/DienstgeberAbfrageWS_3_0', HFU_REQUESTER_UID: 'ATU12345678' };
const NOW = () => new Date('2026-11-16T12:00:00Z');

function answer({ dg = 'N', epu = 'N', extra = '' } = {}) {
  return `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
<ns3:dienstgeberAbfragenResponse xmlns:ns2="AGHExternWS_3_0.extern_3_0.ws.agh.noegkk.sozvers.at" xmlns:ns3="http://AGHExternWS_3_0.extern_3_0.ws.agh.noegkk.sozvers.at/">
<auftragnehmerRS>${extra}<hfuListeDgJN>${dg}</hfuListeDgJN><hfuListeEpuJN>${epu}</hfuListeEpuJN></auftragnehmerRS>
</ns3:dienstgeberAbfragenResponse></soap:Body></soap:Envelope>`;
}

const FAULT = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
<soap:Fault><faultcode>soap:Client</faultcode><faultstring>The given SOAPAction x does not match an operation.</faultstring></soap:Fault>
</soap:Body></soap:Envelope>`;

// A fetch that answers with `body` and records every request it gets.
function fakeHfu(body, status = 200) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(body, { status, headers: { 'Content-Type': 'text/xml' } });
  };
  return { fetch, calls, now: NOW };
}

test('normaliseUid accepts Austrian UIDs only and ignores spaces, dots and dashes', () => {
  assert.equal(normaliseUid('ATU12345676'), 'ATU12345676');
  assert.equal(normaliseUid('atu 1234.56-76'), 'ATU12345676');
  assert.equal(normaliseUid('DE123456789'), null);
  assert.equal(normaliseUid('ATU1234567'), null);
  assert.equal(normaliseUid(''), null);
  assert.equal(normaliseUid(null), null);
});

test('the Stichtag is the date in Vienna, not in UTC', () => {
  assert.equal(viennaDate(new Date('2026-11-16T12:00:00Z')), '2026-11-16');
  assert.equal(viennaDate(new Date('2026-11-16T23:30:00Z')), '2026-11-17');
});

test('the request asks by UID, names the requester and has the qualified operation', () => {
  const xml = buildRequest({ requesterUid: 'ATU12345678', partnerUid: 'ATU12345676', stichtag: '2026-11-16' });
  assert.match(xml, /xmlns:agh="http:\/\/AGHExternWS_3_0\.extern_3_0\.ws\.agh\.noegkk\.sozvers\.at\/"/);
  assert.match(xml, /<agh:dienstgeberAbfragen>/);
  assert.match(xml, /<uidAuftraggeber>ATU12345678<\/uidAuftraggeber>/);
  assert.match(xml, /<stichtag>2026-11-16<\/stichtag>/);
  assert.match(xml, /<auftragnehmerRQ><uidAuftragnehmer>ATU12345676<\/uidAuftragnehmer><\/auftragnehmerRQ>/);
  assert.doesNotMatch(xml, /dgnrAuftragnehmer|vsnrAuftragnehmer/);
});

test('a company on the list as employer is VALID, with the data the service knows', async () => {
  const hfu = fakeHfu(
    answer({
      dg: 'J',
      extra:
        '<auftragnehmerHauptanschrift>3100 St. Pölten, Rathausplatz 6</auftragnehmerHauptanschrift>' +
        '<auftragnehmerName>Muster Bau &amp; Söhne GmbH</auftragnehmerName><firmenbuchnummer>123456d</firmenbuchnummer>' +
        '<uid>ATU12345676</uid>',
    }),
  );
  const result = await createHfuAdapter(env, hfu).check({ vat: 'ATU 1234 5676', fn: null });

  assert.deepEqual(result, {
    state: 'VALID',
    details: {
      uid: 'ATU12345676',
      stichtag: '2026-11-16',
      name: 'Muster Bau & Söhne GmbH',
      address: '3100 St. Pölten, Rathausplatz 6',
      fn: '123456d',
      note: null,
      listedAs: 'EMPLOYER',
    },
  });
  assert.equal(hfu.calls.length, 1);
  assert.equal(hfu.calls[0].url, env.HFU_URL);
  assert.equal(hfu.calls[0].init.method, 'POST');
  assert.match(hfu.calls[0].init.body, /<uidAuftragnehmer>ATU12345676<\/uidAuftragnehmer>/);
});

test('a one-person company on the list (EPU) is VALID too', async () => {
  const result = await createHfuAdapter(env, fakeHfu(answer({ epu: 'J' }))).check({ vat: 'ATU12345675' });
  assert.equal(result.state, 'VALID');
  assert.equal(result.details.listedAs, 'SOLE_TRADER');
});

test('a company not on the list is NOT_FOUND with the note "not on the HFU list"', async () => {
  const result = await createHfuAdapter(env, fakeHfu(answer())).check({ vat: 'ATU12345678' });
  assert.equal(result.state, 'NOT_FOUND');
  assert.equal(result.details.reason, 'not on the HFU list');
  assert.equal(result.details.uid, 'ATU12345678');
});

test('a non-Austrian UID is NOT_APPLICABLE without calling the service', async () => {
  const hfu = fakeHfu(answer());
  const result = await createHfuAdapter(env, hfu).check({ vat: 'DE123456789' });
  assert.equal(result.state, 'NOT_APPLICABLE');
  assert.match(result.details.reason, /only contains Austrian UIDs/);
  assert.equal(hfu.calls.length, 0);
});

test('no SOAPAction header is sent', async () => {
  const hfu = fakeHfu(answer());
  await createHfuAdapter(env, hfu).check({ vat: 'ATU12345678' });
  const headers = new Headers(hfu.calls[0].init.headers);
  assert.equal(headers.has('SOAPAction'), false);
  assert.match(headers.get('Content-Type'), /^text\/xml/);
});

test('missing configuration, HTTP errors, SOAP faults and unknown answers are thrown (UNAVAILABLE)', async () => {
  await assert.rejects(createHfuAdapter({}, fakeHfu(answer())).check({ vat: 'ATU12345678' }), /HFU_URL/);
  await assert.rejects(
    createHfuAdapter({ HFU_URL: env.HFU_URL }, fakeHfu(answer())).check({ vat: 'ATU12345678' }),
    /HFU_REQUESTER_UID/,
  );
  await assert.rejects(createHfuAdapter(env, fakeHfu('<html>down</html>', 503)).check({ vat: 'ATU12345678' }), /HTTP 503/);
  await assert.rejects(createHfuAdapter(env, fakeHfu(FAULT, 500)).check({ vat: 'ATU12345678' }), /does not match an operation/);
  await assert.rejects(createHfuAdapter(env, fakeHfu(answer({ dg: '?' }))).check({ vat: 'ATU12345678' }), /unexpected flags/);
  await assert.rejects(createHfuAdapter(env, fakeHfu('<soap:Envelope/>')).check({ vat: 'ATU12345678' }), /no auftragnehmerRS/);
});

test('parseResponse reads prefixed elements as well', () => {
  const result = parseResponse('<x:auftragnehmerRS><x:hfuListeDgJN>N</x:hfuListeDgJN><x:hfuListeEpuJN>J</x:hfuListeEpuJN></x:auftragnehmerRS>');
  assert.equal(result.onListAsSoleTrader, true);
  assert.equal(result.onListAsEmployer, false);
});

// Real answer of the ÖGK test system (agh-ws-tt) for ATU12345676, Stichtag 2014-07-15,
// recorded on 16 Nov 2026 with the unprefixed request that buildRequest sends.
const RECORDED = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns3:dienstgeberAbfragenResponse xmlns:ns2="AGHExternWS_3_0.extern_3_0.ws.agh.noegkk.sozvers.at" xmlns:ns3="http://AGHExternWS_3_0.extern_3_0.ws.agh.noegkk.sozvers.at/"><auftragnehmerRS><dgnrAuftragnehmer>123456788</dgnrAuftragnehmer><auftragnehmerHauptanschrift>3100 St. Pölten, Rathausplatz 7</auftragnehmerHauptanschrift><auftragnehmerName>Muster DG-Unternehmen 2</auftragnehmerName><firmenbuchnummer>123456c</firmenbuchnummer><uid>ATU12345676</uid><hfuListeDgJN>J</hfuListeDgJN><hfuListeEpuJN>N</hfuListeEpuJN></auftragnehmerRS></ns3:dienstgeberAbfragenResponse></soap:Body></soap:Envelope>`;

test('the recorded answer of the ÖGK test system is read as on the list as employer', () => {
  assert.deepEqual(parseResponse(RECORDED), {
    onListAsEmployer: true,
    onListAsSoleTrader: false,
    name: 'Muster DG-Unternehmen 2',
    address: '3100 St. Pölten, Rathausplatz 7',
    fn: '123456c',
    note: null,
  });
});
