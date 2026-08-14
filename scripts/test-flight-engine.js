// scripts/test-flight-engine.js
// Run: node scripts/test-flight-engine.js
// Uses the real database via the app's pool, but only ever touches:
//   - the flight row with booking_ref = 'ZZTEST1' (the TESTFLIGHT trip)
//   - flight_change_alerts rows
// dryRun is hard-coded true below. This script CANNOT write to the flights table.

const pool = require('../src/db/pool');
const { processFlightEmail } = require('../src/lib/flightAlertEngine');

const scenarios = [
  {
    label: 'Unambiguous time change (eligible, but dry-run blocks the write)',
    sourceEmailId: 'TEST-1-' + Date.now(),
    parsedEmail: {
      airline: 'Air India', flightNumber: 'AI 2908', bookingRef: 'ZZTEST1',
      emailType: 'schedule_change', newDepartureDate: '2026-09-15', newDepartureTime: '15:00',
      newArrivalDate: '2026-09-15', newArrivalTime: '15:52', confidence: 'high'
    }
  },
  {
    label: 'Flight number change (should always queue)',
    sourceEmailId: 'TEST-2-' + Date.now(),
    parsedEmail: {
      airline: 'Air India', flightNumber: 'AI 2999', bookingRef: 'ZZTEST1',
      emailType: 'schedule_change', newDepartureDate: '2026-09-15', newDepartureTime: '15:00',
      newArrivalDate: '2026-09-15', newArrivalTime: '15:52', confidence: 'high'
    }
  },
  {
    label: 'Cancellation (should always queue)',
    sourceEmailId: 'TEST-3-' + Date.now(),
    parsedEmail: {
      airline: 'Air India', flightNumber: 'AI 2908', bookingRef: 'ZZTEST1',
      emailType: 'cancellation', newDepartureDate: null, newDepartureTime: null,
      newArrivalDate: null, newArrivalTime: null, confidence: 'low'
    }
  },
  {
    label: 'No matching booking ref in the system (should queue)',
    sourceEmailId: 'TEST-4-' + Date.now(),
    parsedEmail: {
      airline: 'Air India', flightNumber: 'AI 1234', bookingRef: 'ZZNOPE1',
      emailType: 'schedule_change', newDepartureDate: '2026-09-15', newDepartureTime: '15:00',
      newArrivalDate: '2026-09-15', newArrivalTime: '15:52', confidence: 'high'
    }
  }
];

(async () => {
  for (const s of scenarios) {
    const result = await processFlightEmail({
      parsedEmail: s.parsedEmail,
      sourceEmailId: s.sourceEmailId,
      mailbox: 'test-script',
      pool,
      dryRun: true
    });
    console.log('\n=== ' + s.label + ' ===');
    console.log(JSON.stringify(result, null, 2));
  }
  process.exit(0);
})();
