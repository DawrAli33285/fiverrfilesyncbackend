import { supabase } from '../supabase.js';

const SINGLETON_ID = 'schedule-config';

const toIso = (v) => (v ? new Date(v).toISOString() : null);

export async function loadScheduleConfig() {
  const { data, error } = await supabase
    .from('schedule_config')
    .select('*')
    .eq('id', SINGLETON_ID)
    .single();

  if (error) throw error;

  return {
    enabled: data.enabled,
    intervalMinutes: data.interval_minutes,
    nextRunAt: toIso(data.next_run_at),
    lastRunAt: toIso(data.last_run_at),
  };
}

export async function saveScheduleConfig(partialSchedule) {
  const row = { id: SINGLETON_ID };

  if ('enabled' in partialSchedule) row.enabled = partialSchedule.enabled;
  if ('intervalMinutes' in partialSchedule) row.interval_minutes = partialSchedule.intervalMinutes;
  if ('nextRunAt' in partialSchedule) row.next_run_at = toIso(partialSchedule.nextRunAt);
  if ('lastRunAt' in partialSchedule) row.last_run_at = toIso(partialSchedule.lastRunAt);

  const { error } = await supabase
    .from('schedule_config')
    .upsert(row, { onConflict: 'id' });

  if (error) throw error;
}