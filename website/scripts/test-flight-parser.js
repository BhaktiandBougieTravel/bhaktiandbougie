// scripts/test-flight-parser.js
// Run: node scripts/test-flight-parser.js
// Pure local test -- no DB, no network, nothing live is touched.

const { parseAirlineEmail } = require('../src/lib/flightEmailParser');

const samples = [
  {
    label: 'REAL Air India schedule change (AI 2908, Nov 13 2025)',
    senderDomain: 'airindia.com',
    subject: 'Schedule changed for AI 2908 to Delhi',
    body: `NEW DEPARTURE TIME 13:25
DATE 13 Nov 25 ORIGIN DED
NEW ARRIVAL TIME 14:17
DATE 13 NOV 2025 DESTINATION DEL
Check the alternative booking options for booking reference 9KFYZS.`
  },
  {
    label: 'Hand-written: Air India flight-number reissue',
    senderDomain: 'airindia.com',
    subject: 'Important update regarding your booking',
    body: `Your flight has been reissued as AI 2909 due to a schedule adjustment. Booking reference: 9KFYZS. New departure time will be confirmed shortly.`
  },
  {
    label: 'Hand-written: Air India cancellation, no rebooking info',
    senderDomain: 'airindia.com',
    subject: 'Flight AI 2908 cancelled',
    body: `We regret to inform you that flight AI 2908 has been cancelled. Please contact us to arrange alternative travel. Booking reference 9KFYZS.`
  },
  {
    label: 'Hand-written: unrelated promo email (should NOT match)',
    senderDomain: 'airindia.com',
    subject: 'Great fares to Delhi this festive season!',
    body: `Book now and save on flights to Delhi. Terms and conditions apply.`
  },
  {
    label: 'Hand-written: unknown airline schedule change (generic fallback)',
    senderDomain: 'goindigo.in',
    subject: 'Schedule change notification',
    body: `Your flight 6E 204 departure time has changed. Please check your booking for details.`
  }
];

for (const s of samples) {
  const result = parseAirlineEmail(s);
  console.log('\n=== ' + s.label + ' ===');
  console.log(JSON.stringify(result, null, 2));
}
