// SCRUM-16: start a partner check by VAT number (optional FN).

// Takes whatever the user typed and returns either
//   { ok: true, vat: 'ATU12345678' }   (cleaned up)
// or
//   { ok: false, error: 'INVALID_VAT' }
export function validateVat(input) {
  // if input is not a string, return the error
  if (typeof input !== 'string') {
    return { ok: false, error: 'INVALID_VAT' };
  }

  // remove spaces and dots, make it uppercase
  const cleaned = input.replace(/[\s.]/g, '').toUpperCase();

  const re = /^ATU\d{8}$/;

  if (!re.test(cleaned)) {
    return { ok: false, error: 'INVALID_VAT' };   // failed: error
  }

  return { ok: true, vat: cleaned };   // passed everything: success
}
