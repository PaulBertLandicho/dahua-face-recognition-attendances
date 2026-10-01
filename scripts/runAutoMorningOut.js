// One-off runner to invoke autoGenerateMorningOut logic against your Supabase
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.REACT_APP_SUPABASE_URL;
const supabaseAnonKey = process.env.REACT_APP_SUPABASE_ANON_KEY;
const supabaseServiceRole = process.env.SUPABASE_SERVICE_ROLE_KEY; // optional, required for writes when RLS is enabled
if (!supabaseUrl || !supabaseAnonKey) {
  console.error('Missing REACT_APP_SUPABASE_URL or REACT_APP_SUPABASE_ANON_KEY in environment.');
  process.exit(1);
}

// Prefer service role key for server-side scripts if provided (service role bypasses RLS).
const clientKey = supabaseServiceRole || supabaseAnonKey;
if (supabaseServiceRole) {
  console.log('Using SUPABASE_SERVICE_ROLE_KEY for Supabase client (server write operations will be allowed).');
} else {
  console.warn('SUPABASE_SERVICE_ROLE_KEY not provided; using anon key. Writes may fail if Row Level Security (RLS) is enabled.');
}

const supabase = createClient(supabaseUrl, clientKey);

function toMinutes(currentTime) {
  const [hours, minutes] = currentTime.split(':').map(Number);
  return hours * 60 + minutes;
}

async function run() {
  try {
    const { data: settings, error: settingsErr } = await supabase
      .from('settings')
      .select('*')
      .eq('id', 1)
      .maybeSingle();
    if (settingsErr) throw settingsErr;
    if (!settings) {
      console.warn('No settings row found (settings is null). Attempting to create default settings.');
      const defaultSettings = {
        id: 1,
        morning_start: '08:00',
        morning_end: '11:59',
        afternoon_start: '12:00',
        afternoon_end: '17:00',
        late_count_limit: 5
      };
      const { data: inserted, error: insertErr } = await supabase.from('settings').insert(defaultSettings).select().maybeSingle();
      if (insertErr) {
        console.error('Failed to insert default settings:', insertErr);
        process.exit(2);
      }
      if (!inserted) {
        console.error('Default settings insert returned no row. Aborting.');
        process.exit(3);
      }
      console.log('Inserted default settings:', inserted);
      settings = inserted;
    }

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');

    const outHHMM = settings.morning_end || '11:59';
    const [oh, om] = outHHMM.split(':').map(Number);
    const outDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), oh, om, 0, 0);
    const outIso = outDate.toISOString();

    const dayStartIso = `${year}-${month}-${day}T00:00:00.000Z`;
    const dayEndIso = `${year}-${month}-${day}T23:59:59.999Z`;

    console.log('Using morning_end:', outHHMM, 'outIso:', outIso);

    const { data: persons, error: personsErr } = await supabase.from('persons').select('id, name, department');
    if (personsErr) throw personsErr;

    if (!Array.isArray(persons) || persons.length === 0) {
      console.log('No persons found in the database. Exiting.');
      console.log('Auto morning-out results: []');
      process.exit(0);
    }

    console.log('Persons found:', persons.length);
    const results = [];

    for (const p of persons || []) {
      console.log('\nChecking person:', p.id, p.name || '(no name)');
      try {
        const { data: att, error: attErr } = await supabase
          .from('attendance')
          .select('id,event,device_time,photo')
          .eq('person_id', p.id)
          .gte('device_time', dayStartIso)
          .lte('device_time', dayEndIso)
          .order('device_time', { ascending: true });
        if (attErr) {
          console.warn('read attendance failed for', p.id, attErr.message || attErr);
          continue;
        }
        console.log('  attendance rows fetched:', Array.isArray(att) ? att.length : 0);

        const morningStartMin = toMinutes(settings.morning_start);
        const morningEndMin = toMinutes(settings.morning_end);
        let morningInRow = null;
        let hasMorningOut = false;
        if (Array.isArray(att)) {
          for (const r of att) {
            if (!r || !r.device_time) continue;
            const dt = new Date(r.device_time);
            const hhmm = dt.toTimeString().slice(0,5);
            const minutes = toMinutes(hhmm);
            if (r.event === 'time-in' && minutes <= morningEndMin) {
              if (!morningInRow) morningInRow = r;
            }
            if (r.event === 'time-out' && morningInRow) {
              const dtOut = new Date(r.device_time);
              if (dtOut.getTime() >= new Date(morningInRow.device_time).getTime()) {
                hasMorningOut = true;
              }
            }
          }
        }

        if (morningInRow && !hasMorningOut) {
          console.log('  morning time-in found at', morningInRow.device_time, 'no morning time-out present');
          const DUPLICATE_WINDOW_MS = 30 * 1000;
          const dupWindowIso = new Date(outDate.getTime() - DUPLICATE_WINDOW_MS).toISOString();
          const { data: recentDup } = await supabase
            .from('attendance')
            .select('id')
            .eq('person_id', p.id)
            .eq('event', 'time-out')
            .gte('device_time', dupWindowIso)
            .order('device_time', { ascending: false })
            .limit(1);
          if (Array.isArray(recentDup) && recentDup.length > 0) {
            results.push({ person_id: p.id, inserted: false, reason: 'recent duplicate' });
            continue;
          }

          // compute status: overtime if after afternoon_end
          const currentTime = outDate.toTimeString().slice(0,5);
          const afternoonEnd = toMinutes(settings.afternoon_end);
          const status = toMinutes(currentTime) > afternoonEnd ? 'overtime' : 'on-time';

          const insertPayload = {
            person_id: p.id,
            name: p.name,
            department: p.department,
            event: 'time-out',
            method: 'auto-morning-out',
            device_time: outIso,
            status,
            photo: morningInRow.photo || null,
          };
          const { data: insData, error: insErr } = await supabase.from('attendance').insert(insertPayload).select().maybeSingle();
          if (insErr) {
            console.warn('  insert failed for', p.id, insErr.message || insErr);
            results.push({ person_id: p.id, inserted: false, reason: insErr.message, error: insErr });
          } else {
            console.log('  inserted attendance id:', insData && insData.id ? insData.id : '(unknown)');
            results.push({ person_id: p.id, inserted: true, insertedRow: insData });
          }
        }
      } catch (e) {
        console.error('error for person', p.id, e.message || e);
      }
    }

    console.log('Auto morning-out results:', results);
    process.exit(0);
  } catch (e) {
    console.error('Runner failed', e.message || e);
    process.exit(2);
  }
}

run();
