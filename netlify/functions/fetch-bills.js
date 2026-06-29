// netlify/functions/fetch-bills.js
//
// Fetches bills from Congress.gov (federal) and the Utah Legislature (state).
// Runs server-side on Netlify, so it solves the CORS problem AND keeps your
// API keys hidden from the browser.
//
// Call from your frontend with:  fetch('/.netlify/functions/fetch-bills')

exports.handler = async function (event, context) {
  // CORS headers so your site can call this function
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const CONGRESS_API_KEY = process.env.CONGRESS_API_KEY;

  let federalBills = [];
  let utahBills = [];

  // ── 1. FETCH FEDERAL BILLS FROM CONGRESS.GOV ──
  if (CONGRESS_API_KEY) {
    try {
      const congressUrl =
        `https://api.congress.gov/v3/bill?format=json&limit=12&sort=updateDate+desc&api_key=${CONGRESS_API_KEY}`;
      const res = await fetch(congressUrl);
      if (res.ok) {
        const data = await res.json();
        federalBills = (data.bills || []).map((b) => ({
          id: `${b.type}${b.number}-${b.congress}`,
          level: 'federal',
          number: `${b.type}.${b.number}`,
          chamber: b.originChamber === 'Senate' ? 'U.S. Senate' : 'U.S. House',
          title: b.title || 'Untitled Bill',
          summary: b.title || 'Summary not yet available.',
          status: b.latestAction?.actionDate ? 'progress' : 'pending',
          statusLabel: (b.latestAction?.text || 'In Progress').substring(0, 45),
          date: b.latestAction?.actionDate || b.updateDate || '',
          sponsor: b.sponsors?.[0]?.name || 'Unknown sponsor',
          congress: b.congress,
          billType: b.type,
          billNumber: b.number,
        }));
      }
    } catch (e) {
      console.error('Congress API error:', e.message);
    }
  }

  // ── 2. FETCH UTAH STATE BILLS ──
  // The Utah Legislature publishes open data. We fetch it server-side here,
  // which avoids the CORS error you saw in the browser.
  try {
    const utahUrl = 'https://glen.le.utah.gov/bills/2026GS/billlist.json';
    const res = await fetch(utahUrl);
    if (res.ok) {
      const data = await res.json();
      const list = data.bills || data || [];
      utahBills = list.slice(0, 15).map((b) => {
        const billNum = b.number || b.billno || 'HB000';
        const chamber = billNum.startsWith('H') ? 'Utah House' : 'Utah Senate';
        return {
          id: `utah-${billNum}`,
          level: 'state',
          state: 'Utah',
          number: billNum,
          chamber,
          title: b.shorttitle || b.title || 'Utah Bill',
          summary: b.shorttitle || b.title || '',
          status: 'progress',
          statusLabel: b.status || 'In Progress',
          date: b.lastactiondate || '',
          sponsor: b.sponsor || 'Utah Legislature',
        };
      });
    }
  } catch (e) {
    console.error('Utah API error:', e.message);
    // utahBills stays empty; frontend will use its demo fallback
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      federal: federalBills,
      utah: utahBills,
      fetchedAt: new Date().toISOString(),
    }),
  };
};
