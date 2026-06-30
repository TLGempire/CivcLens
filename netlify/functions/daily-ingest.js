// netlify/functions/daily-ingest.js
//
// SCHEDULED FUNCTION — runs automatically once a day.
// It fetches the latest federal + Utah bills, generates a summary for any
// NEW bill (skipping ones already in Supabase), and stores everything.
//
// Visitors then read pre-loaded data from Supabase instantly — no live API
// calls and no per-visitor AI cost. This is the "pre-compute at ingestion"
// architecture: summarize once, serve forever.
//
// Schedule is configured in netlify.toml (runs daily at 9am UTC).

exports.handler = async function (event, context) {
  const CONGRESS_API_KEY = process.env.CONGRESS_API_KEY;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  const log = [];
  let newBills = 0;
  let skipped = 0;

  // ── 1. FETCH FEDERAL BILLS ──
  let bills = [];
  if (CONGRESS_API_KEY) {
    try {
      const url = `https://api.congress.gov/v3/bill?format=json&limit=20&sort=updateDate+desc&api_key=${CONGRESS_API_KEY}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        bills.push(...(data.bills || []).map((b) => ({
          id: `${b.type}${b.number}-${b.congress}`,
          level: 'federal',
          number: `${b.type}.${b.number}`,
          chamber: b.originChamber === 'Senate' ? 'U.S. Senate' : 'U.S. House',
          title: b.title || 'Untitled Bill',
          status: b.latestAction?.actionDate ? 'progress' : 'pending',
          status_label: (b.latestAction?.text || 'In Progress').substring(0, 45),
          date: b.latestAction?.actionDate || b.updateDate || '',
          sponsor: b.sponsors?.[0]?.name || 'Unknown sponsor',
        })));
        log.push(`Fetched ${bills.length} federal bills`);
      }
    } catch (e) {
      log.push('Congress fetch error: ' + e.message);
    }
  }

  // ── 2. FETCH UTAH BILLS ──
  try {
    const utahUrl = 'https://glen.le.utah.gov/bills/2026GS/billlist.json';
    const res = await fetch(utahUrl);
    if (res.ok) {
      const data = await res.json();
      const list = data.bills || data || [];
      const utahMapped = list.slice(0, 20).map((b) => {
        const billNum = b.number || b.billno || 'HB000';
        return {
          id: `utah-${billNum}`,
          level: 'state',
          number: billNum,
          chamber: billNum.startsWith('H') ? 'Utah House' : 'Utah Senate',
          title: b.shorttitle || b.title || 'Utah Bill',
          status: 'progress',
          status_label: b.status || 'In Progress',
          date: b.lastactiondate || '',
          sponsor: b.sponsor || 'Utah Legislature',
        };
      });
      bills.push(...utahMapped);
      log.push(`Fetched ${utahMapped.length} Utah bills`);
    }
  } catch (e) {
    log.push('Utah fetch error: ' + e.message);
  }

  // ── 3. FOR EACH BILL: skip if already summarized, else generate + store ──
  for (const bill of bills) {
    // Check if already in Supabase with a summary
    let exists = false;
    try {
      const checkRes = await fetch(
        `${SUPABASE_URL}/rest/v1/bills?id=eq.${encodeURIComponent(bill.id)}&select=id,tldr`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      if (checkRes.ok) {
        const rows = await checkRes.json();
        if (rows.length && rows[0].tldr) exists = true;
      }
    } catch (e) { /* treat as not existing */ }

    if (exists) { skipped++; continue; }

    // Generate summary with Claude
    let summary = null;
    try {
      const prompt = `You are a nonpartisan civic education assistant. Explain this legislation clearly and neutrally.

Bill: ${bill.title}

Respond ONLY with valid JSON (no markdown) in this exact format:
{
  "tldr": "One sentence, plain English, what this bill does. Max 30 words.",
  "summary": "A 2-3 paragraph plain-English summary covering what it does, who it affects, and key numbers.",
  "analysis": "A balanced policy analysis: what supporters say, what critics say, independent context. Strictly nonpartisan.",
  "impactTiles": [
    {"icon":"emoji","label":"SHORT LABEL","value":"key stat","type":"positive|caution|neutral"}
  ]
}
Provide exactly 3 impactTiles showing the most relevant impacts.`;

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1500,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (claudeRes.ok) {
        const cd = await claudeRes.json();
        let raw = cd.content.map((c) => (c.type === 'text' ? c.text : '')).join('').trim();
        raw = raw.replace(/```json|```/g, '').trim();
        summary = JSON.parse(raw);
      }
    } catch (e) {
      log.push(`Summary error for ${bill.id}: ${e.message}`);
      continue;
    }

    if (!summary) continue;

    // Store in Supabase
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/bills`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates',
        },
        body: JSON.stringify({
          id: bill.id,
          level: bill.level,
          number: bill.number,
          chamber: bill.chamber,
          title: bill.title,
          status: bill.status,
          status_label: bill.status_label,
          date: bill.date,
          sponsor: bill.sponsor,
          tldr: summary.tldr,
          summary: summary.summary,
          full_summary: summary.summary,
          analysis: summary.analysis,
          tiles: summary.impactTiles || [],
          updated_at: new Date().toISOString(),
        }),
      });
      newBills++;
    } catch (e) {
      log.push(`Store error for ${bill.id}: ${e.message}`);
    }
  }

  log.push(`Done. ${newBills} new bills summarized, ${skipped} already cached.`);
  console.log(log.join('\n'));

  return {
    statusCode: 200,
    body: JSON.stringify({ newBills, skipped, log }),
  };
};
