import { randomUUID } from 'node:crypto';

/** Keep a selected account leased until execution and cancellation cleanup finish. */
export function keepAccountReservation(accounts, selection, attempt) {
  const controller = new AbortController();
  const reservationId = selection.reservation?.id;
  const renewalId = randomUUID();
  let tick = 0;
  let stopped = false;
  let renewalTimer;
  let expiryTimer;

  function lost() {
    if (stopped || controller.signal.aborted) return;
    clearTimeout(renewalTimer);
    clearTimeout(expiryTimer);
    const error = new Error('Account reservation lost: renewal could not be confirmed. The assignment was stopped; retry with backoff.');
    error.code = 'ACCOUNT_RESERVATION_LOST';
    controller.abort(error);
  }

  function schedule(reservation) {
    const remaining = Date.parse(reservation?.expiresAt) - Date.now();
    if (reservation?.id !== reservationId || !Number.isFinite(remaining) || remaining <= 0) return lost();
    clearTimeout(expiryTimer);
    // Leave the last quarter of the confirmed lease for interrupt cleanup.
    expiryTimer = setTimeout(lost, Math.max(1, Math.floor(remaining * 3 / 4)));
    renewalTimer = setTimeout(renew, Math.max(1, Math.floor(remaining / 2)));
  }

  async function renew() {
    try {
      const reservation = await accounts.renewReservation({ ...attempt, reservationId, idempotencyKey: `renew:${renewalId}:${++tick}` });
      if (!stopped && !controller.signal.aborted) schedule(reservation);
    } catch { lost(); }
  }

  if (!reservationId) lost();
  else schedule(selection.reservation);

  return {
    signal: controller.signal,
    stop() { stopped = true; clearTimeout(renewalTimer); clearTimeout(expiryTimer); },
  };
}
