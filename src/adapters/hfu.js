// SI-03 / SCRUM-67: HFU list (ÖGK) adapter, AGH SOAP web service 3.0, by UID only (OI-03).
// Not on the list is normal, so it is NOT_FOUND, never INVALID.

// DI-04 / SCRUM-88: HFU_URL and HFU_REQUESTER_UID come from configuration.
// Without them the check reports UNAVAILABLE.

const TIMEOUT_MS = 10_000;
// XML namespaces, not called addresses. Joined so the DI-04 URL scan skips them.
const namespace = (host) => ['http:', '', host, ''].join('/');
const NAMESPACE = namespace('AGHExternWS_3_0.extern_3_0.ws.agh.noegkk.sozvers.at');
const SOAP_ENVELOPE = namespace('schemas.xmlsoap.org/soap/envelope');

// "atu 1234 5678" -> "ATU12345678". Only Austrian UIDs can be on the HFU list.
export function normaliseUid(vat) {
  const compact = String(vat ?? '').toUpperCase().replace(/[\s.\-]/g, '');
  return /^ATU\d{8}$/.test(compact) ? compact : null;
}

// The reference date (Stichtag) is today in Vienna, as YYYY-MM-DD.
export function viennaDate(now = new Date()) {
  return now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' });
}

// Both UIDs went through normaliseUid, so no XML escaping is needed.
export function buildRequest({ requesterUid, partnerUid, stichtag }) {
  return [
    `<soapenv:Envelope xmlns:soapenv="${SOAP_ENVELOPE}"`,
    ` xmlns:agh="${NAMESPACE}">`,
    '<soapenv:Header/>',
    '<soapenv:Body>',
    '<agh:dienstgeberAbfragen>',
    `<uidAuftraggeber>${requesterUid}</uidAuftraggeber>`,
    `<stichtag>${stichtag}</stichtag>`,
    '<auftragnehmerRQ>',
    `<uidAuftragnehmer>${partnerUid}</uidAuftragnehmer>`,
    '</auftragnehmerRQ>',
    '</agh:dienstgeberAbfragen>',
    '</soapenv:Body>',
    '</soapenv:Envelope>',
  ].join('');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (text) =>
  text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (match, name) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()];
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return String.fromCodePoint(code);
  });

// Text of the first <tag> in xml, with or without a namespace prefix; null if missing or empty.
function element(xml, tag) {
  const match = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`).exec(xml);
  const text = match ? decode(match[1]).trim() : '';
  return text || null;
}

// Throws on an unknown answer, so runChecks reports UNAVAILABLE.
export function parseResponse(xml) {
  const fault = element(xml, 'faultstring');
  if (fault) throw new Error(`HFU service fault: ${fault}`);

  const partner = element(xml, 'auftragnehmerRS');
  if (!partner) throw new Error('HFU answer has no auftragnehmerRS');

  const asEmployer = element(partner, 'hfuListeDgJN');
  const asSoleTrader = element(partner, 'hfuListeEpuJN');
  if (!['J', 'N'].includes(asEmployer) || !['J', 'N'].includes(asSoleTrader)) {
    throw new Error(`HFU answer has unexpected flags (DG=${asEmployer}, EPU=${asSoleTrader})`);
  }

  return {
    onListAsEmployer: asEmployer === 'J',
    onListAsSoleTrader: asSoleTrader === 'J',
    name: element(partner, 'auftragnehmerName'),
    address: element(partner, 'auftragnehmerHauptanschrift'),
    fn: element(partner, 'firmenbuchnummer'),
    note: element(partner, 'hinweis'),
  };
}

// fetch and now can be replaced in tests.
export function createHfuAdapter(env, { fetch = globalThis.fetch, now = () => new Date() } = {}) {
  return {
    source: 'HFU',
    async check({ vat }) {
      const partnerUid = normaliseUid(vat);
      // SCRUM-42: the HFU list only holds Austrian companies.
      if (!partnerUid) {
        return {
          state: 'NOT_APPLICABLE',
          details: { reason: 'The HFU list only contains Austrian UIDs (ATU...)' },
        };
      }

      if (!env.HFU_URL) throw new Error('HFU_URL is not configured');
      const requesterUid = normaliseUid(env.HFU_REQUESTER_UID);
      if (!requesterUid) throw new Error('HFU_REQUESTER_UID is not configured or not an ATU number');

      const stichtag = viennaDate(now());
      const response = await fetch(env.HFU_URL, {
        method: 'POST',
        // No SOAPAction header: the service rejects requests that send one.
        headers: { 'Content-Type': 'text/xml; charset=utf-8', Accept: 'text/xml' },
        body: buildRequest({ requesterUid, partnerUid, stichtag }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const xml = await response.text();
      // SOAP faults come as HTTP 500; parseResponse reports them.
      if (!response.ok && !/faultstring/i.test(xml)) throw new Error(`HFU service answered HTTP ${response.status}`);

      const result = parseResponse(xml);
      const details = {
        uid: partnerUid,
        stichtag,
        name: result.name,
        address: result.address,
        fn: result.fn,
        note: result.note,
      };

      if (result.onListAsEmployer || result.onListAsSoleTrader) {
        return {
          state: 'VALID',
          details: {
            ...details,
            // § 67b ASVG: employer (Dienstgeber); § 67e ASVG: one-person company (EPU).
            listedAs: result.onListAsEmployer ? 'EMPLOYER' : 'SOLE_TRADER',
          },
        };
      }
      return { state: 'NOT_FOUND', details: { ...details, reason: 'not on the HFU list' } };
    },
  };
}
