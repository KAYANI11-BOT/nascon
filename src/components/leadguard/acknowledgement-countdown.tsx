import {useEffect, useState} from 'react';
import {Clock} from 'lucide-react';
import {countdownState, type CountdownState} from '@/lib/lead-engine';
import type {Lead} from '@/types/leads';

const LABEL: Record<CountdownState, string> = {
  pending: 'Awaiting acknowledgement',
  approaching: 'Deadline approaching',
  overdue: 'Overdue — escalation due',
  acknowledged: 'Acknowledged',
  reassigned: 'Reassigned',
};

export function formatRemaining(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Display only. The database deadline is the source of truth; escalation never runs from here. */
export function AcknowledgementCountdown({
  lead,
  ownerName,
  viewedAssignee = null,
  now: nowOverride,
}: {
  lead: Pick<Lead, 'acknowledgedAt' | 'acknowledgementDeadline' | 'assignedTo'>;
  ownerName: string;
  viewedAssignee?: string | null;
  now?: Date;
}) {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (nowOverride) return;
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [nowOverride]);

  const {state, remainingSeconds} = countdownState(lead, nowOverride ?? new Date(tick), viewedAssignee);
  return (
    <div className="flex items-center gap-3" data-state={state} role="timer" aria-live="off">
      <Clock size={16} />
      <div>
        <strong>{LABEL[state]}</strong>
        <span className="table-subtext">
          Owner: {ownerName}
          {lead.acknowledgementDeadline ? ` · Deadline ${lead.acknowledgementDeadline.replace('T', ' ').replace(/\.\d+Z$|Z$/, ' UTC')}` : ''}
          {remainingSeconds !== null && state !== 'overdue' ? ` · ${formatRemaining(remainingSeconds)} left` : ''}
        </span>
      </div>
    </div>
  );
}
