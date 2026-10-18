import {act, cleanup, render, screen} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {AcknowledgementCountdown, formatRemaining} from '@/components/leadguard/acknowledgement-countdown';

const lead = (over: Partial<Parameters<typeof AcknowledgementCountdown>[0]['lead']> = {}) => ({
  acknowledgedAt: null, assignedTo: 'u1', acknowledgementDeadline: '2026-10-18T10:01:00Z', ...over,
});

describe('AcknowledgementCountdown', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-18T10:00:00Z')); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('shows owner, deadline and remaining time while pending', () => {
    render(<AcknowledgementCountdown lead={lead()} ownerName="Alex Morgan" />);
    expect(screen.getByText('Awaiting acknowledgement')).toBeTruthy();
    expect(screen.getByText(/Owner: Alex Morgan/).textContent).toContain('2026-10-18 10:01:00 UTC');
    expect(screen.getByText(/1:00 left/)).toBeTruthy();
  });

  it('ticks every second and moves through approaching to overdue', () => {
    render(<AcknowledgementCountdown lead={lead()} ownerName="Alex" />);
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(screen.getByText(/0:55 left/)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(screen.getByText('Deadline approaching')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(screen.getByText('Overdue — escalation due')).toBeTruthy();
    expect(screen.queryByText(/left/)).toBeNull();
  });

  it('shows acknowledged and reassigned states without a countdown', () => {
    const {unmount} = render(<AcknowledgementCountdown lead={lead({acknowledgedAt: '2026-10-18T09:59:00Z'})} ownerName="Alex" />);
    expect(screen.getByText('Acknowledged')).toBeTruthy();
    unmount();
    render(<AcknowledgementCountdown lead={lead({assignedTo: 'u2'})} viewedAssignee="u1" ownerName="Sam" />);
    expect(screen.getByText('Reassigned')).toBeTruthy();
  });

  it('stops its timer on unmount', () => {
    const {unmount} = render(<AcknowledgementCountdown lead={lead()} ownerName="Alex" />);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('formats remaining time', () => {
    expect(formatRemaining(0)).toBe('0:00');
    expect(formatRemaining(61)).toBe('1:01');
    expect(formatRemaining(600)).toBe('10:00');
  });
});
