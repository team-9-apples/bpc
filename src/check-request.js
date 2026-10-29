// SCRUM-16: start a partner check by VAT number (optional FN).

// One regex per EU country, keyed by the 2-letter prefix.
const VAT_FORMATS = {
  AT: /^ATU\d{8}$/,   // ATU + 8 digits
  DE: /^DE\d{9}$/,    // DE + 9 digits
  // more countries later
};


// Takes whatever the user typed and returns either: { ok: true, vat: 'ATU12345678' }   (cleaned up) or, { ok: false, error: 'INVALID_VAT' }
export function validateVat(input) {
  // if input is not a string, return the error
  if (typeof input !== 'string') {
    return { ok: false, error: 'INVALID_VAT' };
  }

  // remove spaces and dots, make it uppercase
  const cleaned = input.replace(/[\s.]/g, '').toUpperCase();

  // the first two letters are the country
  const country = cleaned.slice(0, 2)

  // look up the regex for that country
  const re = VAT_FORMATS[country]

  // unknown country -> error
  if (!re) {
    return { ok: false, error: 'INVALID_VAT'}
  }

  // wrong format for that country -> error
  if (!re.test(cleaned)) {
    return { ok: false, error: 'INVALID_VAT' };
  }

  return { ok: true, vat: cleaned };   // passed everything: success
}

// The FN is optional. Returns { ok: true, fn: '123456a' }, { ok: true, fn: null } when nothing was entered, or { ok: false, error: 'INVALID_FN' }.
export function validateFn(input) {
  // nothing entered -> fine, no FN
  if (input === undefined || input === null || input === '') {
    return { ok: true, fn: null };
  }

  // not text -> error
  if (typeof input !== 'string') {
    return { ok: false, error: 'INVALID_FN' };
  }

  // remove spaces, make lowercase (the check letter is lowercase)
  const cleaned = input.replace(/\s/g, '').toLowerCase();

  // 1 to 6 digits, then one letter
  if (!/^\d{1,6}[a-z]$/.test(cleaned)) {
    return { ok: false, error: 'INVALID_FN' };
  }

  return { ok: true, fn: cleaned };
}