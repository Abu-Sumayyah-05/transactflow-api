// Module 9: the fraud scoring rules.
//
// A pure function: signals in, { score, rulesFired, outcome } out. It reads
// no database and no clock, so every rule and band can be tested exactly,
// and the same inputs always give the same decision (which is what you want
// when someone asks "why was this payment blocked?").
//
//   +20  billing mismatch     billing country != card's issuing country
//                             (a missing billing address can't be checked,
//                             so it counts as a mismatch)
//   +10  free email           gmail, yahoo, outlook/hotmail, icloud, proton, aol
//   +15  new device           this device never completed a payment for the user
//   -30  account > 1 year     long-lived accounts are rarely fraud rings
//   -20  known address        billing address used on an earlier completed payment
//   +80  velocity             card-testing burst caught by the Redis counters
//                             (owner decision: additive, worth a block on its own)
//
// Bands: 0..40 APPROVE (and anything below 0), 41..79 CHALLENGE, 80+ BLOCK.

const RULES = Object.freeze({
  billing_mismatch: 20,
  free_email: 10,
  new_device: 15,
  account_over_1_year: -30,
  known_address: -20,
  velocity: 80,
});

const FREE_EMAIL = /@(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|icloud|me|proton|protonmail|aol)\.[a-z.]+$/i;

// Issuing country from the first digits of the card (the BIN). A real system
// would use a BIN database; this small table covers the demo cards.
const BIN_COUNTRIES = [
  ['5061', 'NG'], ['5078', 'NG'], ['6500', 'NG'], // Verve
  ['4084', 'NG'], ['5399', 'NG'], ['5199', 'NG'],
  ['4111', 'US'], ['4242', 'US'], ['5555', 'US'],
  ['4000', 'GB'], ['5200', 'GB'],
];

function cardCountryOf(pan) {
  const hit = BIN_COUNTRIES.find(([prefix]) => String(pan).startsWith(prefix));
  return hit ? hit[1] : null;
}

const isFreeEmail = (email) => FREE_EMAIL.test(String(email || ''));

function bandOf(score) {
  if (score >= 80) return 'BLOCK';
  if (score >= 41) return 'CHALLENGE';
  return 'APPROVE';
}

function score({ email, billingCountry, cardCountry, deviceSeen, accountAgeDays, knownAddress, velocityBreached, velocityDetail }) {
  const fired = [];
  const fire = (rule, detail) => fired.push({ rule, points: RULES[rule], detail });

  if (!billingCountry) fire('billing_mismatch', 'no billing address given');
  else if (billingCountry !== cardCountry) fire('billing_mismatch', `billing ${billingCountry}, card issued in ${cardCountry ?? 'unknown country'}`);
  if (isFreeEmail(email)) fire('free_email', `email at ${String(email).split('@')[1]}`);
  if (!deviceSeen) fire('new_device', 'device not seen on an earlier completed payment');
  if (accountAgeDays > 365) fire('account_over_1_year', `account is ${Math.floor(accountAgeDays)} days old`);
  if (knownAddress) fire('known_address', 'billing address used before');
  if (velocityBreached) fire('velocity', velocityDetail || 'too many attempts in a short window (card testing)');

  const total = fired.reduce((sum, r) => sum + r.points, 0);
  return { score: total, rulesFired: fired, outcome: bandOf(total) };
}

module.exports = { score, bandOf, isFreeEmail, cardCountryOf, RULES };
